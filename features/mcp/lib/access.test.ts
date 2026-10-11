import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MCP_TOOLS } from "../registry/index";
import {
  authorizeToolCall,
  evaluateAccess,
  isToolEnabledForCompany,
  listVisibleTools,
  parseMcpContext,
  type McpContext,
} from "./access";

const base: McpContext = {
  session_state: "active",
  customer_id: "cust-a",
  customer_user_id: "cu-rep",
  user_name: "Rep",
  company_name: "Company A",
  role: "SALES_REP",
  mcp_enabled: true,
  allow_writes: false,
  tool_overrides: {},
  person_blocked: false,
  connection: { id: "conn-1", revoked: false, last_used_at: null },
};

const ctx = (overrides: Partial<McpContext> = {}): McpContext => ({ ...base, ...overrides });

describe("parseMcpContext", () => {
  it("returns null for anything that is not a well-formed context", () => {
    for (const raw of [null, undefined, "x", {}, { customer_id: "a" }, { ...base, role: "SUPERUSER" }]) {
      assert.equal(parseMcpContext(raw), null);
    }
  });

  it("treats a missing block/revoke flag as blocked/revoked (fails closed)", () => {
    const parsed = parseMcpContext({ ...base, person_blocked: undefined, connection: { id: "c" } });
    assert.equal(parsed?.person_blocked, true);
    assert.equal(parsed?.connection?.revoked, true);
  });

  it("keeps only boolean tool overrides", () => {
    const parsed = parseMcpContext({ ...base, tool_overrides: { search_leads: false, create_task: "yes" } });
    assert.deepEqual(parsed?.tool_overrides, { search_leads: false });
  });
});

describe("evaluateAccess", () => {
  it("refuses a person with no active membership", () => {
    assert.equal(evaluateAccess(null).ok, false);
    assert.equal((evaluateAccess(null) as { reason: string }).reason, "membership_inactive");
  });

  it("refuses when the company has MCP off", () => {
    assert.deepEqual(
      (evaluateAccess(ctx({ mcp_enabled: false })) as { reason: string }).reason,
      "mcp_disabled",
    );
  });

  it("refuses a blocked person even with MCP on, a live connection, and before any connection exists", () => {
    assert.equal((evaluateAccess(ctx({ person_blocked: true })) as { reason: string }).reason, "connection_blocked");
    assert.equal(
      (evaluateAccess(ctx({ person_blocked: true, connection: null })) as { reason: string }).reason,
      "connection_blocked",
    );
  });

  it("keeps the person's context on a denial so the refusal can be audited", () => {
    const decision = evaluateAccess(ctx({ person_blocked: true }));
    assert.equal(decision.ok ? null : decision.context?.customer_user_id, base.customer_user_id);
  });

  it("refuses a connection the person disconnected, and one never approved through consent", () => {
    assert.equal(
      (evaluateAccess(ctx({ connection: { ...base.connection!, revoked: true } })) as { reason: string }).reason,
      "connection_revoked",
    );
    assert.equal((evaluateAccess(ctx({ connection: null })) as { reason: string }).reason, "connection_unknown");
  });

  it("allows an active member of an enabled company with a live connection", () => {
    assert.equal(evaluateAccess(ctx()).ok, true);
  });
});

describe("tool availability", () => {
  const readTools = MCP_TOOLS.filter((tool) => tool.kind === "read").map((tool) => tool.name).sort();
  const writeTools = MCP_TOOLS.filter((tool) => tool.kind === "write").map((tool) => tool.name).sort();

  it("lists every read tool and no write tool by default", () => {
    assert.deepEqual(listVisibleTools(ctx()).map((tool) => tool.name).sort(), readTools);
  });

  it("keeps write tools hidden even when enabled individually, while 'Allow changes' is off", () => {
    const overrides = Object.fromEntries(writeTools.map((name) => [name, true]));
    assert.deepEqual(listVisibleTools(ctx({ tool_overrides: overrides })).map((tool) => tool.name).sort(), readTools);
  });

  it("lists a write tool only when 'Allow changes' is on AND the tool is enabled", () => {
    const visible = listVisibleTools(ctx({ allow_writes: true, tool_overrides: { create_task: true } })).map((t) => t.name);
    assert.ok(visible.includes("create_task"));
    assert.ok(!visible.includes("update_task"));
  });

  it("hides a read tool an admin switched off", () => {
    const visible = listVisibleTools(ctx({ tool_overrides: { search_leads: false } })).map((t) => t.name);
    assert.ok(!visible.includes("search_leads"));
  });

  it("lists nothing when the company has MCP off", () => {
    for (const tool of MCP_TOOLS) assert.equal(isToolEnabledForCompany(tool, ctx({ mcp_enabled: false })), false);
  });
});

describe("authorizeToolCall — re-checked on every call", () => {
  it("rejects a tool the admin disabled, even if the client still has it cached", () => {
    const decision = authorizeToolCall(ctx({ tool_overrides: { search_leads: false } }), "search_leads");
    assert.deepEqual(decision.ok ? null : decision.code, "tool_disabled");
  });

  it("rejects every write tool while 'Allow changes' is off, whatever the tool override says", () => {
    for (const tool of MCP_TOOLS.filter((t) => t.kind === "write")) {
      const decision = authorizeToolCall(ctx({ tool_overrides: { [tool.name]: true } }), tool.name);
      assert.equal(decision.ok ? null : decision.code, "tool_disabled", tool.name);
    }
  });

  it("rejects an unknown tool name", () => {
    const decision = authorizeToolCall(ctx(), "delete_lead");
    assert.equal(decision.ok ? null : decision.code, "invalid_input");
  });

  it("allows an enabled write tool once changes are allowed", () => {
    assert.equal(authorizeToolCall(ctx({ allow_writes: true, tool_overrides: { create_task: true } }), "create_task").ok, true);
  });
});

describe("session liveness (R3)", () => {
  const reason = (overrides: Partial<McpContext>) => {
    const decision = evaluateAccess(ctx(overrides));
    return decision.ok ? "ok" : decision.reason;
  };

  it("accepts only an active sign-in session", () => {
    assert.equal(reason({ session_state: "active" }), "ok");
  });

  it("refuses a token whose session ended (signed out, timed out, banned) before any other check", () => {
    assert.equal(reason({ session_state: "ended" }), "session_ended");
    assert.equal(reason({ session_state: "ended", person_blocked: true, mcp_enabled: false }), "session_ended");
  });

  it("refuses, rather than allows, a session it could not verify", () => {
    assert.equal(reason({ session_state: "missing_claim" }), "session_unverified");
    assert.equal(reason({ session_state: "unknown" }), "session_unverified");
  });

  it("parses a missing or unrecognised session_state as unknown (fails closed)", () => {
    const { session_state: _omit, ...withoutState } = base;
    void _omit;
    assert.equal(parseMcpContext(withoutState)?.session_state, "unknown");
    assert.equal(parseMcpContext({ ...base, session_state: "maybe" })?.session_state, "unknown");
    assert.equal(parseMcpContext({ ...base, session_state: "active" })?.session_state, "active");
  });
});
