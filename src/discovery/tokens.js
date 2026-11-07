import { isAddress } from 'viem';
import { DiscoveryError } from './errors.js';
import { checksum } from './geckoterminal.js';
import { getNetwork } from './networks.js';

const MAX_TRENDING_TOKENS = 30;
const MAX_QUERY_LENGTH = 100;
const FALLBACK_TOKEN_TERMS = ['USDC', 'USDT', 'DAI', 'WETH', 'WBTC', 'CELO'];
const key = token => token.address.toLowerCase();

export function requireAddress(value, label = 'token') {
  const address = String(value || '').trim();
  if (!isAddress(address, { strict: false })) {
    throw new DiscoveryError(`Enter a valid 0x ${label} contract address (0x followed by 40 hexadecimal characters).`, { status: 400, code: 'INVALID_ADDRESS' });
  }
  return checksum(address);
}

/** Maps non-discovery failures from the RPC layer to a clear, retryable error. */
export async function viaRpc(network, work) {
  try { return await work(); }
  catch (error) {
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError(`Could not reach a ${network.label} RPC endpoint to validate on-chain data. Try again shortly.`, { code: 'RPC_UNAVAILABLE' });
  }
}

export function createTokenService({ gecko, lists, rpc, fallback }) {
  return {
    /** Unique base/quote tokens from GeckoTerminal's trending pools for the chain, in trending order. */
    async trending(chainId) {
      const network = getNetwork(chainId);
      const tokens = new Map();
      try {
        for (const pool of await gecko.trendingPools(network)) {
          if (!pool.onNetwork) continue;
          for (const side of [pool.base, pool.quote]) {
            if (!side) continue;
            const existing = tokens.get(key(side));
            if (existing) {
              existing.liquidityUsd = Math.max(existing.liquidityUsd ?? 0, pool.liquidityUsd ?? 0) || null;
              existing.volume24hUsd = (existing.volume24hUsd ?? 0) + (pool.volume24hUsd ?? 0) || null;
            } else {
              tokens.set(key(side), { ...side, liquidityUsd: pool.liquidityUsd, volume24hUsd: pool.volume24hUsd });
            }
          }
        }
        return { chain: network.id, tokens: [...tokens.values()].slice(0, MAX_TRENDING_TOKENS), warnings: [] };
      } catch (error) {
        // A provider-wide trending-data limit should not make the token picker unusable.
        // DexScreener is separately rate-limited; use it first, then the chain token list.
        if (error?.code !== 'RATE_LIMITED') throw error;
        if (fallback?.supports(network) && typeof fallback.searchPools === 'function') {
          const pools = await Promise.all(FALLBACK_TOKEN_TERMS.map(term => fallback.searchPools(network, term).catch(() => [])));
          for (const pool of pools.flat()) {
            for (const side of [pool.base, pool.quote]) {
              if (side) tokens.set(key(side), { ...side, liquidityUsd: pool.liquidityUsd, volume24hUsd: pool.volume24hUsd });
            }
          }
          if (tokens.size) return { chain: network.id, tokens: [...tokens.values()].slice(0, MAX_TRENDING_TOKENS), warnings: ['trending-data-rate-limited-using-dexscreener'] };
        }
        const groups = await Promise.all(FALLBACK_TOKEN_TERMS.map(term => lists.search(network, term).catch(() => [])));
        for (const token of groups.flat()) tokens.set(key(token), token);
        if (!tokens.size) throw error;
        return {
          chain: network.id,
          tokens: [...tokens.values()].slice(0, MAX_TRENDING_TOKENS),
          warnings: ['trending-data-rate-limited-using-token-list']
        };
      }
    },

    /** Name / symbol / contract-address search restricted to one chain. */
    async search(chainId, rawQuery) {
      const network = getNetwork(chainId);
      const query = String(rawQuery || '').trim().slice(0, MAX_QUERY_LENGTH);
      if (!query) return { chain: network.id, tokens: [], warnings: [] };
      if (/^0x[a-fA-F0-9]{40}$/.test(query)) {
        try { return { chain: network.id, tokens: [await this.lookup(network.id, query)], warnings: [] }; }
        catch (error) {
          if (['NOT_A_CONTRACT', 'NOT_A_TOKEN'].includes(error?.code)) return { chain: network.id, tokens: [], warnings: [] };
          throw error;
        }
      }

      const warnings = [];
      let failure;
      let listed = [];
      try { listed = await lists.search(network, query); }
      catch (error) { failure = error; warnings.push('token-list-unavailable'); }

      let pooled = [];
      if (query.length >= 2 && listed.length < 8) {
        try {
          const q = query.toLowerCase();
          const tokens = new Map();
          for (const pool of await gecko.searchPools(network, query)) {
            for (const side of [pool.base, pool.quote]) {
              if (side && [side.name, side.symbol].some(value => value?.toLowerCase().includes(q))) {
                tokens.set(key(side), { ...side, liquidityUsd: pool.liquidityUsd, volume24hUsd: pool.volume24hUsd });
              }
            }
          }
          pooled = [...tokens.values()];
          failure = undefined;
        } catch (error) {
          failure ||= error;
          warnings.push('pool-search-unavailable');
        }
      }
      if (query.length >= 2 && !pooled.length && fallback?.supports(network) && typeof fallback.searchPools === 'function') {
        try {
          const q = query.toLowerCase();
          const tokens = new Map();
          for (const pool of await fallback.searchPools(network, query)) {
            for (const side of [pool.base, pool.quote]) {
              if (side && [side.name, side.symbol].some(value => value?.toLowerCase().includes(q))) {
                tokens.set(key(side), { ...side, liquidityUsd: pool.liquidityUsd, volume24hUsd: pool.volume24hUsd });
              }
            }
          }
          pooled = [...tokens.values()];
          if (pooled.length) { failure = undefined; warnings.push('using-dexscreener-search'); }
        } catch { /* A working token list still makes search useful. */ }
      }
      if (failure && !listed.length && !pooled.length) throw failure;

      const merged = new Map();
      for (const token of listed) merged.set(key(token), token);
      for (const token of pooled) merged.set(key(token), { ...merged.get(key(token)), ...token, logoUrl: token.logoUrl || merged.get(key(token))?.logoUrl || null });
      return { chain: network.id, tokens: [...merged.values()].slice(0, 20), warnings };
    },

    /** Validates a contract address on the chain and resolves its metadata (blockchain first, then indexers). */
    async lookup(chainId, rawAddress) {
      const network = getNetwork(chainId);
      const address = requireAddress(rawAddress);
      if (!await viaRpc(network, () => rpc.isContract(network.id, address))) {
        throw new DiscoveryError(`No contract exists at ${address} on ${network.label}.`, { status: 404, code: 'NOT_A_CONTRACT' });
      }
      const [onchain, indexed, listed] = await Promise.all([
        viaRpc(network, () => rpc.readErc20(network.id, address)),
        gecko.tokenInfo(network, address).catch(() => null),
        lists.find(network, address).catch(() => null)
      ]);
      if (onchain.decimals == null && !onchain.symbol && !indexed) {
        throw new DiscoveryError(`The contract at ${address} does not look like an ERC-20 token on ${network.label}.`, { status: 422, code: 'NOT_A_TOKEN' });
      }
      return {
        chain: network.id,
        address,
        name: onchain.name || indexed?.name || listed?.name || null,
        symbol: onchain.symbol || indexed?.symbol || listed?.symbol || null,
        decimals: onchain.decimals ?? indexed?.decimals ?? listed?.decimals ?? null,
        logoUrl: indexed?.logoUrl || listed?.logoUrl || null,
        priceUsd: indexed?.priceUsd ?? null,
        liquidityUsd: indexed?.liquidityUsd ?? null,
        volume24hUsd: indexed?.volume24hUsd ?? null
      };
    }
  };
}
