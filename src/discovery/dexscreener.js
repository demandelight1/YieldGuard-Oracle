import { checksum } from './geckoterminal.js';

const num = value => { const n = Number(value); return value != null && value !== '' && Number.isFinite(n) ? n : null; };

function side(network, token, priceUsd) {
  const address = checksum(token?.address);
  if (!address) return null;
  return {
    chain: network.id,
    address,
    name: String(token.name || '').slice(0, 80) || null,
    symbol: String(token.symbol || '').slice(0, 24) || null,
    decimals: null,
    logoUrl: null,
    priceUsd
  };
}

/**
 * DexScreener (free, no key) as a fallback pool source. Returns pools in the same shape as the
 * GeckoTerminal adapter so the compatibility filter and on-chain validation apply identically.
 */
export function createDexScreener(upstream, { baseUrl = 'https://api.dexscreener.com' } = {}) {
  return {
    supports: network => Boolean(network.dexscreenerChain),
    /** GET /token-pairs/v1/{chainId}/{tokenAddress} */
    tokenPools(network, address) {
      return upstream.remember(`ds:pools:${network.id}:${address.toLowerCase()}`, { ttlMs: 60_000 }, async () => {
        const payload = await upstream.fetchJson(`${baseUrl}/token-pairs/v1/${network.dexscreenerChain}/${address}`);
        return (Array.isArray(payload) ? payload : []).map(pair => ({
          onNetwork: pair?.chainId === network.dexscreenerChain,
          address: String(pair?.pairAddress || ''),
          dexId: pair?.dexId || null,
          dexName: pair?.dexId ? String(pair.dexId).replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null,
          fee: null,
          base: side(network, pair?.baseToken, num(pair?.priceUsd)),
          quote: side(network, pair?.quoteToken, null),
          liquidityUsd: num(pair?.liquidity?.usd),
          volume24hUsd: num(pair?.volume?.h24),
          createdAt: Number.isFinite(pair?.pairCreatedAt) ? new Date(pair.pairCreatedAt).toISOString() : null
        }));
      });
    }
  };
}
