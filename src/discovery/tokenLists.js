import { checksum } from './geckoterminal.js';

const LIST_TTL_MS = 6 * 60 * 60 * 1000;

function rank(entry, q) {
  if (entry.symbolLc === q) return 0;
  if (entry.symbolLc.startsWith(q)) return 1;
  if (entry.nameLc.startsWith(q)) return 2;
  if (entry.symbolLc.includes(q)) return 3;
  if (entry.nameLc.includes(q)) return 4;
  return -1;
}

/** Chain-specific CoinGecko token lists (https://tokens.coingecko.com/{platform}/all.json), cached per platform. */
export function createTokenLists(upstream, { baseUrl = 'https://tokens.coingecko.com' } = {}) {
  function load(network) {
    return upstream.remember(`list:${network.coingeckoPlatform}`, { ttlMs: LIST_TTL_MS, staleMs: 7 * LIST_TTL_MS }, async () => {
      const payload = await upstream.fetchJson(`${baseUrl}/${network.coingeckoPlatform}/all.json`, { limited: false, timeout: 20_000 });
      const tokens = Array.isArray(payload?.tokens) ? payload.tokens : [];
      return tokens
        .filter(item => item && (item.chainId == null || item.chainId === network.chain.id))
        .map(item => ({ item, address: checksum(item.address) }))
        .filter(({ address }) => address)
        .map(({ item, address }) => ({
          token: {
            chain: network.id,
            address,
            name: String(item.name || '').slice(0, 80) || null,
            symbol: String(item.symbol || '').slice(0, 24) || null,
            decimals: Number.isInteger(item.decimals) ? item.decimals : null,
            logoUrl: typeof item.logoURI === 'string' && item.logoURI.startsWith('https://') ? item.logoURI : null
          },
          addressLc: address.toLowerCase(),
          nameLc: String(item.name || '').toLowerCase(),
          symbolLc: String(item.symbol || '').toLowerCase()
        }));
    });
  }

  return {
    async search(network, query, limit = 15) {
      const q = query.trim().toLowerCase();
      if (!q) return [];
      const entries = await load(network);
      return entries
        .map(entry => ({ entry, score: entry.addressLc === q ? 0 : rank(entry, q) }))
        .filter(({ score }) => score >= 0)
        .sort((a, b) => a.score - b.score || a.entry.symbolLc.length - b.entry.symbolLc.length)
        .slice(0, limit)
        .map(({ entry }) => entry.token);
    },
    async find(network, address) {
      const target = address.toLowerCase();
      return (await load(network)).find(entry => entry.addressLc === target)?.token || null;
    }
  };
}
