import {
  fetchContractSource,
  fetchDefiYieldContext,
  fetchStablecoinPeg,
  fetchTokenSafety,
  scanSolidity,
  UPSTREAM_COSTS_USD
} from './buyClient.js';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const CHAINS = new Set(['celo', 'base', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'bsc', 'gnosis']);
// Agent402 documents a 512 KB source-field limit, while its gateway measures the
// complete JSON body. Keep room for JSON escaping and framing so a scan is never
// sent only to be rejected with a 413 response.
const SOLIDITY_SCAN_MAX_REQUEST_BYTES = 480 * 1024;
const DEFAULT_UPSTREAM_BUDGET_USD = 0.05;

export class ValidationError extends Error {
  constructor(message) { super(message); this.code = 'INVALID_REQUEST'; }
}

export async function createSafetyReport(raw = {}, options = {}) {
  const input = validateSafetyReportInput(raw);
  const evidence = options.liveUpstreams ? await liveEvidence(input, options) : unavailableEvidence();
  return score(input, evidence, options.liveUpstreams ? 'partial-live' : 'unconfigured', options);
}

export function validateSafetyReportInput(raw = {}) {
  const chain = String(raw.chain || 'celo').toLowerCase();
  if (!CHAINS.has(chain)) throw new ValidationError(`Unsupported chain. Use: ${[...CHAINS].join(', ')}.`);
  const poolAddress = String(raw.poolAddress || raw.pool || raw.address || '').trim();
  if (!ADDRESS.test(poolAddress || '')) throw new ValidationError('poolAddress must be a valid 0x EVM address.');
  const tokenAddress = String(raw.tokenAddress || raw.token || '').trim() || null;
  if (tokenAddress && !ADDRESS.test(tokenAddress)) throw new ValidationError('tokenAddress must be a valid 0x EVM address.');
  const stablecoin = String(raw.stablecoin || 'USDC').toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(stablecoin)) throw new ValidationError('stablecoin must be a ticker such as USDC.');
  return { chain, poolAddress, tokenAddress, stablecoin, poolName: String(raw.poolName || 'Unspecified pool').slice(0, 100) };
}

function unavailableEvidence() {
  return {
    yield: {
      source: 'Agent402 /api/defi-yields',
      observed: false,
      apy: null,
      tvlUsd: null,
      marketContext: null,
      unknown: true,
      error: 'Live upstream checks are disabled.'
    },
    peg: { source: 'Agent402 /api/stablecoin-peg', status: 'unknown', deviationBps: null, unknown: true, error: 'Live upstream checks are disabled.' },
    token: { source: 'Agent402 /api/token-safety', verdict: 'unknown', blocking: [], warnings: [], unknown: ['Live upstream checks are disabled.'] },
    contract: { source: 'Agent402 /api/contract-source + /api/solidity-scan', verified: null, findings: [], unknown: true, error: 'Live upstream checks are disabled.' }
  };
}

async function liveEvidence(input, options) {
  const maxUpstreamUsd = options.maxUpstreamUsd ?? DEFAULT_UPSTREAM_BUDGET_USD;
  if (!Number.isFinite(maxUpstreamUsd) || maxUpstreamUsd < UPSTREAM_COSTS_USD.peg) {
    throw new ValidationError('UPSTREAM_MAX_USD must allow the $0.003 stablecoin-peg request.');
  }
  let remainingMicros = Math.floor(maxUpstreamUsd * 1_000_000 + 1e-6);
  const adapters = options.adapters || {
    fetchStablecoinPeg,
    fetchDefiYieldContext,
    fetchTokenSafety,
    fetchContractSource,
    scanSolidity
  };
  const call = async (cost, invoke) => {
    const costMicros = Math.round(cost * 1_000_000);
    if (remainingMicros < costMicros) {
      return { error: `Not requested: the remaining upstream budget is below the $${cost.toFixed(3)} route cap.` };
    }
    remainingMicros -= costMicros;
    try {
      return { data: await invoke({ ...options, maxUpstreamUsd: cost }) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
  const timestamp = new Date().toISOString();

  const [pegResult, yieldResult] = await Promise.all([
    call(UPSTREAM_COSTS_USD.peg, callOptions => adapters.fetchStablecoinPeg(input.stablecoin, callOptions)),
    call(UPSTREAM_COSTS_USD.yieldContext, callOptions => adapters.fetchDefiYieldContext(input.chain, input.stablecoin, callOptions))
  ]);
  const tokenResult = input.tokenAddress
    ? await call(UPSTREAM_COSTS_USD.tokenSafety, callOptions => adapters.fetchTokenSafety(input.chain, input.tokenAddress, callOptions))
    : { error: 'Not requested: provide the underlying token contract separately from the pool contract.' };
  const contractResult = await call(
    UPSTREAM_COSTS_USD.contractSource,
    callOptions => adapters.fetchContractSource(input.chain, input.poolAddress, callOptions)
  );

  let contract = {
    source: 'Agent402 /api/contract-source + /api/solidity-scan',
    address: input.poolAddress,
    verified: null,
    compiler: null,
    findings: [],
    scan: null,
    unknown: true,
    timestamp
  };
  if (contractResult.data && typeof contractResult.data.verified === 'boolean') {
    const sourceResponse = contractResult.data;
    const returnedAddress = sourceResponse.address;
    if (returnedAddress && returnedAddress.toLowerCase() !== input.poolAddress.toLowerCase()) {
      contract.error = 'Agent402 returned source for a different contract address.';
    } else if (sourceResponse.verified === false) {
      contract = {
        ...contract,
        verified: false,
        sourceCount: Number.isFinite(sourceResponse.sourceCount) ? sourceResponse.sourceCount : 0,
        compiler: sourceResponse.compiler || null,
        unknown: false
      };
    } else {
      const source = extractVerifiedSource(sourceResponse.sources);
      if (!source) {
        contract = { ...contract, verified: true, compiler: sourceResponse.compiler || null, error: 'Verified source text was not present in the provider response.' };
      } else if (Buffer.byteLength(JSON.stringify({ source }), 'utf8') > SOLIDITY_SCAN_MAX_REQUEST_BYTES) {
        contract = { ...contract, verified: true, compiler: sourceResponse.compiler || null, error: 'Verified source is too large for the provider static scan request; no Solidity scan was sent.' };
      } else {
        const scanResult = await call(
          UPSTREAM_COSTS_USD.solidityScan,
          callOptions => adapters.scanSolidity(source, callOptions)
        );
        if (scanResult.data && Array.isArray(scanResult.data.findings)) {
          contract = {
            ...contract,
            verified: true,
            compiler: sourceResponse.compiler || null,
            sourceCount: Number.isFinite(sourceResponse.sourceCount) ? sourceResponse.sourceCount : Object.keys(sourceResponse.sources || {}).length,
            findings: scanResult.data.findings,
            scan: { lines: scanResult.data.lines ?? null, summary: scanResult.data.summary ?? null, disclaimer: scanResult.data.disclaimer ?? null },
            unknown: false
          };
        } else {
          contract = {
            ...contract,
            verified: true,
            compiler: sourceResponse.compiler || null,
            error: scanResult.error || 'Agent402 returned an invalid Solidity scan result.'
          };
        }
      }
    }
  } else if (contractResult.error) {
    contract.error = contractResult.error;
  } else {
    contract.error = 'Agent402 returned an invalid contract-source result.';
  }

  const token = normalizeTokenEvidence(tokenResult, input, timestamp);
  const peg = normalizePegEvidence(pegResult, timestamp);
  const marketContext = yieldResult.data && Array.isArray(yieldResult.data.pools)
    ? {
      observed: true,
      scope: 'market-context-only',
      source: yieldResult.data.source || 'Agent402 /api/defi-yields',
      fetchedAt: yieldResult.data.fetchedAt || timestamp,
      pools: yieldResult.data.pools.slice(0, 5)
    }
    : null;
  const yieldError = yieldResult.error || (!marketContext ? 'Agent402 returned no usable market-context rows.' : undefined);

  return {
    yield: {
      source: 'Agent402 /api/defi-yields',
      observed: false,
      apy: null,
      tvlUsd: null,
      marketContext,
      timestamp,
      unknown: true,
      ...(yieldError ? { error: yieldError } : {})
    },
    peg,
    token,
    contract,
    upstreamBudget: {
      configuredUsd: maxUpstreamUsd,
      reservedCapUsd: Math.round((Math.floor(maxUpstreamUsd * 1_000_000 + 1e-6) - remainingMicros) / 1_000_000 * 1_000_000) / 1_000_000,
      remainingUsd: remainingMicros / 1_000_000
    }
  };
}

function normalizePegEvidence(result, timestamp) {
  const data = result.data;
  const knownStatus = data && ['on-peg', 'depegged'].includes(data.status);
  if (!knownStatus || !Number.isFinite(data.deviationBps) || !Number.isFinite(data.price)) {
    return {
      source: 'Agent402 /api/stablecoin-peg',
      status: 'unknown',
      deviationBps: null,
      price: null,
      unknown: true,
      error: result.error || 'Agent402 returned an invalid stablecoin-peg result.',
      timestamp
    };
  }
  return {
    source: 'Agent402 /api/stablecoin-peg',
    ...data,
    live: true,
    unknown: false,
    timestamp
  };
}

function normalizeTokenEvidence(result, input, timestamp) {
  const data = result.data;
  if (!input.tokenAddress || !data || typeof data !== 'object') {
    return {
      source: 'Agent402 /api/token-safety',
      address: input.tokenAddress,
      verdict: 'unknown',
      blocking: [],
      warnings: [],
      unknown: [result.error || 'Agent402 returned no token-safety result.'],
      requested: Boolean(input.tokenAddress),
      timestamp
    };
  }
  if (data.address && (typeof data.address !== 'string' || data.address.toLowerCase() !== input.tokenAddress.toLowerCase())) {
    return {
      source: 'Agent402 /api/token-safety',
      address: input.tokenAddress,
      verdict: 'unknown',
      blocking: [],
      warnings: [],
      unknown: ['Agent402 returned a result for a different token address.'],
      requested: true,
      timestamp
    };
  }
  const verdict = normalizeVerdict(data.verdict);
  const providerUnknown = [...toTextList(data.unknown), ...toTextList(data.because)];
  const unresolved = verdict === 'unknown'
    ? providerUnknown.length ? providerUnknown : [`Provider verdict "${String(data.verdict ?? 'missing')}" was not recognized.`]
    : providerUnknown;
  return {
    source: 'Agent402 /api/token-safety',
    address: input.tokenAddress,
    verdict,
    providerVerdict: data.verdict ?? null,
    blocking: toTextList(data.blocking),
    warnings: toTextList(data.warnings),
    unknown: unresolved,
    requested: true,
    facts: data.facts ?? null,
    live: verdict !== 'unknown',
    timestamp
  };
}

function normalizeVerdict(value) {
  const verdict = String(value || '').trim().toLowerCase().replaceAll('_', '-');
  if (['unsafe', 'high', 'high-risk', 'danger', 'malicious', 'blocked'].includes(verdict)) return 'unsafe';
  if (['caution', 'warning', 'medium', 'medium-risk', 'moderate', 'suspicious'].includes(verdict)) return 'caution';
  if (['ok', 'safe', 'low', 'low-risk', 'clear', 'clean'].includes(verdict)) return 'ok';
  return 'unknown';
}

function toTextList(value) {
  if (typeof value === 'string' && value.trim()) return [value];
  if (!Array.isArray(value)) return [];
  return value.map(item => typeof item === 'string' ? item : item?.message || item?.name || JSON.stringify(item));
}

function extractVerifiedSource(sources) {
  if (!sources || typeof sources !== 'object') return '';
  return Object.values(sources)
    .map(item => typeof item === 'string' ? item : item?.content || item?.source || '')
    .filter(value => typeof value === 'string' && value.trim())
    .join('\n');
}

function score(input, evidence, mode, options) {
  const yieldKnown = evidence.yield.observed && Number.isFinite(evidence.yield.apy);
  const pegKnown = ['on-peg', 'depegged'].includes(evidence.peg.status) && Number.isFinite(evidence.peg.deviationBps);
  const tokenKnown = evidence.token.verdict !== 'unknown';
  const contractKnown = evidence.contract.unknown !== true;
  const liquidityKnown = Number.isFinite(evidence.yield.tvlUsd);
  const checks = [
    check('yieldSustainability', 10, yieldKnown ? evidence.yield.apy > 50 ? 8 : 2 : null, evidence.yield),
    check('stablecoinPeg', 20, pegKnown ? evidence.peg.status === 'depegged' ? 20 : Math.min(8, Math.abs(evidence.peg.deviationBps) / 10) : null, evidence.peg),
    check('tokenSafety', 25, tokenKnown ? evidence.token.verdict === 'unsafe' ? 25 : evidence.token.verdict === 'caution' ? 13 : 1 : null, evidence.token),
    check('contractRisk', 30, contractKnown ? !evidence.contract.verified ? 25 : evidence.contract.findings.some(x => x.severity === 'high') ? 22 : evidence.contract.findings.length * 5 : null, evidence.contract),
    check('liquidity', 15, liquidityKnown ? evidence.yield.tvlUsd < 100000 ? 12 : evidence.yield.tvlUsd < 500000 ? 6 : 2 : null, { tvlUsd: evidence.yield.tvlUsd, timestamp: evidence.yield.timestamp })
  ];
  const observedChecks = checks.filter(item => item.risk !== null).length;
  const complete = observedChecks === checks.length;
  let riskScore = complete ? Math.round(checks.reduce((total, item) => total + item.risk, 0)) : null;
  const severe = evidence.peg.status === 'depegged' || evidence.token.verdict === 'unsafe' || (contractKnown && evidence.contract.verified === false);
  if (severe && complete) riskScore = Math.max(riskScore, 60);
  const level = riskScore === null ? severe ? 'high' : 'unassessed' : riskScore >= 80 ? 'critical' : riskScore >= 60 ? 'high' : riskScore >= 40 ? 'elevated' : riskScore >= 20 ? 'moderate' : 'lower-observed-risk';
  const action = severe ? 'avoid-by-default' : riskScore === null ? 'insufficient-evidence' : riskScore >= 60 ? 'avoid-by-default' : riskScore >= 40 ? 'manual-review-required' : 'review-before-deposit';
  const budget = options.maxUpstreamUsd ?? DEFAULT_UPSTREAM_BUDGET_USD;
  return {
    reportVersion: '1.0',
    mode,
    generatedAt: new Date().toISOString(),
    input,
    riskScore,
    level,
    evidenceCoverage: { observed: observedChecks, total: checks.length },
    action,
    confidence: complete ? 'limited' : 'insufficient-evidence',
    severeOverrideApplied: severe,
    checks,
    evidence,
    limitations: [
      'Risk intelligence only; not an audit, investment advice, or a guarantee of safety.',
      'Missing or unknown evidence is never treated as clean.',
      mode === 'unconfigured'
        ? 'Live evidence is not configured; no simulated results are provided.'
        : 'Yield screener results are market context, not verified APY or TVL for the submitted pool. Pool-specific yield and liquidity remain unresolved unless independently matched to that exact pool.'
    ],
    payment: {
      sellerPriceUsd: String(options.sellerPriceUsd || '0.07'),
      upstreamBudgetUsd: budget.toFixed(6).replace(/0+$/, '').replace(/\.$/, ''),
      network: 'celo',
      currency: 'USDC'
    }
  };
}

function check(id, weight, risk, evidence) {
  return { id, weight, risk: risk === null ? null : Math.round(risk * 10) / 10, evidence };
}
