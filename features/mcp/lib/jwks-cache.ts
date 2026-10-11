import {
  MCP_JWKS_CACHE_TTL_SECONDS,
  MCP_JWKS_MAX_KEYS,
  MCP_JWKS_MAX_STALE_SECONDS,
  MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS,
} from "../config/limits";

/**
 * A bounded, short-lived cache of the project's OAuth signing keys.
 *
 * WHY THIS EXISTS: supabase-js's own key lookup re-downloads the JWKS on
 * EVERY token that names an unknown key id. Anyone could send tokens with
 * random `kid`s and turn each request into a download from Supabase. Here:
 *   - keys are refreshed at most every MCP_JWKS_CACHE_TTL_SECONDS;
 *   - an unknown kid causes a download only if no download was attempted
 *     in the last MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS, for ALL requests
 *     together (this is also how a genuinely rotated-in key is picked up,
 *     within that window);
 *   - after a failed download, the next attempt waits the same interval;
 *   - downloaded keys are used for at most MCP_JWKS_MAX_STALE_SECONDS after
 *     the last successful download, then nothing verifies until one works.
 *
 * This only decides WHICH public key a signature is checked against. It
 * never accepts a token: a cached key still has to verify the signature,
 * and a missing key or failed download always means "reject".
 */

export type SigningKey = JsonWebKey & { kid: string };

export type JwksFetcher = () => Promise<unknown>;

const ACCEPTED_KTY = ["EC", "RSA"];
const ACCEPTED_ALG = ["ES256", "RS256"];

/** Only well-formed signature-verification keys survive; anything else in
 *  the document is ignored. Returns null for a malformed document. */
export function parseJwks(document: unknown): SigningKey[] | null {
  if (!document || typeof document !== "object") return null;
  const keys = (document as { keys?: unknown }).keys;
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MCP_JWKS_MAX_KEYS) return null;

  return keys.filter((key): key is SigningKey => {
    if (!key || typeof key !== "object") return false;
    const k = key as Record<string, unknown>;
    if (typeof k.kid !== "string" || k.kid.length === 0 || k.kid.length > 200) return false;
    if (typeof k.kty !== "string" || !ACCEPTED_KTY.includes(k.kty)) return false;
    if (k.use !== undefined && k.use !== "sig") return false;
    if (k.alg !== undefined && (typeof k.alg !== "string" || !ACCEPTED_ALG.includes(k.alg))) return false;
    if (k.key_ops !== undefined && !(Array.isArray(k.key_ops) && k.key_ops.includes("verify"))) return false;
    // Never a private key.
    if ("d" in k) return false;
    return true;
  });
}

/** Does this key type match the token's algorithm? */
export function keyMatchesAlgorithm(key: SigningKey, alg: string): boolean {
  if (key.alg && key.alg !== alg) return false;
  return (alg === "ES256" && key.kty === "EC" && key.crv === "P-256") || (alg === "RS256" && key.kty === "RSA");
}

export class JwksCache {
  private keys: SigningKey[] = [];
  private fetchedAt = 0;
  private nextAttemptAt = 0;
  /** Start of the most recent download attempt, successful or not. */
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;
  private readonly fetcher: JwksFetcher;
  private readonly now: () => number;

  constructor(fetcher: JwksFetcher, now: () => number = () => Date.now()) {
    this.fetcher = fetcher;
    this.now = now;
  }

  private find(kid: string): SigningKey | undefined {
    return this.keys.find((key) => key.kid === kid);
  }

  private usable(now: number): boolean {
    return this.fetchedAt > 0 && now - this.fetchedAt <= MCP_JWKS_MAX_STALE_SECONDS * 1000;
  }

  /** One download at a time; a failure keeps the old keys and backs off. */
  private refresh(now: number): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.lastAttemptAt = now;
    this.inFlight = (async () => {
      try {
        const keys = parseJwks(await this.fetcher());
        if (keys && keys.length > 0) {
          this.keys = keys;
          this.fetchedAt = this.now();
          this.nextAttemptAt = this.fetchedAt + MCP_JWKS_CACHE_TTL_SECONDS * 1000;
          return;
        }
      } catch {
        // fall through to back-off
      }
      this.nextAttemptAt = now + MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS * 1000;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** The key for `kid`, or null — in which case the token must be refused. */
  async getKey(kid: string): Promise<SigningKey | null> {
    let now = this.now();

    // Scheduled refresh (first use, TTL elapsed, or back-off elapsed). If
    // it just ran, this call does not download a second time.
    let refreshed = false;
    if (now >= this.nextAttemptAt) {
      await this.refresh(now);
      now = this.now();
      refreshed = true;
    }

    // Unknown kid: download again only if NO attempt (scheduled, unknown-
    // kid, successful or failed) happened within the window.
    let key = this.find(kid);
    if (!key && !refreshed && now - this.lastAttemptAt >= MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS * 1000) {
      await this.refresh(now);
      now = this.now();
      key = this.find(kid);
    }

    return key && this.usable(now) ? key : null;
  }
}
