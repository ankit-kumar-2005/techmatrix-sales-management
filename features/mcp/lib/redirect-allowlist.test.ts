import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkRedirectUri } from "./redirect-allowlist";

describe("checkRedirectUri", () => {
  it("allows Claude's hosted callbacks exactly", () => {
    assert.deepEqual(checkRedirectUri("https://claude.ai/api/mcp/auth_callback", []), {
      allowed: true,
      host: "claude.ai",
      isLoopback: false,
    });
    assert.equal(checkRedirectUri("https://claude.com/api/mcp/auth_callback", []).allowed, true);
  });

  it("ignores query and fragment when matching", () => {
    assert.equal(checkRedirectUri("https://claude.ai/api/mcp/auth_callback?x=1#y", []).allowed, true);
  });

  it("refuses look-alikes of the hosted callback", () => {
    for (const uri of [
      "http://claude.ai/api/mcp/auth_callback",
      "https://claude.ai.evil.example/api/mcp/auth_callback",
      "https://evil.example/api/mcp/auth_callback",
      "https://claude.ai/api/mcp/auth_callback/../steal",
      "https://claude.ai:8443/api/mcp/auth_callback",
      "https://user:pass@claude.ai/api/mcp/auth_callback",
    ]) {
      assert.equal(checkRedirectUri(uri, []).allowed, false, uri);
    }
  });

  it("allows Claude Code's loopback redirect on any port, only on /callback", () => {
    assert.deepEqual(checkRedirectUri("http://localhost:53682/callback", []), {
      allowed: true,
      host: "localhost",
      isLoopback: true,
    });
    assert.equal(checkRedirectUri("http://127.0.0.1:3118/callback", []).allowed, true);
    assert.equal(checkRedirectUri("http://localhost:3118/oauth/callback", []).allowed, false);
    assert.equal(checkRedirectUri("http://192.168.1.10:3118/callback", []).allowed, false);
    assert.equal(checkRedirectUri("http://localhost.evil.example:3118/callback", []).allowed, false);
  });

  it("refuses non-web schemes and garbage", () => {
    for (const uri of ["javascript:alert(1)", "file:///etc/passwd", "custom-app://callback", "not a url", ""]) {
      assert.equal(checkRedirectUri(uri, []).allowed, false, uri);
    }
  });

  it("allows an operator-added exact URI and nothing near it", () => {
    const extra = ["http://localhost:6274/oauth/callback"];
    assert.equal(checkRedirectUri("http://localhost:6274/oauth/callback", extra).allowed, true);
    assert.equal(checkRedirectUri("http://localhost:6275/oauth/callback", extra).allowed, false);
  });
});
