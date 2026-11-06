// Browser client for the YieldGuard discovery API (/api/discovery). The browser never talks to
// GeckoTerminal or CoinGecko directly; the server proxies, caches and rate-limits those providers.

const TIMEOUT_MS = 20_000;
const cache = new Map();
const inflight = new Map();

export class DiscoveryClientError extends Error {
  constructor(message, { code = 'DISCOVERY_ERROR', retryAfter } = {}) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function abortError() {
  return Object.assign(new Error('Request cancelled'), { name: 'AbortError' });
}

// Lets each caller cancel its own wait while the shared underlying request keeps feeding the cache.
function withSignal(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
    promise.then(resolve, reject);
  });
}

async function fetchJson(path) {
  let response;
  try { response = await fetch(path, { signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (error) {
    throw new DiscoveryClientError(error?.name === 'TimeoutError' ? 'The request timed out.' : 'Could not reach YieldGuard. Check your connection.', { code: 'NETWORK' });
  }
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const message = body.code === 'RATE_LIMITED' && body.retryAfter
      ? `Market data is busy. Try again in ${body.retryAfter}s.`
      : body.error || `Request failed (${response.status}).`;
    throw new DiscoveryClientError(message, { code: body.code, retryAfter: body.retryAfter });
  }
  return body;
}

function request(path, { ttlMs, signal } = {}) {
  const hit = cache.get(path);
  if (hit && hit.expires > Date.now()) return withSignal(Promise.resolve(hit.value), signal);
  if (!inflight.has(path)) {
    const promise = fetchJson(path)
      .then(value => { cache.set(path, { value, expires: Date.now() + ttlMs }); return value; })
      .finally(() => inflight.delete(path));
    inflight.set(path, promise);
  }
  return withSignal(inflight.get(path), signal);
}

const q = params => new URLSearchParams(params).toString();

export const fetchChains = options => request('/api/discovery/chains', { ttlMs: 3_600_000, ...options });
export const fetchTrending = (chain, options) => request(`/api/discovery/tokens/trending?${q({ chain })}`, { ttlMs: 120_000, ...options });
export const searchTokens = (chain, query, options) => request(`/api/discovery/tokens/search?${q({ chain, q: query })}`, { ttlMs: 60_000, ...options });
export const lookupToken = (chain, address, options) => request(`/api/discovery/tokens/${encodeURIComponent(address)}?${q({ chain })}`, { ttlMs: 300_000, ...options });
export const discoverPools = (chain, token, options) => request(`/api/discovery/pools?${q({ chain, token })}`, { ttlMs: 60_000, ...options });
