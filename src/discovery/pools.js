import { DiscoveryError } from './errors.js';
import { getNetwork } from './networks.js';
import { requireAddress } from './tokens.js';

// Mirrors the scanner's pool requirement (validateSafetyReportInput): a 20-byte 0x address.
// GeckoTerminal also lists Uniswap v4 pools, which are identified by a 32-byte pool id inside a singleton
// manager contract, so they have no pool contract address the scanner could inspect.
const POOL_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const MAX_VALIDATED_CANDIDATES = 10;

export function createPoolService({ gecko, fallback, rpc, minLiquidityUsd = 1000 }) {
  return {
    /** Direct, server-side pool metrics used by a safety report after a pool is selected. */
    async metrics(chainId, rawPool) {
      const network = getNetwork(chainId);
      const address = requireAddress(rawPool, 'pool');
      let pools;
      let source = 'GeckoTerminal exact pool endpoint';
      let primaryError;
      try { pools = await gecko.pool(network, address); }
      catch (error) { primaryError = error; }
      if ((!pools?.length || primaryError) && fallback?.supports(network) && typeof fallback.pool === 'function') {
        try {
          const alternative = await fallback.pool(network, address);
          if (alternative?.length) {
            pools = alternative;
            source = 'DexScreener exact pool endpoint';
            primaryError = undefined;
          }
        } catch { /* Preserve the primary provider's useful error. */ }
      }
      if (primaryError) throw primaryError;
      const pool = pools?.find(item => item.address.toLowerCase() === address.toLowerCase());
      if (!pool) throw new DiscoveryError(`No market data was found for this pool on ${network.label}.`, { status: 404, code: 'POOL_NOT_FOUND' });
      return {
        address,
        source,
        liquidityUsd: pool.liquidityUsd,
        volume24hUsd: pool.volume24hUsd,
        fee: pool.fee,
        dex: pool.dexName || null,
        pair: `${pool.base?.symbol || '?'} / ${pool.quote?.symbol || '?'}`
      };
    },
    /**
     * Finds pools the existing scanner can assess for a token. GeckoTerminal is the primary source and
     * DexScreener the fallback (used when the primary errors, e.g. rate limits, or yields no usable pool).
     * Returns candidates sorted by 24h volume then liquidity; the caller decides whether zero, one or
     * several were found.
     */
    async discover(chainId, rawToken) {
      const network = getNetwork(chainId);
      const token = requireAddress(rawToken);
      const target = token.toLowerCase();

      // Applies the compatibility filter to one provider's raw pools.
      const screen = raw => {
        const excluded = {};
        const reject = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
        const seen = new Set();
        const candidates = [];
        for (const pool of raw) {
          if (!pool.onNetwork) { reject('wrong-network'); continue; }
          if (!POOL_ADDRESS.test(pool.address)) { reject('no-pool-contract-address'); continue; }
          if (!pool.base || !pool.quote) { reject('missing-token-data'); continue; }
          if (![pool.base, pool.quote].some(side => side.address.toLowerCase() === target)) { reject('token-mismatch'); continue; }
          if (!Number.isFinite(pool.liquidityUsd) || pool.liquidityUsd < minLiquidityUsd) { reject('insufficient-liquidity'); continue; }
          if (seen.has(pool.address.toLowerCase())) continue;
          seen.add(pool.address.toLowerCase());
          candidates.push(pool);
        }
        // Actively traded pools first; liquidity breaks ties. Raw liquidity alone ranks dormant or mispriced pools too high.
        candidates.sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0) || b.liquidityUsd - a.liquidityUsd);
        return { candidates, excluded };
      };

      let source = 'geckoterminal';
      let primaryError;
      let screened = { candidates: [], excluded: {} };
      try { screened = screen(await gecko.tokenPools(network, token)); }
      catch (error) { if (error?.code !== 'NOT_FOUND') primaryError = error; }

      if (!screened.candidates.length && fallback?.supports(network)) {
        try {
          const alternative = screen(await fallback.tokenPools(network, token));
          if (alternative.candidates.length || primaryError) {
            screened = alternative;
            source = 'dexscreener';
            primaryError = undefined;
          }
        } catch { /* keep the primary result or error */ }
      }
      if (primaryError) throw primaryError;
      const { candidates, excluded } = screened;
      const reject = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };

      // Do not trust indexer metadata: confirm each candidate is a contract on this chain and, where the
      // pool exposes token0/token1, that the selected token is really one of its assets.
      const checked = await Promise.all(candidates.slice(0, MAX_VALIDATED_CANDIDATES).map(async pool => {
        try {
          if (!await rpc.isContract(network.id, pool.address)) return { pool, reason: 'not-a-contract' };
          const pair = await rpc.readPairTokens(network.id, pool.address);
          if (pair && ![pair.token0, pair.token1].some(address => address.toLowerCase() === target)) return { pool, reason: 'token-mismatch-onchain' };
          return { pool };
        } catch {
          return { pool, reason: 'unverified' };
        }
      }));
      const valid = [];
      for (const result of checked) {
        if (result.reason) reject(result.reason); else valid.push(result.pool);
      }
      if (!valid.length && excluded.unverified) {
        throw new DiscoveryError(`Could not reach a ${network.label} RPC endpoint to validate liquidity pools. Try again shortly.`, { code: 'RPC_UNAVAILABLE' });
      }

      const pools = valid.map(pool => ({
        address: pool.address,
        dex: { id: pool.dexId, name: pool.dexName },
        pair: `${pool.base.symbol || '?'} / ${pool.quote.symbol || '?'}`,
        fee: pool.fee,
        baseToken: { address: pool.base.address, symbol: pool.base.symbol },
        quoteToken: { address: pool.quote.address, symbol: pool.quote.symbol },
        liquidityUsd: pool.liquidityUsd,
        volume24hUsd: pool.volume24hUsd
      }));
      return { chain: network.id, token, pools, excluded, source };
    }
  };
}
