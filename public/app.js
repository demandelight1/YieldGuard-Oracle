import { connectWallet, disconnectWallet, payForReport, validatePoolAddress } from './payment.js';

const form = document.querySelector('#scan');
const get = id => document.querySelector(`#${id}`);
let paymentConfig;
let connectedAccount;

function setConnectedAccount(account) {
  connectedAccount = account || undefined;
  const connectButton = get('walletButton');
  const disconnectButton = get('walletDisconnectButton');
  connectButton.textContent = connectedAccount ? `${connectedAccount.slice(0, 6)}…${connectedAccount.slice(-4)}` : 'Connect MetaMask';
  connectButton.disabled = Boolean(connectedAccount);
  disconnectButton.hidden = !connectedAccount;
}

async function getPaymentConfig() {
  if (!paymentConfig) {
    const response = await fetch('/api/payment-config');
    const config = await response.json();
    if (!response.ok) throw new Error(config.error || 'Could not load payment configuration.');
    if (typeof config.paymentRequired !== 'boolean') throw new Error('Server returned an invalid payment configuration.');
    paymentConfig = config;
  }
  return paymentConfig;
}

getPaymentConfig().then(config => {
  if (config.paymentRequired) form.querySelector('button').innerHTML = `Pay $${config.priceUsdc} &amp; scan <span>↗</span>`;
}).catch(error => { get('updated').textContent = `Payment configuration unavailable: ${error.message}`; });

get('walletButton').addEventListener('click', async () => {
  const button = get('walletButton');
  button.disabled = true;
  try {
    const { account } = await connectWallet();
    setConnectedAccount(account);
    get('updated').textContent = 'Wallet connected on Celo';
  } catch (error) {
    get('updated').textContent = `Wallet connection failed: ${error.message}`;
  } finally {
    button.disabled = Boolean(connectedAccount);
  }
});

get('walletDisconnectButton').addEventListener('click', async () => {
  const button = get('walletDisconnectButton');
  button.disabled = true;
  try {
    const permissionRevoked = await disconnectWallet();
    if (permissionRevoked) {
      setConnectedAccount();
      get('updated').textContent = 'Wallet disconnected. Connect again to approve this site.';
    } else {
      get('updated').textContent = 'Wallet is still authorized for this site. Revoke its site access in your wallet to disconnect.';
    }
  } catch (error) {
    get('updated').textContent = `Could not disconnect wallet: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', accounts => {
    setConnectedAccount(Array.isArray(accounts) ? accounts[0] : undefined);
  });
}

if (window.ethereum) {
  window.ethereum.request({ method: 'eth_accounts' })
    .then(accounts => setConnectedAccount(Array.isArray(accounts) ? accounts[0] : undefined))
    .catch(error => {
      if (isNoWalletAccountError(error)) {
        setConnectedAccount();
        return;
      }
      get('updated').textContent = `Could not check wallet connection: ${error.message}`;
    });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  button.textContent = 'Preparing…';
  try {
    const request = Object.fromEntries(new FormData(form));
    request.poolAddress = validatePoolAddress(request.poolAddress);
    request.tokenAddress = validatePoolAddress(request.tokenAddress, 'token');
    const config = await getPaymentConfig();
    if (config.paymentRequired && !config.liveUpstreams) {
      throw new Error('Live upstream checks are disabled; no payment was sent.');
    }
    if (config.paymentRequired && !config.upstreamBudgetReady) {
      throw new Error('The upstream budget is too low for a complete paid scan; no payment was sent.');
    }
    let paymentId;
    if (config.paymentRequired) {
      const verified = await payForReport(config, status => { get('updated').textContent = status; });
      paymentId = verified.paymentId;
      setConnectedAccount(verified.account);
      get('updated').textContent = `Payment verified · ${verified.transactionHash.slice(0, 10)}…`;
    }
    const response = await fetch('/api/composite/yield-safety-score', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...request, ...(paymentId ? { paymentId } : {}) }) });
    const report = await response.json();
    if (!response.ok) throw new Error(report.error);
    render(report);
  } catch (error) {
    get('updated').textContent = `Scan failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.innerHTML = 'Run safety scan <span>↗</span>';
  }
});

function render(report) {
  const assessed = Number.isFinite(report.riskScore);
  const high = report.severeOverrideApplied || (assessed && report.riskScore >= 60);
  const medium = !assessed || report.riskScore >= 20;
  const { peg, yield: yieldEvidence, token, contract } = report.evidence;
  get('score').textContent = assessed ? String(report.riskScore).padStart(2, '0') : '—';
  get('scoreRing').textContent = assessed ? report.riskScore : '—';
  get('mode').textContent = report.mode.replaceAll('-', ' ').toUpperCase();
  get('decision').textContent = report.action.replaceAll('-', ' ');
  get('decision').className = `decision ${high ? 'danger' : medium ? 'warning' : 'positive'}`;
  get('updated').textContent = `Updated ${new Date(report.generatedAt).toLocaleTimeString()}`;
  get('pegPrice').textContent = peg.price != null && Number.isFinite(Number(peg.price)) ? `$${Number(peg.price).toFixed(4)}` : 'Unknown';
  get('pegDeviation').textContent = Number.isFinite(peg.deviationBps) ? `${peg.deviationBps > 0 ? '+' : ''}${peg.deviationBps} bps` : 'Unknown';
  badge('pegState', peg.status, peg.status === 'on-peg');
  get('pegDetail').textContent = `${report.input.stablecoin} · ${peg.live ? 'live Agent402 evidence' : 'No live peg result'}`;
  get('apy').textContent = yieldEvidence.apy == null ? 'Unknown' : `${yieldEvidence.apy}%`;
  get('tvl').textContent = Number.isFinite(yieldEvidence.tvlUsd) ? `${money(yieldEvidence.tvlUsd)} TVL` : 'Unknown TVL';
  get('yieldDetail').textContent = yieldEvidence.marketContext?.observed
    ? `${yieldEvidence.marketContext.pools.length} market listings; not matched to this pool`
    : yieldEvidence.error || 'No live yield result';
  badge('tokenBadge', token.verdict, token.verdict === 'ok');
  get('tokenVerdict').textContent = token.verdict === 'unknown' ? token.unknown?.[0] || 'Safety check unresolved' : token.verdict === 'unsafe' ? 'Blocking signals detected' : token.verdict === 'caution' ? 'Caution signals detected' : 'No blocking signals reported';
  get('tokenList').innerHTML = [...(token.blocking || []), ...(token.warnings || []), ...(token.unknown || [])].map(value => `<li><span class="dot ${token.verdict === 'unsafe' ? 'red-dot' : 'teal-dot'}"></span>${safe(value)}</li>`).join('');
  const contractState = contract.verified === true ? 'verified' : contract.verified === false ? 'unverified' : 'unknown';
  badge('contractBadge', contractState, contract.verified === true);
  get('contractTitle').textContent = contract.verified === true
    ? contract.scan ? 'Source verified; heuristic scan complete' : 'Source verified; scan incomplete'
    : contract.verified === false ? 'Source not verified' : 'Contract evidence unresolved';
  get('contractDetail').textContent = contract.scan
    ? `${contract.findings.length} heuristic findings. Static scan is triage, not a formal audit.`
    : contract.error || (contract.verified === false ? 'No verified source was returned for this contract.' : 'Source or scan evidence is unresolved.');
  get('liquidity').textContent = Number.isFinite(yieldEvidence.tvlUsd) ? money(yieldEvidence.tvlUsd) : 'Unknown';
  get('coverage').textContent = `${report.evidenceCoverage.observed} / ${report.evidenceCoverage.total}`;
  const unresolved = report.evidenceCoverage.total - report.evidenceCoverage.observed;
  get('coverageDetail').textContent = unresolved ? `${unresolved} check${unresolved > 1 ? 's' : ''} unresolved — no complete score` : 'All report checks have evidence';
  document.querySelectorAll('.coverage i').forEach((item, index) => { item.className = index < report.evidenceCoverage.observed ? 'complete' : 'pending'; });
  get('actionTitle').textContent = report.action.replaceAll('-', ' ');
  get('actionDetail').textContent = report.riskScore === null
    ? report.severeOverrideApplied
      ? 'A severe signal requires avoidance; the composite score remains withheld because some checks are unresolved.'
      : 'Insufficient live evidence to calculate a risk score. Unknown does not mean safe.'
    : report.limitations[0];
}

function badge(id, value, good) { const element = get(id); element.textContent = String(value || 'unknown').replaceAll('-', ' ').toUpperCase(); element.className = `badge ${good ? 'good' : 'alert'}`; }
function money(value) { return value >= 1e6 ? `$${(value / 1e6).toFixed(2)}M` : `$${Math.round(value / 1e3)}K`; }
function safe(value) { const element = document.createElement('span'); element.textContent = value; return element.innerHTML; }
function isNoWalletAccountError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /wallet must (?:have|has) at least one account/i.test(message);
}
