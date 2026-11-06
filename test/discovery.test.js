import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryServices } from '../src/discovery/routes.js';
import { createUpstream } from '../src/discovery/upstream.js';
import { DiscoveryError } from '../src/discovery/errors.js';
import { NETWORKS, getNetwork } from '../src/discovery/networks.js';
import { validateSafetyReportInput } from '../src/yieldguard.js';

const TOKEN = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
const OTHER = '0x471EcE3750Da237f93B8E339c536989b8978a438';
const addr = n => `0x${n.toString(16).padStart(40, '0')}`;

function tokenResource(address, symbol) {
  return { id: `celo_${address.toLowerCase()}`, type: 'token', attributes: { address: address.toLowerCase(), name: `${symbol} Token`, symbol, decimals: 6, image_url: 'https://img.example/x.png' } };
}
function poolResource(address, { base = TOKEN, quote = OTHER, reserve = '50000', volume = '1000', dex = 'uniswap_v3_celo', name = 'USDC / CELO 0.3%', id } = {}) {
  return {
    id: id || `celo_${address}`, type: 'pool',
    attributes: { address, name, reserve_in_usd: reserve, volume_usd: { h24: volume }, base_token_price_usd: '1', quote_token_price_usd: '0.3' },
    relationships: { base_token: { data: { id: `celo_${base.toLowerCase()}` } }, quote_token: { data: { id: `celo_${quote.toLowerCase()}` } }, dex: { data: { id: dex } } }
  };
}
const included = [tokenResource(TOKEN, 'USDC'), tokenResource(OTHER, 'CELO'), { id: 'uniswap_v3_celo', type: 'dex', attributes: { name: 'Uniswap V3 (Celo)' } }];

const noFallback = { supports: () => false, tokenPools: async () => { throw new Error('fallback must not be called'); } };

function services({ pools = [], rpc = {}, trending = pools, calls = [], dexscreener = noFallback, geckoFails = false } = {}) {
  const fetchImpl = async url => {
    calls.push(String(url));
    if (geckoFails && String(url).includes('/pools')) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '5' }), json: async () => ({}) };
    const body = String(url).includes('/trending_pools') ? { data: trending, included }
      : String(url).includes('/pools') ? { data: pools, included }
        : String(url).includes('tokens.coingecko.com') ? { tokens: [{ chainId: 42220, address: TOKEN.toLowerCase(), name: 'USD Coin', symbol: 'USDC', decimals: 6, logoURI: 'https://img.example/usdc.png' }, { chainId: 1, address: OTHER.toLowerCase(), name: 'Wrong chain', symbol: 'USDC2' }] }
          : { data: null };
    return { ok: true, status: 200, headers: new Headers(), json: async () => body };
  };
  const fakeRpc = { isContract: async () => true, readPairTokens: async () => null, readErc20: async () => ({ name: 'USD Coin', symbol: 'USDC', decimals: 6 }), ...rpc };
  return createDiscoveryServices({}, { upstream: createUpstream({ fetchImpl }), rpc: fakeRpc, dexscreener });
}

test('every scanner chain has a discovery network and vice versa', () => {
  for (const network of NETWORKS) {
    assert.doesNotThrow(() => validateSafetyReportInput({ chain: network.id, poolAddress: addr(1), stablecoin: 'USDC' }), network.id);
  }
  assert.throws(() => validateSafetyReportInput({ chain: 'solana', poolAddress: addr(1) }));
  assert.throws(() => getNetwork('solana'), /Unsupported chain/);
  assert.equal(NETWORKS.length, 8);
});

test('trending tokens are unique base/quote tokens scoped to the network', async () => {
  const s = services({ trending: [poolResource(addr(10)), poolResource(addr(11), { id: 'eth_0xwrong' }), poolResource(addr(12))] });
  const { tokens } = await s.tokens.trending('celo');
  assert.deepEqual(tokens.map(t => t.symbol), ['USDC', 'CELO']);
  assert.equal(tokens[0].address, TOKEN);
  assert.equal(tokens[0].chain, 'celo');
});

test('trending token picker falls back to the chain token list when market data is rate limited', async () => {
  const gecko = { trendingPools: async () => { throw new DiscoveryError('rate limited', { status: 429, code: 'RATE_LIMITED' }); } };
  const lists = {
    search: async (network, term) => term === 'USDC'
      ? [{ chain: network.id, address: TOKEN, name: 'USD Coin', symbol: 'USDC', decimals: 6, logoUrl: null }]
      : []
  };
  const s = createDiscoveryServices({}, { gecko, lists, rpc: { isContract: async () => true, readPairTokens: async () => null, readErc20: async () => ({}) } });
  const result = await s.tokens.trending('celo');
  assert.deepEqual(result.tokens.map(token => token.symbol), ['USDC']);
  assert.deepEqual(result.warnings, ['trending-data-rate-limited-using-token-list']);
});

test('token search filters the chain-specific list and ignores other chains', async () => {
  const s = services();
  const result = await s.tokens.search('celo', 'usd');
  assert.deepEqual(result.tokens.map(t => t.symbol), ['USDC']);
  assert.equal((await s.tokens.search('celo', 'wrong')).tokens.length, 0);
});

test('manual lookup validates the address and the contract on the selected chain', async () => {
  const s = services();
  await assert.rejects(s.tokens.lookup('celo', '0x123'), { code: 'INVALID_ADDRESS' });
  const token = await s.tokens.lookup('celo', TOKEN.toLowerCase());
  assert.equal(token.symbol, 'USDC');
  assert.equal(token.address, TOKEN);
  const none = services({ rpc: { isContract: async () => false } });
  await assert.rejects(none.tokens.lookup('celo', TOKEN), { code: 'NOT_A_CONTRACT' });
});

test('pool discovery returns exactly one compatible pool when others are filtered out', async () => {
  const good = addr(100);
  const s = services({ pools: [
    poolResource(good, { reserve: '90000' }),
    poolResource('0x' + 'ab'.repeat(32), { dex: 'uniswap-v4-celo' }),            // v4 pool id, not a contract address
    poolResource(addr(101), { reserve: '10' }),                                    // below liquidity floor
    poolResource(addr(102), { base: OTHER, quote: OTHER }),                      // does not involve the token
    poolResource(addr(103), { id: 'base_0xwrong' })                                // other network
  ] });
  const result = await s.pools.discover('celo', TOKEN);
  assert.equal(result.pools.length, 1);
  assert.equal(result.pools[0].address, good);
  assert.equal(result.pools[0].dex.name, 'Uniswap V3 (Celo)');
  assert.equal(result.pools[0].fee, '0.3%');
  assert.deepEqual(result.excluded, { 'no-pool-contract-address': 1, 'insufficient-liquidity': 1, 'token-mismatch': 1, 'wrong-network': 1 });
});

test('multiple pools are sorted by liquidity and verified on-chain', async () => {
  const s = services({
    pools: [poolResource(addr(1), { reserve: '5000' }), poolResource(addr(2), { reserve: '80000' }), poolResource(addr(3), { reserve: '60000' }), poolResource(addr(4), { reserve: '70000' }), poolResource(addr(1), { reserve: '5000' })],
    rpc: {
      isContract: async (_n, a) => a !== addr(4),
      readPairTokens: async (_n, a) => a === addr(3) ? { token0: addr(8), token1: addr(9) } : null
    }
  });
  const result = await s.pools.discover('celo', TOKEN);
  assert.deepEqual(result.pools.map(p => p.address), [addr(2), addr(1)]);
  assert.equal(result.excluded['not-a-contract'], 1);
  assert.equal(result.excluded['token-mismatch-onchain'], 1);
});

test('no compatible pool yields an empty list, and RPC outages are reported as errors, not "no pool"', async () => {
  assert.deepEqual((await services({ pools: [] }).pools.discover('celo', TOKEN)).pools, []);
  const down = services({ pools: [poolResource(addr(1))], rpc: { isContract: async () => { throw new Error('rpc down'); } } });
  await assert.rejects(down.pools.discover('celo', TOKEN), { code: 'RPC_UNAVAILABLE' });
});

test('upstream caches, de-duplicates in-flight calls and honours 429 cooldowns', async () => {
  let n = 0;
  let status = 200;
  const upstream = createUpstream({ fetchImpl: async () => { n += 1; return { ok: status === 200, status, headers: new Headers({ 'retry-after': '5' }), json: async () => ({ n }) }; } });
  const load = () => upstream.remember('k', { ttlMs: 60_000 }, () => upstream.fetchJson('https://x.test/a'));
  const [a, b] = await Promise.all([load(), load()]);
  assert.equal(a.n, 1);
  assert.equal(b.n, 1);
  assert.equal((await load()).n, 1);
  assert.equal(n, 1);
  status = 429;
  await assert.rejects(upstream.fetchJson('https://x.test/b'), { code: 'RATE_LIMITED', retryAfter: 5 });
  await assert.rejects(upstream.fetchJson('https://x.test/c'), { code: 'RATE_LIMITED' });
  assert.equal(n, 2, 'no further upstream calls during the cooldown');
});

test('upstream limiter rejects instead of queueing past the maximum wait', async () => {
  const upstream = createUpstream({ maxPerMinute: 2, maxWaitMs: 100, fetchImpl: async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) }) });
  await upstream.fetchJson('https://x.test/1');
  await upstream.fetchJson('https://x.test/2');
  await assert.rejects(upstream.fetchJson('https://x.test/3'), { code: 'RATE_LIMITED' });
});

test('upstream serves stale data when a refresh fails', async () => {
  let t = 0;
  let fail = false;
  const upstream = createUpstream({ now: () => t });
  const load = () => upstream.remember('k', { ttlMs: 10 }, async () => { if (fail) throw new Error('boom'); return 'fresh'; });
  assert.equal(await load(), 'fresh');
  t = 100; fail = true;
  assert.equal(await load(), 'fresh');
});

const dsPool = (address, extra = {}) => ({
  onNetwork: true, address, dexId: 'uniswap', dexName: 'Uniswap', fee: null,
  base: { chain: 'celo', address: TOKEN, symbol: 'USDC' }, quote: { chain: 'celo', address: OTHER, symbol: 'CELO' },
  liquidityUsd: 50000, volume24hUsd: 100, ...extra
});

test('DexScreener fallback supplies pools when GeckoTerminal is rate limited, with the same filters and on-chain checks', async () => {
  const dexscreener = { supports: () => true, tokenPools: async () => [dsPool(addr(5)), dsPool(addr(6), { liquidityUsd: 5 }), dsPool(addr(7))] };
  const s = services({ geckoFails: true, dexscreener, rpc: { isContract: async (_n, a) => a !== addr(7) } });
  const result = await s.pools.discover('celo', TOKEN);
  assert.equal(result.source, 'dexscreener');
  assert.deepEqual(result.pools.map(p => p.address), [addr(5)]);
  assert.equal(result.excluded['insufficient-liquidity'], 1);
  assert.equal(result.excluded['not-a-contract'], 1);
});

test('fallback is used when GeckoTerminal only has unusable pools, and primary wins when it has usable ones', async () => {
  const dexscreener = { supports: () => true, tokenPools: async () => [dsPool(addr(5))] };
  const v4Only = services({ pools: [poolResource('0x' + 'ab'.repeat(32), { dex: 'uniswap-v4-celo' })], dexscreener });
  assert.equal((await v4Only.pools.discover('celo', TOKEN)).source, 'dexscreener');
  const primary = services({ pools: [poolResource(addr(9))], dexscreener });
  const result = await primary.pools.discover('celo', TOKEN);
  assert.equal(result.source, 'geckoterminal');
  assert.equal(result.pools[0].address, addr(9));
});

test('when both providers fail the original error is reported; unsupported chains skip the fallback', async () => {
  const broken = { supports: () => true, tokenPools: async () => { throw new Error('ds down'); } };
  await assert.rejects(services({ geckoFails: true, dexscreener: broken }).pools.discover('celo', TOKEN), { code: 'RATE_LIMITED' });
  await assert.rejects(services({ geckoFails: true }).pools.discover('celo', TOKEN), { code: 'RATE_LIMITED' });
  assert.equal(getNetwork('gnosis').dexscreenerChain, null);
});
