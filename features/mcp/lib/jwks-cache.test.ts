import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MCP_JWKS_CACHE_TTL_SECONDS,
  MCP_JWKS_MAX_KEYS,
  MCP_JWKS_MAX_STALE_SECONDS,
  MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS,
} from "../config/limits";
import { JwksCache, keyMatchesAlgorithm, parseJwks, type SigningKey } from "./jwks-cache";

const EC_KEY = { kid: "k1", kty: "EC", crv: "P-256", alg: "ES256", use: "sig", x: "x", y: "y", key_ops: ["verify"] };
const EC_KEY_2 = { ...EC_KEY, kid: "k2" };

function harness(responses: Array<unknown | Error>) {
  let now = 1_000_000;
  let fetches = 0;
  const cache = new JwksCache(async () => {
    fetches += 1;
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    return next;
  }, () => now);
  return {
    cache,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
    fetches: () => fetches,
  };
}

describe("parseJwks", () => {
  it("keeps only well-formed signature-verification public keys", () => {
    const keys = parseJwks({
      keys: [
        EC_KEY,
        { ...EC_KEY, kid: "enc", use: "enc" },
        { ...EC_KEY, kid: "hs", kty: "oct", alg: "HS256" },
        { ...EC_KEY, kid: "private", d: "secret" },
        { ...EC_KEY, kid: "sign-only", key_ops: ["sign"] },
        { kty: "EC" },
      ],
    });
    assert.deepEqual(keys?.map((k) => k.kid), ["k1"]);
  });

  it("rejects malformed or oversized documents", () => {
    assert.equal(parseJwks(null), null);
    assert.equal(parseJwks({ keys: [] }), null);
    assert.equal(parseJwks({ keys: Array.from({ length: MCP_JWKS_MAX_KEYS + 1 }, (_, i) => ({ ...EC_KEY, kid: `k${i}` })) }), null);
  });
});

describe("keyMatchesAlgorithm", () => {
  it("binds ES256 to P-256 EC keys and RS256 to RSA keys", () => {
    assert.equal(keyMatchesAlgorithm(EC_KEY as SigningKey, "ES256"), true);
    assert.equal(keyMatchesAlgorithm(EC_KEY as SigningKey, "RS256"), false);
    assert.equal(keyMatchesAlgorithm({ kid: "r", kty: "RSA" } as SigningKey, "RS256"), true);
    assert.equal(keyMatchesAlgorithm({ ...EC_KEY, crv: "P-384" } as SigningKey, "ES256"), false);
  });
});

describe("JwksCache", () => {
  it("serves a known key from cache without re-downloading", async () => {
    const h = harness([{ keys: [EC_KEY] }]);
    assert.equal((await h.cache.getKey("k1"))?.kid, "k1");
    assert.equal((await h.cache.getKey("k1"))?.kid, "k1");
    assert.equal(h.fetches(), 1);
  });

  it("does not download once per unknown kid: at most one download per window, whatever the kid", async () => {
    const h = harness([{ keys: [EC_KEY] }]);
    await h.cache.getKey("k1");
    for (let i = 0; i < 50; i++) assert.equal(await h.cache.getKey(`random-${i}`), null);
    assert.equal(h.fetches(), 1, "the initial download already used this window");
    h.advance(MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS);
    for (let i = 0; i < 50; i++) assert.equal(await h.cache.getKey(`random-again-${i}`), null);
    assert.equal(h.fetches(), 2, "exactly one more download in the next window");
  });

  it("picks up a newly rotated-in key through the unknown-kid refresh, within one window", async () => {
    const h = harness([{ keys: [EC_KEY] }, { keys: [EC_KEY, EC_KEY_2] }]);
    await h.cache.getKey("k1");
    assert.equal(await h.cache.getKey("k2"), null);
    h.advance(MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS);
    assert.equal((await h.cache.getKey("k2"))?.kid, "k2");
  });

  it("refreshes after the TTL", async () => {
    const h = harness([{ keys: [EC_KEY] }]);
    await h.cache.getKey("k1");
    h.advance(MCP_JWKS_CACHE_TTL_SECONDS + 1);
    await h.cache.getKey("k1");
    assert.equal(h.fetches(), 2);
  });

  it("returns no key when the first download fails, and backs off before retrying", async () => {
    const h = harness([new Error("network down")]);
    assert.equal(await h.cache.getKey("k1"), null);
    assert.equal(await h.cache.getKey("k1"), null);
    assert.equal(h.fetches(), 1);
    h.advance(MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS);
    assert.equal(await h.cache.getKey("k1"), null);
    assert.equal(h.fetches(), 2);
  });

  it("keeps using downloaded keys briefly when a refresh fails, then refuses everything", async () => {
    const h = harness([{ keys: [EC_KEY] }, new Error("network down")]);
    await h.cache.getKey("k1");
    h.advance(MCP_JWKS_CACHE_TTL_SECONDS + 1);
    assert.equal((await h.cache.getKey("k1"))?.kid, "k1", "within the stale window");
    h.advance(MCP_JWKS_MAX_STALE_SECONDS);
    assert.equal(await h.cache.getKey("k1"), null, "beyond the stale window nothing verifies");
  });

  it("treats a malformed document as a failed download", async () => {
    const h = harness([{ nope: true }]);
    assert.equal(await h.cache.getKey("k1"), null);
  });
});
