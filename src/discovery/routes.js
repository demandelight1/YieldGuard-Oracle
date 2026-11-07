import { Router } from 'express';
import { DiscoveryError } from './errors.js';
import { createDexScreener } from './dexscreener.js';
import { createGeckoTerminal } from './geckoterminal.js';
import { DEFAULT_CHAIN, publicNetworks } from './networks.js';
import { createPoolService } from './pools.js';
import { createRpc } from './rpc.js';
import { createTokenService } from './tokens.js';
import { createTokenLists } from './tokenLists.js';
import { createUpstream } from './upstream.js';

/**
 * Token / pool discovery API. Third-party providers (GeckoTerminal, CoinGecko token lists) and RPC calls
 * stay server-side; nothing here is required by the scan endpoints.
 *
 * Pool discovery: GeckoTerminal first, DexScreener fallback.
 * Env: GECKOTERMINAL_BASE_URL, COINGECKO_API_KEY (optional paid tier), GECKOTERMINAL_MAX_PER_MINUTE,
 * POOL_MIN_LIQUIDITY_USD, RPC_URL_<CHAIN>.
 */
export function createDiscoveryServices(env = process.env, overrides = {}) {
  const upstream = overrides.upstream || createUpstream({ maxPerMinute: Number(env.GECKOTERMINAL_MAX_PER_MINUTE) || 25 });
  const gecko = overrides.gecko || createGeckoTerminal(upstream, { baseUrl: env.GECKOTERMINAL_BASE_URL || undefined, apiKey: env.COINGECKO_API_KEY || undefined });
  // DexScreener is free and far less restrictive, so it gets its own limiter and backs up pool discovery.
  const dexscreener = overrides.dexscreener || createDexScreener(createUpstream({ maxPerMinute: 120 }));
  const lists = overrides.lists || createTokenLists(upstream);
  const rpc = overrides.rpc || createRpc(env);
  const configuredMin = Number(env.POOL_MIN_LIQUIDITY_USD);
  const minLiquidityUsd = env.POOL_MIN_LIQUIDITY_USD && Number.isFinite(configuredMin) ? configuredMin : 1000;
  return { tokens: createTokenService({ gecko, lists, rpc }), pools: createPoolService({ gecko, fallback: dexscreener, rpc, minLiquidityUsd }), rpc };
}

function ipRateLimit({ max = 120, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip);
    const bucket = entry && entry.reset > now ? entry : { count: 0, reset: now + windowMs };
    bucket.count += 1;
    hits.set(req.ip, bucket);
    if (hits.size > 5000) for (const [ip, item] of hits) if (item.reset <= now) hits.delete(ip);
    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many discovery requests. Try again shortly.', code: 'RATE_LIMITED' });
    }
    next();
  };
}

export function createDiscoveryRouter(services = createDiscoveryServices()) {
  const router = Router();
  router.use(ipRateLimit());
  const chainOf = req => String(req.query.chain || DEFAULT_CHAIN);
  const handle = work => async (req, res) => {
    try { res.json(await work(req)); }
    catch (error) {
      if (!(error instanceof DiscoveryError)) {
        console.error('Discovery error:', error);
        return res.status(500).json({ error: 'Unexpected discovery error.', code: 'INTERNAL_ERROR' });
      }
      if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
      res.status(error.status).json({ error: error.message, code: error.code, ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}) });
    }
  };

  router.get('/chains', (_req, res) => res.json({ chains: publicNetworks(), defaultChain: DEFAULT_CHAIN }));
  router.get('/tokens/trending', handle(req => services.tokens.trending(chainOf(req))));
  router.get('/tokens/search', handle(req => services.tokens.search(chainOf(req), req.query.q)));
  router.get('/tokens/:address', handle(req => services.tokens.lookup(chainOf(req), req.params.address)));
  router.get('/pools', handle(req => services.pools.discover(chainOf(req), req.query.token)));
  return router;
}
