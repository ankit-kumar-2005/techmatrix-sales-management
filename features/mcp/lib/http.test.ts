import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deniedWithHttp401 } from "./http";

describe("deniedWithHttp401 (R3)", () => {
  it("answers an ended sign-in session with HTTP 401 so the client re-authenticates", () => {
    assert.equal(deniedWithHttp401({ ok: false, reason: "session_ended" }), true);
  });

  it("keeps every other denial inside MCP (no re-auth loop), and never 401s an allowed request", () => {
    for (const reason of ["session_unverified", "connection_blocked", "mcp_disabled", "connection_revoked", "connection_unknown", "membership_inactive", "unavailable"]) {
      assert.equal(deniedWithHttp401({ ok: false, reason }), false, reason);
    }
    assert.equal(deniedWithHttp401({ ok: true }), false);
  });
});
