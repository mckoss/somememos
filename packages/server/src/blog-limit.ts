// A simple limit on anonymous traffic to public blog pages: a fixed window of
// requests per client address, plus a total. In memory, so a restart forgets
// (fine for one server process). Counting happens before any database or git
// work, so a flood costs a map lookup per request.

export interface PublicLimiterOptions {
  /** The window, in milliseconds. Default one minute. */
  readonly windowMs?: number;
  /** Requests one address may make in a window. Default 240. */
  readonly perAddress?: number;
  /** Requests all addresses together may make in a window. Default 20 000. */
  readonly total?: number;
  /** Addresses tracked in one window; beyond it, new addresses share one count. Default 50 000. */
  readonly maxAddresses?: number;
  readonly now?: () => number;
}

const OVERFLOW = '\0overflow';

export class PublicLimiter {
  private readonly windowMs: number;
  private readonly perAddress: number;
  private readonly total: number;
  private readonly maxAddresses: number;
  private readonly now: () => number;
  private windowStart = -Infinity;
  private readonly counts = new Map<string, number>();
  private all = 0;

  constructor(options: PublicLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.perAddress = options.perAddress ?? 240;
    this.total = options.total ?? 20_000;
    this.maxAddresses = options.maxAddresses ?? 50_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Counts one request from `address`. Returns 0 when it may go ahead, else
   * the seconds until the window ends (send 429 with `Retry-After`).
   */
  take(address: string): number {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.counts.clear();
      this.all = 0;
    }
    const key =
      this.counts.has(address) || this.counts.size < this.maxAddresses ? address : OVERFLOW;
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    this.all++;
    if (n <= this.perAddress && this.all <= this.total) return 0;
    return Math.max(1, Math.ceil((this.windowStart + this.windowMs - t) / 1000));
  }
}
