import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { JwksCache, keyMatchesAlgorithm } from "./jwks-cache";
import { getAuthorizationServerIssuer, getMcpResourceUrl } from "./urls";

/**
 * BEARER TOKEN VERIFICATION FOR /api/mcp.
 *
 * A request is accepted only when ALL of these hold:
 *   1. the header is `Authorization: Bearer <jwt>`;
 *   2. the JWT is asymmetrically signed (ES256/RS256) with a `kid` naming
 *      a key in the project's JWKS (bounded cache, jwks-cache.ts); the
 *      signature is verified locally against exactly that key by
 *      supabase-js getClaims(), which also rejects an expired token. HS256
 *      and kid-less tokens are refused up front, so verification never
 *      silently falls back to a network getUser() call;
 *   3. iss is exactly this project's auth issuer;
 *   4. role is "authenticated" and the user is not anonymous;
 *   5. sub is a uuid (the user);
 *   6. client_id is present — this is what separates a token the OAuth
 *      server issued to an MCP client from an ordinary Pipeway browser
 *      session token, which has no client_id and is refused here;
 *   7. every aud value is one this server accepts (MCP_ALLOWED_AUDIENCES,
 *      default "authenticated" plus this server's own resource URL), so a
 *      token minted for some other resource server is refused.
 *
 * UNVERIFIED against a live OAuth-issued token (see docs/mcp.md, "Manual
 * tests"): that Supabase puts client_id in the access token, and what it
 * puts in aud. If either differs, this rejects every token — it fails
 * closed, never open — and the fix is configuration, not code.
 */

export type VerifiedToken = {
  accessToken: string;
  userId: string;
  clientId: string;
  expiresAt: number;
};

export type TokenFailure = "missing" | "malformed" | "invalid";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ALGORITHMS = ["ES256", "RS256"];

export function allowedAudiences(): string[] {
  const configured = (process.env.MCP_ALLOWED_AUDIENCES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : ["authenticated", getMcpResourceUrl()];
}

/** Pure claim checks 3–7, unit-tested in verify-token.test.ts. */
export function validateClaims(
  claims: Record<string, unknown>,
  expected: { issuer: string; audiences: string[]; nowSeconds: number },
): { ok: true; userId: string; clientId: string; expiresAt: number } | { ok: false } {
  if (claims.iss !== expected.issuer) return { ok: false };
  if (claims.role !== "authenticated") return { ok: false };
  if (claims.is_anonymous === true) return { ok: false };
  if (typeof claims.sub !== "string" || !UUID_PATTERN.test(claims.sub)) return { ok: false };
  if (typeof claims.client_id !== "string" || claims.client_id.length === 0 || claims.client_id.length > 255) {
    return { ok: false };
  }
  if (typeof claims.exp !== "number" || claims.exp <= expected.nowSeconds) return { ok: false };

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (aud.length === 0 || !aud.every((value) => typeof value === "string" && expected.audiences.includes(value))) {
    return { ok: false };
  }

  return { ok: true, userId: claims.sub, clientId: claims.client_id, expiresAt: claims.exp };
}

/** Header check (step 2's "up front" part). Pure. */
export function readJwtHeader(token: string): { alg?: string; kid?: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
    return header && typeof header === "object" ? (header as { alg?: string; kid?: string }) : null;
  } catch {
    return null;
  }
}

/** One stateless client per server instance, used ONLY to verify JWT
 *  signatures against a key we hand it. It never holds a session, never
 *  queries data, and never downloads keys itself (see jwks-cache.ts). */
let verifierClient: SupabaseClient | null = null;

const JWKS_FETCH_TIMEOUT_MS = 5000;

/** The signing-key cache, one per server instance. Keys are downloaded
 *  from the issuer we validate against — never from a URL in a token. */
let signingKeys: JwksCache | null = null;
function keyCache(): JwksCache {
  signingKeys ??= new JwksCache(async () => {
    const response = await fetch(`${getAuthorizationServerIssuer()}/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`JWKS download failed (${response.status})`);
    return response.json();
  });
  return signingKeys;
}
function verifier(): SupabaseClient {
  verifierClient ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return verifierClient;
}

export async function verifyBearerToken(
  authorization: string | null,
): Promise<{ ok: true; token: VerifiedToken } | { ok: false; failure: TokenFailure }> {
  if (!authorization) return { ok: false, failure: "missing" };
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization.trim());
  if (!match) return { ok: false, failure: "malformed" };
  const accessToken = match[1];

  const header = readJwtHeader(accessToken);
  if (!header || !header.kid || !header.alg || !ALLOWED_ALGORITHMS.includes(header.alg)) {
    return { ok: false, failure: "invalid" };
  }

  try {
    // A known, well-formed key of the right type, or the token is refused.
    const key = await keyCache().getKey(header.kid);
    if (!key || !keyMatchesAlgorithm(key, header.alg)) return { ok: false, failure: "invalid" };

    // Signature and expiry, against exactly that key. Supplying the key set
    // means getClaims never performs its own (uncached) download.
    const { data, error } = await verifier().auth.getClaims(accessToken, { jwks: { keys: [key as never] } });
    if (error || !data?.claims) return { ok: false, failure: "invalid" };

    const checked = validateClaims(data.claims as Record<string, unknown>, {
      issuer: getAuthorizationServerIssuer(),
      audiences: allowedAudiences(),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!checked.ok) return { ok: false, failure: "invalid" };

    return {
      ok: true,
      token: { accessToken, userId: checked.userId, clientId: checked.clientId, expiresAt: checked.expiresAt },
    };
  } catch {
    return { ok: false, failure: "invalid" };
  }
}
