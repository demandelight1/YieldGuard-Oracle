import 'dotenv/config';
import express from 'express';
import { celo } from 'viem/chains';
import { createSafetyReport, validateSafetyReportInput, ValidationError } from './yieldguard.js';
import { createPaymentVerifier, PaymentError } from './paymentVerifier.js';
import { FULL_UPSTREAM_BUDGET_USD } from './buyClient.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const price = process.env.REPORT_PRICE_USDC || '0.04';
const paymentRequired = process.env.REQUIRE_CONSUMER_PAYMENT === 'true';
const paymentVerifier = createPaymentVerifier({
  rpcUrl: process.env.CELO_RPC_URL || 'https://forno.celo.org', recipient: process.env.YIELDGUARD_AGENT_ADDRESS,
  usdcAddress: process.env.CELO_USDC_ADDRESS,
  minimumAtomic: BigInt(Math.round(Number(price) * 1_000_000))
});
class UpstreamConfigurationError extends Error {
  constructor(message) { super(message); this.code = 'UPSTREAM_CONFIGURATION'; }
}

app.disable('x-powered-by');
app.use(express.json({ limit: '24kb' }));
app.use(express.static('public'));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'YieldGuard Oracle', network: 'celo', agentAddress: process.env.YIELDGUARD_AGENT_ADDRESS, attributionTag: process.env.CELO_ATTRIBUTION_TAG, liveUpstreams: process.env.ENABLE_LIVE_UPSTREAMS === 'true', consumerPaymentRequired: paymentRequired }));
app.get('/api/payment-config', (_req, res) => res.json({
  chainId: celo.id,
  recipient: process.env.YIELDGUARD_AGENT_ADDRESS,
  usdcAddress: process.env.CELO_USDC_ADDRESS,
  priceUsdc: price,
  paymentRequired,
  liveUpstreams: process.env.ENABLE_LIVE_UPSTREAMS === 'true',
  upstreamBudgetReady: Number.isFinite(Number(process.env.UPSTREAM_MAX_USD || 0.03)) && Number(process.env.UPSTREAM_MAX_USD || 0.03) >= FULL_UPSTREAM_BUDGET_USD
}));
app.post('/api/payments/verify', async (req, res) => {
  try { res.json(await paymentVerifier.verify({ hash: req.body?.transactionHash })); }
  catch (error) {
    const status = error instanceof PaymentError
      ? ['PAYMENT_PENDING', 'PAYMENT_INDEXING'].includes(error.code) ? 409 : 400
      : 502;
    res.status(status).json({ error: error.message, code: error.code || 'PAYMENT_VERIFICATION_ERROR' });
  }
});
app.get('/api/composite/yield-safety-score', handleReport);
app.post('/api/composite/yield-safety-score', handleReport);

async function handleReport(req, res) {
  try {
    const input = req.method === 'GET' ? req.query : req.body;
    validateSafetyReportInput(input);
    const liveUpstreams = process.env.ENABLE_LIVE_UPSTREAMS === 'true';
    const maxUpstreamUsd = Number(process.env.UPSTREAM_MAX_USD || 0.03);
    if (paymentRequired && !input.tokenAddress) {
      throw new ValidationError('tokenAddress is required for a paid token-safety check; payment was not consumed.');
    }
    if (paymentRequired && !liveUpstreams) {
      throw new UpstreamConfigurationError('Live upstream checks are disabled; payment was not consumed.');
    }
    if (paymentRequired && (!Number.isFinite(maxUpstreamUsd) || maxUpstreamUsd < FULL_UPSTREAM_BUDGET_USD)) {
      throw new UpstreamConfigurationError(`UPSTREAM_MAX_USD must be at least $${FULL_UPSTREAM_BUDGET_USD.toFixed(3)} before accepting a paid scan.`);
    }
    if (paymentRequired) paymentVerifier.consume(req.method === 'GET' ? req.query.paymentId : req.body?.paymentId);
    res.set('Cache-Control', 'no-store').json(await createSafetyReport(input, {
      liveUpstreams,
      maxUpstreamUsd,
      buyAccount: process.env.BUY_ACCOUNT || 'yieldguard-oracle',
      buyCommand: process.env.BUY_COMMAND
    }));
  }
  catch (error) {
    const paymentStatus = error instanceof PaymentError && error.code === 'PAYMENT_REQUIRED' ? 402 : 400;
    res.status(error instanceof UpstreamConfigurationError ? 503 : error instanceof ValidationError ? 400 : error instanceof PaymentError ? paymentStatus : 502).json({ error: error.message, code: error.code || 'UPSTREAM_ERROR' });
  }
}
app.use((error, _req, res, _next) => res.status(500).json({ error: 'Unexpected server error.', code: 'INTERNAL_ERROR' }));
app.listen(port, () => console.log(`YieldGuard Oracle listening on http://localhost:${port}`));
