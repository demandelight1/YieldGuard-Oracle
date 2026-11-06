import { DiscoveryError } from './errors.js';

const sleepFor = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Shared HTTP layer for third-party discovery APIs: timeouts, a sliding-window rate limiter,
 * 429 cooldowns, a TTL cache with stale-if-error, and in-flight de-duplication.
 */
export function createUpstream({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = sleepFor,
  timeoutMs = 8000,
  maxPerMinute = 25,
  maxWaitMs = 6000,
  maxEntries = 500
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const stamps = [];
  let cooldownUntil = 0;

  async function acquireSlot() {
    for (;;) {
      const current = now();
      if (current < cooldownUntil) {
        throw new DiscoveryError('The market-data provider is rate limiting requests. Try again shortly.', { status: 429, code: 'RATE_LIMITED', retryAfter: Math.ceil((cooldownUntil - current) / 1000) });
      }
      while (stamps.length && stamps[0] <= current - 60_000) stamps.shift();
      if (stamps.length < maxPerMinute) { stamps.push(current); return; }
      const wait = stamps[0] + 60_000 - current;
      if (wait > maxWaitMs) {
        throw new DiscoveryError('Too many discovery requests right now. Try again shortly.', { status: 429, code: 'RATE_LIMITED', retryAfter: Math.ceil(wait / 1000) });
      }
      await sleep(wait);
    }
  }

  async function fetchJson(url, { headers = {}, limited = true, timeout = timeoutMs } = {}) {
    if (limited) await acquireSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal });
      if (response.status === 429) {
        const retry = Math.min(Math.max(Number(response.headers?.get?.('retry-after')) || 30, 1), 120);
        cooldownUntil = now() + retry * 1000;
        throw new DiscoveryError('The market-data provider is rate limiting requests. Try again shortly.', { status: 429, code: 'RATE_LIMITED', retryAfter: retry });
      }
      if (response.status === 404) throw new DiscoveryError('Not found at the market-data provider.', { status: 404, code: 'NOT_FOUND' });
      if (!response.ok) throw new DiscoveryError(`Market-data provider returned HTTP ${response.status}.`, { code: 'UPSTREAM_ERROR' });
      try { return await response.json(); }
      catch { throw new DiscoveryError('Market-data provider returned an invalid response.', { code: 'UPSTREAM_ERROR' }); }
    } catch (error) {
      if (error instanceof DiscoveryError) throw error;
      if (error?.name === 'AbortError') throw new DiscoveryError('The market-data provider timed out.', { status: 504, code: 'UPSTREAM_TIMEOUT' });
      throw new DiscoveryError('Could not reach the market-data provider.', { code: 'UPSTREAM_UNREACHABLE' });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Cached, de-duplicated load. Serves a stale value if a refresh fails (except NOT_FOUND). */
  function remember(key, { ttlMs, staleMs = ttlMs * 10 }, loader) {
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return Promise.resolve(hit.value);
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      try {
        const value = await loader();
        cache.delete(key);
        cache.set(key, { value, expires: now() + ttlMs, staleUntil: now() + ttlMs + staleMs });
        while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
        return value;
      } catch (error) {
        if (hit && hit.staleUntil > now() && error?.code !== 'NOT_FOUND') return hit.value;
        throw error;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  return { fetchJson, remember };
}
