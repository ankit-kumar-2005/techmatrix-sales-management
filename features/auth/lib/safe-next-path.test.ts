import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeNextPath } from "./safe-next-path";

describe("safeNextPath", () => {
  it("allows the consent screen with its query", () => {
    assert.equal(safeNextPath("/oauth/consent?authorization_id=abc123"), "/oauth/consent?authorization_id=abc123");
  });

  it("refuses everything else", () => {
    for (const raw of [
      undefined,
      "",
      "https://evil.example/oauth/consent",
      "//evil.example/oauth/consent",
      "/\\evil.example",
      "/sales-management",
      "/oauth/consent-phish",
      "/oauth/consent/../../settings",
      "javascript:alert(1)",
      `/oauth/consent?x=${"a".repeat(600)}`,
    ]) {
      assert.equal(safeNextPath(raw), null, String(raw));
    }
  });
});
