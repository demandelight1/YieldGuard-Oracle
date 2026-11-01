import test from 'node:test';
import assert from 'node:assert/strict';
import { createSafetyReport, validateSafetyReportInput, ValidationError } from '../src/yieldguard.js';
import { createPaymentVerifier, PaymentError } from '../src/paymentVerifier.js';

test('unconfigured reports contain no simulated evidence or risk score', async () => {
  const report = await createSafetyReport({
    chain: 'celo',
    poolAddress: '0x0000000000000000000000000000000000000001',
    stablecoin: 'USDC'
  });
  assert.equal(report.mode, 'unconfigured');
  assert.equal(report.riskScore, null);
  assert.equal(report.level, 'unassessed');
  assert.equal(report.action, 'insufficient-evidence');
  assert.deepEqual(report.evidenceCoverage, { observed: 0, total: 5 });
  assert.equal(report.evidence.yield.apy, null);
  assert.equal(report.evidence.yield.tvlUsd, null);
  assert.equal(report.evidence.peg.status, 'unknown');
  assert.equal(report.evidence.token.verdict, 'unknown');
  assert.equal(report.evidence.contract.unknown, true);
});

test('invalid pool addresses are rejected before payment can be consumed', () => {
  assert.throws(
    () => validateSafetyReportInput({ chain: 'celo', poolAddress: '0x123', stablecoin: 'USDC' }),
    ValidationError
  );
});

test('verified Celo USDC/CELO pool address is accepted', () => {
  const poolAddress = '0xac7df2260febf3558c966c16b70833b791ef7544';
  const input = validateSafetyReportInput({ chain: 'celo', poolAddress, stablecoin: 'USDC' });
  assert.equal(input.chain, 'celo');
  assert.equal(input.poolAddress, poolAddress);
  assert.equal(input.tokenAddress, null);
});

test('live checks use individual Buy caps and do not treat market context as pool yield', async () => {
  const poolAddress = '0xac7df2260febf3558c966c16b70833b791ef7544';
  const tokenAddress = '0x0000000000000000000000000000000000000002';
  const caps = [];
  const adapters = {
    async fetchStablecoinPeg(_symbol, options) {
      caps.push(options.maxUpstreamUsd);
      return { status: 'on-peg', deviationBps: -2, price: 0.9998 };
    },
    async fetchDefiYieldContext(_chain, _symbol, options) {
      caps.push(options.maxUpstreamUsd);
      return { source: 'defillama-yields', pools: [{ project: 'example', apy: 5, tvlUsd: 100000 }] };
    },
    async fetchTokenSafety(_chain, address, options) {
      caps.push(options.maxUpstreamUsd);
      return { address, verdict: 'caution', blocking: ['Owner privileges detected.'], warnings: [], unknown: [], facts: {} };
    },
    async fetchContractSource(_chain, address, options) {
      caps.push(options.maxUpstreamUsd);
      return { address, verified: true, sourceCount: 1, compiler: { version: '0.8.0' }, sources: { 'Pool.sol': 'pragma solidity ^0.8.0; contract Pool {}' } };
    },
    async scanSolidity(_source, options) {
      caps.push(options.maxUpstreamUsd);
      return { lines: 1, findings: [], summary: { high: 0, medium: 0, low: 0 }, disclaimer: 'Heuristic only.' };
    }
  };
  const report = await createSafetyReport({ chain: 'celo', poolAddress, tokenAddress, stablecoin: 'USDC' }, {
    liveUpstreams: true,
    maxUpstreamUsd: 0.03,
    adapters
  });

  assert.deepEqual(caps.sort((a, b) => a - b), [0.002, 0.003, 0.005, 0.005, 0.01]);
  assert.equal(report.evidence.upstreamBudget.reservedCapUsd, 0.025);
  assert.equal(report.evidence.peg.status, 'on-peg');
  assert.equal(report.evidence.token.verdict, 'caution');
  assert.equal(report.evidence.contract.findings.length, 0);
  assert.equal(report.evidence.yield.marketContext.scope, 'market-context-only');
  assert.equal(report.evidence.yield.apy, null);
  assert.equal(report.evidence.yield.tvlUsd, null);
  assert.equal(report.evidenceCoverage.observed, 3);
  assert.equal(report.riskScore, null);
});

test('severe live evidence warns without presenting an incomplete composite score', async () => {
  const adapters = {
    async fetchStablecoinPeg() { return { status: 'depegged', deviationBps: -250, price: 0.975 }; },
    async fetchDefiYieldContext() { return { pools: [] }; },
    async fetchTokenSafety(_chain, address) { return { address, verdict: 'ok' }; },
    async fetchContractSource(_chain, address) { return { address, verified: false }; },
    async scanSolidity() { throw new Error('Must not scan an unverified contract.'); }
  };
  const report = await createSafetyReport({
    chain: 'celo',
    poolAddress: '0xac7df2260febf3558c966c16b70833b791ef7544',
    tokenAddress: '0x0000000000000000000000000000000000000002'
  }, { liveUpstreams: true, maxUpstreamUsd: 0.03, adapters });

  assert.equal(report.riskScore, null);
  assert.equal(report.level, 'high');
  assert.equal(report.action, 'avoid-by-default');
  assert.equal(report.severeOverrideApplied, true);
});

test('payment verifier waits for the confirmed receipt before reading transaction details', async () => {
  const events = [];
  const verifier = createPaymentVerifier({
    rpcUrl: 'https://forno.celo.org',
    recipient: '0xf171D36B8E89566eD86e162F07289980A5c2970f',
    attributionTag: 'celo_test_tag',
    usdcAddress: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
    minimumAtomic: 40_000n
  }, {
    client: {
      async waitForTransactionReceipt() {
        events.push('receipt');
        return { status: 'success' };
      },
      async getTransaction() {
        events.push('transaction');
        return {
          to: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
          input: `0xa9059cbb${'0'.repeat(24)}${'f171d36b8e89566ed86e162f07289980a5c2970f'}${(40_000n).toString(16).padStart(64, '0')}`
        };
      }
    },
    async verifyTx() {
      events.push('attribution');
      return { codes: ['celo_test_tag'] };
    }
  });
  const result = await verifier.verify({ hash: `0x${'a'.repeat(64)}` });
  const retried = await verifier.verify({ hash: `0x${'a'.repeat(64)}` });

  assert.deepEqual(events, ['receipt', 'transaction', 'attribution']);
  assert.equal(result.paidAtomic, '40000');
  assert.equal(retried.paymentId, result.paymentId);
  verifier.consume(result.paymentId);
  assert.throws(() => verifier.consume(result.paymentId), error => error.code === 'PAYMENT_ALREADY_USED');
  await assert.rejects(
    verifier.verify({ hash: `0x${'a'.repeat(64)}` }),
    error => error.code === 'PAYMENT_ALREADY_USED'
  );
});

test('unconfirmed payment returns a retryable pending error', async () => {
  const verifier = createPaymentVerifier({
    rpcUrl: 'https://forno.celo.org',
    recipient: '0xf171D36B8E89566eD86e162F07289980A5c2970f',
    attributionTag: 'celo_test_tag',
    usdcAddress: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C',
    minimumAtomic: 40_000n
  }, {
    client: {
      async waitForTransactionReceipt() {
        const error = new Error('Timed out while waiting for transaction.');
        error.name = 'WaitForTransactionReceiptTimeoutError';
        throw error;
      }
    },
    async verifyTx() { throw new Error('Attribution must not be read before confirmation.'); }
  });

  await assert.rejects(
    verifier.verify({ hash: `0x${'b'.repeat(64)}` }),
    error => error instanceof PaymentError && error.code === 'PAYMENT_PENDING' && /retry verification/i.test(error.message)
  );
});

test('live report preserves explicit provider failures and does not exceed its aggregate cap', async () => {
  const poolAddress = '0xac7df2260febf3558c966c16b70833b791ef7544';
  const tokenAddress = '0x0000000000000000000000000000000000000002';
  const caps = [];
  const adapters = {
    async fetchStablecoinPeg(_symbol, options) { caps.push(options.maxUpstreamUsd); throw new Error('peg unavailable'); },
    async fetchDefiYieldContext(_chain, _symbol, options) { caps.push(options.maxUpstreamUsd); return { pools: [] }; },
    async fetchTokenSafety(_chain, address, options) { caps.push(options.maxUpstreamUsd); return { address, verdict: 'unsupported', because: 'Token safety is not available for this chain.' }; },
    async fetchContractSource(_chain, address, options) { caps.push(options.maxUpstreamUsd); return { address, verified: false }; },
    async scanSolidity(_source, options) { caps.push(options.maxUpstreamUsd); return { findings: [] }; }
  };
  const report = await createSafetyReport({ chain: 'celo', poolAddress, tokenAddress }, {
    liveUpstreams: true,
    maxUpstreamUsd: 0.01,
    adapters
  });

  assert.equal(report.evidence.peg.status, 'unknown');
  assert.match(report.evidence.peg.error, /peg unavailable/);
  assert.equal(report.evidence.token.verdict, 'unknown');
  assert.deepEqual(report.evidence.token.unknown, ['Token safety is not available for this chain.']);
  assert.equal(report.evidence.contract.verified, null);
  assert.match(report.evidence.contract.error, /remaining upstream budget/);
  assert.equal(report.evidence.upstreamBudget.reservedCapUsd, 0.01);
  assert.equal(caps.reduce((sum, cap) => sum + cap, 0), 0.01);
});
