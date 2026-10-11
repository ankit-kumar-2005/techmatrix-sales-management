import assert from "node:assert/strict";
import { describe, it } from "node:test";
import nextConfig from "@/next.config";

/**
 * M1 — the consent screen must not be frameable. Asserts the header rules
 * Next.js will apply; the live response headers are checked separately
 * against `next start` (see docs/mcp.md, "Reproducing the automated tests").
 */
describe("OAuth consent anti-framing headers", () => {
  it("sends X-Frame-Options DENY and frame-ancestors 'none' on /oauth and everything under it, and nowhere else", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    assert.deepEqual(rules.map((rule) => rule.source).sort(), ["/oauth", "/oauth/:path*"]);
    for (const rule of rules) {
      const headers = Object.fromEntries(rule.headers.map((h) => [h.key.toLowerCase(), h.value]));
      assert.equal(headers["x-frame-options"], "DENY");
      assert.equal(headers["content-security-policy"], "frame-ancestors 'none'");
    }
  });
});
