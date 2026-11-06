export class DiscoveryError extends Error {
  constructor(message, { status = 502, code = 'DISCOVERY_ERROR', retryAfter } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}
