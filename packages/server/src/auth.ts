// Access (PLAN.md section 7, "Access"): a bearer token on every request.
//
// The first version is a single-user server: its tokens come from the
// environment and each grants the one implicit owner. Routes only ever see
// `Authorizer.authorize(request) → { userId } | null`, and brains record
// their owner (`server_brains.owner_id`), so real accounts can replace the
// token check without changing the routes or the data.

import { createHash, timingSafeEqual } from 'node:crypto';

/** The one user of a single-user server. */
export const OWNER_ID = 'owner';

export interface Principal {
  readonly userId: string;
}

export interface Authorizer {
  /** The user a request acts for, or null when it carries no valid credential. */
  authorize(request: Request): Principal | null | Promise<Principal | null>;
}

/** SHA-256 digests of the accepted tokens. */
export interface TokenSet {
  readonly digests: readonly Buffer[];
}

/** Raw tokens shorter than this are refused: a bearer token must not be guessable. */
export const MIN_TOKEN_LENGTH = 24;

const sha256 = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest();

/** Parses `SOMEMEMOS_TOKEN`: comma-separated raw tokens or `sha256:<hex>` digests. */
export function parseTokens(text: string): { tokens: TokenSet; problems: string[] } {
  const digests: Buffer[] = [];
  const problems: string[] = [];
  const entries = text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  entries.forEach((entry, i) => {
    const which = entries.length > 1 ? `entry ${i + 1}` : 'the token';
    const hashed = /^sha256:(.*)$/i.exec(entry);
    if (hashed) {
      const hex = (hashed[1] as string).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(hex)) {
        problems.push(`${which} starts with sha256: but is not followed by 64 hex digits`);
      } else digests.push(Buffer.from(hex, 'hex'));
    } else if (entry.length < MIN_TOKEN_LENGTH) {
      problems.push(`${which} is shorter than ${MIN_TOKEN_LENGTH} characters`);
    } else if (/\s/.test(entry)) {
      problems.push(`${which} contains whitespace`);
    } else {
      digests.push(sha256(entry));
    }
  });
  return { tokens: { digests }, problems };
}

/** `sha256:<hex>` for a raw token: the form to put in `SOMEMEMOS_TOKEN` instead of the token. */
export function hashToken(token: string): string {
  return `sha256:${sha256(token).toString('hex')}`;
}

/** The bearer token of a request, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m ? (m[1] as string) : null;
}

/** True when `token` matches one of `tokens`. Compares every digest, in constant time. */
export function tokenMatches(tokens: TokenSet, token: string): boolean {
  const presented = sha256(token);
  let match = false;
  for (const digest of tokens.digests) {
    // Equal lengths (32 bytes) always; `|` so every digest is compared.
    match = timingSafeEqual(presented, digest) || match;
  }
  return match;
}

/** The single-user authorizer: any configured token is the owner. */
export function tokenAuthorizer(tokens: TokenSet): Authorizer {
  return {
    authorize(request) {
      const token = bearerToken(request);
      if (token === null || tokens.digests.length === 0) return null;
      return tokenMatches(tokens, token) ? { userId: OWNER_ID } : null;
    },
  };
}

export interface FailureLimiterOptions {
  /** The window failures are counted over, in milliseconds. Default 10 minutes. */
  readonly windowMs?: number;
  /** Failures one address may make in a window before it is throttled. Default 20. */
  readonly perAddress?: number;
  /**
   * Failures all addresses together may make in a window. Past it, every
   * address that has failed at least once in the window is throttled; an
   * address with no failures is not. Default 200.
   */
  readonly total?: number;
  /** How far apart a throttled address's requests are spaced, in milliseconds. Default 1 s. */
  readonly spacingMs?: number;
  /**
   * The longest a throttled address's request may queue for its turn, in
   * milliseconds; a request that would wait longer is refused unchecked.
   * Default 30 s.
   */
  readonly maxQueueMs?: number;
  readonly now?: () => number;
}

/** What to do with a request before its token is checked. */
export type Admission =
  | { readonly kind: 'check'; readonly delayMs: number }
  | { readonly kind: 'refuse'; readonly retryAfter: number };

/**
 * Throttles failed authentication (security review 2026-11-27, finding 3).
 *
 * Failures are counted per client address and in total over a fixed window.
 * A valid token is never refused because of other clients' failures: an
 * address that has not failed in the window is never slowed or refused, and
 * every admitted request has its token compared, so the owner gets in.
 *
 * Guessing is bounded by spacing instead of by refusal. Once an address is
 * over its own limit (or the total limit is reached and the address has
 * failed in this window), each of its requests waits for a turn, `spacingMs`
 * apart, before its token is compared at all. That address therefore learns
 * at most one guess's result per `spacingMs`, however many connections it
 * opens, and giving up on a slow answer teaches it nothing because the
 * comparison has not happened yet. Its failed attempts answer 429 instead of
 * 401. A request whose turn would be more than `maxQueueMs` away is refused
 * with 429 without comparing, which only an address flooding its own queue
 * can cause. In memory: a restart forgets, which is acceptable for a
 * single-user server.
 */
export class FailureLimiter {
  private readonly windowMs: number;
  private readonly perAddress: number;
  private readonly total: number;
  private readonly spacingMs: number;
  private readonly maxQueueMs: number;
  private readonly now: () => number;
  private windowStart = 0;
  private readonly counts = new Map<string, number>();
  private readonly nextTurn = new Map<string, number>();
  private all = 0;

  constructor(options: FailureLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 10 * 60_000;
    this.perAddress = options.perAddress ?? 20;
    this.total = options.total ?? 200;
    this.spacingMs = options.spacingMs ?? 1000;
    this.maxQueueMs = options.maxQueueMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  private roll(): void {
    const t = this.now();
    if (t - this.windowStart >= this.windowMs) {
      this.windowStart = t;
      this.counts.clear();
      this.nextTurn.clear();
      this.all = 0;
    }
  }

  /** True when `address`'s requests are spaced out (and its failures answer 429). */
  throttled(address: string): boolean {
    this.roll();
    const mine = this.counts.get(address) ?? 0;
    return mine >= this.perAddress || (this.all >= this.total && mine > 0);
  }

  /** Seconds until the window ends: the `Retry-After` for a throttled address's failure. */
  retryAfter(): number {
    this.roll();
    return Math.max(1, Math.ceil((this.windowStart + this.windowMs - this.now()) / 1000));
  }

  /**
   * Admits a request from `address` before its token is checked: at once,
   * after a delay (its turn), or refused when its turn is too far away.
   */
  admit(address: string): Admission {
    if (!this.throttled(address)) return { kind: 'check', delayMs: 0 };
    const t = this.now();
    const turn = Math.max(t, this.nextTurn.get(address) ?? 0);
    const delayMs = turn - t;
    if (delayMs > this.maxQueueMs) {
      return { kind: 'refuse', retryAfter: Math.max(1, Math.ceil(delayMs / 1000)) };
    }
    this.nextTurn.set(address, turn + this.spacingMs);
    return { kind: 'check', delayMs };
  }

  fail(address: string): void {
    this.roll();
    this.counts.set(address, (this.counts.get(address) ?? 0) + 1);
    this.all++;
  }
}
