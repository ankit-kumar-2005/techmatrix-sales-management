import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readJwtHeader, validateClaims, verifyBearerToken } from "./verify-token";

const ISSUER = "https://example.supabase.co/auth/v1";
const RESOURCE = "https://app.example.com/api/mcp";
const now = 1_800_000_000;
const expected = { issuer: ISSUER, audiences: ["authenticated", RESOURCE], nowSeconds: now };

const good = {
  iss: ISSUER,
  sub: "4f5d2c1a-1111-4222-8333-444455556666",
  role: "authenticated",
  aud: "authenticated",
  client_id: "a137e659-f4e8-44c2-bf0b-92e867bace25",
  exp: now + 3600,
  is_anonymous: false,
};

describe("validateClaims", () => {
  it("accepts an OAuth-issued user token", () => {
    assert.deepEqual(validateClaims(good, expected), {
      ok: true,
      userId: good.sub,
      clientId: good.client_id,
      expiresAt: good.exp,
    });
  });

  it("accepts the resource URL as the audience (array or string)", () => {
    assert.equal(validateClaims({ ...good, aud: [RESOURCE] }, expected).ok, true);
    assert.equal(validateClaims({ ...good, aud: RESOURCE }, expected).ok, true);
  });

  it("rejects an ordinary app session token (no client_id)", () => {
    const { client_id: _omit, ...session } = good;
    void _omit;
    assert.equal(validateClaims(session, expected).ok, false);
  });

  it("rejects an expired token", () => {
    assert.equal(validateClaims({ ...good, exp: now }, expected).ok, false);
    assert.equal(validateClaims({ ...good, exp: undefined }, expected).ok, false);
  });

  it("rejects a token from another issuer", () => {
    assert.equal(validateClaims({ ...good, iss: "https://evil.supabase.co/auth/v1" }, expected).ok, false);
  });

  it("rejects a token for another audience, even mixed with a valid one", () => {
    assert.equal(validateClaims({ ...good, aud: "https://other.example/api/mcp" }, expected).ok, false);
    assert.equal(validateClaims({ ...good, aud: ["authenticated", "https://other.example"] }, expected).ok, false);
    assert.equal(validateClaims({ ...good, aud: [] }, expected).ok, false);
  });

  it("rejects anon, service-role and anonymous-user tokens", () => {
    assert.equal(validateClaims({ ...good, role: "anon" }, expected).ok, false);
    assert.equal(validateClaims({ ...good, role: "service_role" }, expected).ok, false);
    assert.equal(validateClaims({ ...good, is_anonymous: true }, expected).ok, false);
  });

  it("rejects a non-uuid subject and an oversized client id", () => {
    assert.equal(validateClaims({ ...good, sub: "admin" }, expected).ok, false);
    assert.equal(validateClaims({ ...good, client_id: "x".repeat(256) }, expected).ok, false);
    assert.equal(validateClaims({ ...good, client_id: "" }, expected).ok, false);
  });
});

describe("readJwtHeader", () => {
  it("reads a well-formed header and refuses garbage", () => {
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "k1" })).toString("base64url");
    assert.deepEqual(readJwtHeader(`${header}.e30.sig`), { alg: "ES256", kid: "k1" });
    assert.equal(readJwtHeader("not-a-jwt"), null);
    assert.equal(readJwtHeader("!!!.e30.sig"), null);
  });
});

describe("verifyBearerToken — rejects before any network call", () => {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

  it("reports a missing header as missing", async () => {
    assert.deepEqual(await verifyBearerToken(null), { ok: false, failure: "missing" });
  });

  it("refuses a non-Bearer or malformed header", async () => {
    assert.deepEqual(await verifyBearerToken("Basic abc"), { ok: false, failure: "malformed" });
    assert.deepEqual(await verifyBearerToken("Bearer not.a"), { ok: false, failure: "malformed" });
    assert.deepEqual(await verifyBearerToken("Bearer a.b.c d"), { ok: false, failure: "malformed" });
  });

  it("refuses HS256, alg=none and kid-less tokens without verifying them", async () => {
    const payload = encode(good);
    for (const header of [{ alg: "HS256", kid: "k" }, { alg: "none", kid: "k" }, { alg: "ES256" }]) {
      assert.deepEqual(await verifyBearerToken(`Bearer ${encode(header)}.${payload}.c2ln`), { ok: false, failure: "invalid" });
    }
  });
});
