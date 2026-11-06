import { getAddress } from 'viem';

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const num = value => { const n = Number(value); return value != null && value !== '' && Number.isFinite(n) ? n : null; };

export function checksum(address) {
  return ADDRESS.test(address || '') ? getAddress(address) : null;
}

function logo(url) {
  return typeof url === 'string' && /^https:\/\//.test(url) && !/missing/i.test(url) ? url : null;
}

function tokenFrom(network, resource) {
  const attr = resource?.attributes;
  const address = checksum(attr?.address);
  if (!address) return null;
  return {
    chain: network.id,
    address,
    name: String(attr.name || '').slice(0, 80) || null,
    symbol: String(attr.symbol || '').slice(0, 24) || null,
    decimals: Number.isInteger(attr.decimals) ? attr.decimals : null,
    logoUrl: logo(attr.image_url)
  };
}

function parsePools(network, payload) {
  const included = new Map((payload?.included || []).map(item => [`${item.type}:${item.id}`, item]));
  const prefix = `${network.geckoNetwork}_`;
  return (Array.isArray(payload?.data) ? payload.data : []).map(pool => {
    const attr = pool.attributes || {};
    const rel = pool.relationships || {};
    const base = tokenFrom(network, included.get(`token:${rel.base_token?.data?.id}`));
    const quote = tokenFrom(network, included.get(`token:${rel.quote_token?.data?.id}`));
    const dexId = rel.dex?.data?.id || null;
    const fee = /(\d+(?:\.\d+)?%)\s*$/.exec(attr.name || '')?.[1] || null;
    return {
      onNetwork: typeof pool.id === 'string' && pool.id.startsWith(prefix),
      address: String(attr.address || ''),
      dexId,
      dexName: included.get(`dex:${dexId}`)?.attributes?.name || dexId,
      fee,
      base: base && { ...base, priceUsd: num(attr.base_token_price_usd) },
      quote: quote && { ...quote, priceUsd: num(attr.quote_token_price_usd) },
      liquidityUsd: num(attr.reserve_in_usd),
      volume24hUsd: num(attr.volume_usd?.h24),
      createdAt: attr.pool_created_at || null
    };
  });
}

const INCLUDE = 'include=base_token,quote_token,dex';

export function createGeckoTerminal(upstream, { baseUrl = 'https://api.geckoterminal.com/api/v2', apiKey } = {}) {
  const headers = { Accept: 'application/json;version=20230302', ...(apiKey ? { 'x-cg-pro-api-key': apiKey } : {}) };
  const get = path => upstream.fetchJson(`${baseUrl}${path}`, { headers });

  return {
    /** Pools from GET /networks/{network}/trending_pools. */
    trendingPools(network) {
      return upstream.remember(`gt:trending:${network.id}`, { ttlMs: 120_000 },
        async () => parsePools(network, await get(`/networks/${network.geckoNetwork}/trending_pools?${INCLUDE}`)));
    },
    /** GET /search/pools, restricted to the selected network. */
    searchPools(network, query) {
      const key = `gt:search:${network.id}:${query.toLowerCase()}`;
      return upstream.remember(key, { ttlMs: 60_000 }, async () => {
        const payload = await get(`/search/pools?query=${encodeURIComponent(query)}&network=${network.geckoNetwork}&${INCLUDE}`);
        return parsePools(network, payload).filter(pool => pool.onNetwork);
      });
    },
    /** GET /networks/{network}/tokens/{address}/pools */
    tokenPools(network, address) {
      return upstream.remember(`gt:pools:${network.id}:${address.toLowerCase()}`, { ttlMs: 60_000 },
        async () => parsePools(network, await get(`/networks/${network.geckoNetwork}/tokens/${address}/pools?${INCLUDE}&page=1`)));
    },
    /** GET /networks/{network}/tokens/{address}; resolves to null when GeckoTerminal does not index the token. */
    tokenInfo(network, address) {
      return upstream.remember(`gt:token:${network.id}:${address.toLowerCase()}`, { ttlMs: 300_000 }, async () => {
        try {
          const payload = await get(`/networks/${network.geckoNetwork}/tokens/${address}`);
          const token = tokenFrom(network, payload?.data);
          const attr = payload?.data?.attributes || {};
          return token && { ...token, priceUsd: num(attr.price_usd), liquidityUsd: num(attr.total_reserve_in_usd), volume24hUsd: num(attr.volume_usd?.h24) };
        } catch (error) {
          if (error?.code === 'NOT_FOUND') return null;
          throw error;
        }
      });
    }
  };
}
