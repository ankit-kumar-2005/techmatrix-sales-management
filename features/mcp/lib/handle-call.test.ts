import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeSupabase, eqValue, type RecordedCall } from "@/test/fake-supabase";
import { MCP_RATE_LIMIT_MAX_CALLS } from "../config/limits";
import { evaluateAccess, type McpContext } from "./access";
import { handleToolCall, type McpSession } from "./handle-call";

/**
 * tools/call end to end, against a recording fake database. The fake
 * plays PostgREST's part (including RLS-style "row not visible" answers);
 * what is asserted is what the MCP layer itself decides and sends.
 */

const LEAD_A = "11111111-1111-4111-8111-111111111111";
const LEAD_HIDDEN = "99999999-9999-4999-8999-999999999999";
const REP = "22222222-2222-4222-8222-222222222222";
const OUTSIDER = "33333333-3333-4333-8333-333333333333";

const baseContext: McpContext = {
  session_state: "active",
  customer_id: "cust-a",
  customer_user_id: REP,
  user_name: "Rep",
  company_name: "Company A",
  role: "SALES_REP",
  mcp_enabled: true,
  allow_writes: false,
  tool_overrides: {},
  person_blocked: false,
  connection: { id: "conn-1", revoked: false, last_used_at: null },
};

type DbState = {
  recentCalls: number;
  leads: Record<string, unknown>[];
  idempotency: Map<string, { tool_name: string; status: string; record_id: string | null; updated_at: string }>;
  /** Task ids the caller can see through RLS (created ones are added). */
  visibleTasks: Set<string>;
  taskInsertError?: boolean;
};

const NOW = "2026-10-10T10:00:00.000Z";

function harness(contextOverrides: Partial<McpContext> | null = {}, state: Partial<DbState> = {}) {
  const db: DbState = { recentCalls: 0, leads: [], idempotency: new Map(), visibleTasks: new Set(), ...state };
  const audits: Record<string, unknown>[] = [];
  const afterTasks: Array<() => Promise<void>> = [];
  let taskCounter = 0;

  const { client, calls } = createFakeSupabase((call: RecordedCall) => {
    const payload = call.payload as Record<string, unknown>;
    switch (call.table) {
      case "mcp_audit_log":
        if (call.op === "insert") {
          audits.push(payload);
          return { data: null, error: null };
        }
        return { data: null, error: null, count: db.recentCalls };
      case "mcp_idempotency_keys": {
        if (call.op === "insert") {
          const key = String(payload.idempotency_key);
          if (db.idempotency.has(key)) return { data: null, error: { code: "23505", message: "duplicate" } };
          db.idempotency.set(key, { tool_name: String(payload.tool_name), status: "pending", record_id: null, updated_at: NOW });
          return { data: null, error: null };
        }
        const key = String(eqValue(call, "idempotency_key"));
        const row = db.idempotency.get(key);
        if (call.op === "update" && row) Object.assign(row, payload);
        return { data: row ?? null, error: null };
      }
      case "leads":
        if (call.op === "select" && call.terminal === "maybeSingle") {
          return { data: db.leads.find((lead) => lead.id === eqValue(call, "id")) ?? null, error: null };
        }
        return { data: db.leads, error: null };
      case "tasks":
        if (call.op === "insert") {
          if (db.taskInsertError) return { data: null, error: { message: "new row violates row-level security policy" } };
          taskCounter += 1;
          const id = `00000000-0000-4000-8000-00000000000${taskCounter}`;
          db.visibleTasks.add(id);
          return { data: { id }, error: null };
        }
        if (call.op === "select" && call.terminal === "maybeSingle") {
          const id = String(eqValue(call, "id"));
          return { data: db.visibleTasks.has(id) && eqValue(call, "customer_id") === "cust-a" ? { id } : null, error: null };
        }
        return { data: [], error: null };
      default:
        return { data: [], error: null };
    }
  });

  const context = contextOverrides === null ? null : { ...baseContext, ...contextOverrides };
  const session: McpSession = {
    userId: "auth-rep",
    clientId: "client-1",
    supabase: client,
    access: evaluateAccess(context),
    afterResponse: (task) => afterTasks.push(task),
    now: () => new Date(NOW),
  };

  const call = async (name: string, args: unknown) => {
    const result = await handleToolCall(session, name, args);
    return { result, body: JSON.parse(result.content[0].text) as Record<string, unknown> };
  };

  return { call, calls, audits, afterTasks, db };
}

const errorCode = (body: Record<string, unknown>) => (body.error as { code?: string } | undefined)?.code;

describe("access is re-evaluated per request", () => {
  it("refuses every call when the company has MCP off, and audits the refusal", async () => {
    const h = harness({ mcp_enabled: false });
    const { result, body } = await h.call("search_leads", {});
    assert.equal(result.isError, true);
    assert.equal(errorCode(body), "access_denied");
    assert.equal(h.audits[0].status, "denied");
    assert.equal(h.audits[0].error_code, "mcp_disabled");
    assert.equal(h.calls.filter((c) => c.table === "leads").length, 0);
  });

  it("refuses a blocked person and a disconnected connection", async () => {
    assert.equal(errorCode((await harness({ person_blocked: true }).call("search_leads", {})).body), "access_denied");
    const revoked = harness({ connection: { ...baseContext.connection!, revoked: true } });
    assert.equal(errorCode((await revoked.call("search_leads", {})).body), "access_denied");
  });

  it("refuses a person with no active membership without touching any table", async () => {
    const h = harness(null);
    assert.equal(errorCode((await h.call("search_leads", {})).body), "access_denied");
    assert.equal(h.calls.length, 0);
  });
});

describe("tool availability is enforced at call time", () => {
  it("rejects a tool the admin disabled even when the client calls it from a cached list", async () => {
    const h = harness({ tool_overrides: { search_leads: false } });
    const { body } = await h.call("search_leads", {});
    assert.equal(errorCode(body), "tool_disabled");
    assert.equal(h.audits[0].status, "denied");
  });

  it("rejects a write tool while 'Allow changes' is off", async () => {
    const h = harness({ tool_overrides: { create_task: true } });
    const { body } = await h.call("create_task", { subject: "x", lead_id: LEAD_A, due_date: "2026-10-12" });
    assert.equal(errorCode(body), "tool_disabled");
    assert.equal(h.calls.filter((c) => c.table === "tasks").length, 0);
  });
});

describe("rate limiting", () => {
  it("stops the call at the configured limit and records rate_limited", async () => {
    const h = harness({}, { recentCalls: MCP_RATE_LIMIT_MAX_CALLS });
    const { body } = await h.call("search_leads", {});
    assert.equal(errorCode(body), "rate_limited");
    assert.equal(h.audits[0].status, "rate_limited");
    assert.equal(h.calls.filter((c) => c.table === "leads").length, 0);
  });

  it("allows the call one below the limit", async () => {
    const h = harness({}, { recentCalls: MCP_RATE_LIMIT_MAX_CALLS - 1 });
    assert.equal((await h.call("search_leads", {})).result.isError, undefined);
  });
});

describe("inputs", () => {
  it("rejects an unregistered filter field and audits field NAMES only, never values", async () => {
    const h = harness();
    const secret = "very-private-search-text";
    const { body } = await h.call("search_leads", { filters: [{ field: "customer_id", operator: "equals", value: secret }] });
    assert.equal(errorCode(body), "invalid_input");
    assert.equal(h.audits[0].status, "invalid");
    assert.deepEqual(h.audits[0].field_names, ["filters"]);
    assert.ok(!JSON.stringify(h.audits).includes(secret));
  });

  it("ignores customer_id/owner_id/role sent as arguments", async () => {
    const h = harness();
    await h.call("search_leads", { customer_id: "cust-b", owner_id: OUTSIDER, role: "ADMIN" });
    const leadsQuery = h.calls.find((c) => c.table === "leads") as RecordedCall;
    assert.equal(eqValue(leadsQuery, "customer_id"), "cust-a");
    assert.equal(eqValue(leadsQuery, "owner_id"), undefined);
    // The attempt is visible to admins by name in the audit row.
    assert.deepEqual((h.audits[0].field_names as string[]).sort(), ["customer_id", "owner_id", "role"]);
  });
});

describe("reads", () => {
  it("returns the same not_found for a hidden record as for a missing one", async () => {
    const h = harness({}, { leads: [{ id: LEAD_A, contact_name: "Visible" }] });
    const hidden = await h.call("get_lead", { id: LEAD_HIDDEN });
    assert.equal(errorCode(hidden.body), "not_found");
    assert.equal((hidden.body.error as { message: string }).message, "No matching record was found, or you don't have access to it.");
  });

  it("never returns non-allowlisted columns, even if the database sent them", async () => {
    const h = harness({}, {
      leads: [{ id: LEAD_A, contact_name: "Priya", customer_id: "cust-a", webhook_token: "tok", notes: "free text", deal_value: 18000 }],
    });
    const { body } = await h.call("search_leads", {});
    const text = JSON.stringify(body);
    for (const leaked of ["cust-a", "tok", "free text", "webhook_token", "customer_id"]) assert.ok(!text.includes(leaked), leaked);
    assert.equal((body.leads as Array<Record<string, unknown>>)[0].deal_value_formatted, "₹18,000");
    assert.equal(h.audits[0].status, "ok");
    assert.deepEqual(h.audits[0].record_ids, [LEAD_A]);
  });
});

describe("writes", () => {
  const writable = { allow_writes: true, tool_overrides: { create_task: true } };
  const task = { subject: "Call Priya", lead_id: LEAD_A, due_date: "2026-10-12" };

  it("creates through the shared domain service with the actor's own ids", async () => {
    const h = harness(writable);
    const { body } = await h.call("create_task", { ...task, customer_id: "cust-b" });
    assert.equal(body.created, true);
    const insert = h.calls.find((c) => c.table === "tasks" && c.op === "insert") as RecordedCall;
    const payload = insert.payload as Record<string, unknown>;
    assert.equal(payload.customer_id, "cust-a");
    assert.equal(payload.created_by, "auth-rep");
    assert.equal(payload.assigned_to, REP);
  });

  it("surfaces the UI's own message when RLS refuses the lead or assignee", async () => {
    const h = harness(writable, { taskInsertError: true });
    const { body } = await h.call("create_task", { ...task, assignee_id: OUTSIDER });
    assert.equal(errorCode(body), "forbidden");
    assert.equal((body.error as { message: string }).message, "Unable to create this task. The lead or assignee may not be available to you.");
  });

  it("creates one record for one idempotency key, however many times it is sent", async () => {
    const h = harness(writable);
    const first = await h.call("create_task", { ...task, idempotency_key: "retry-key-0001" });
    const second = await h.call("create_task", { ...task, idempotency_key: "retry-key-0001" });
    assert.equal(h.calls.filter((c) => c.table === "tasks" && c.op === "insert").length, 1);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.id, first.body.id);
  });

  it("frees the key for a retry when the first attempt failed", async () => {
    const h = harness(writable, { taskInsertError: true });
    await h.call("create_task", { ...task, idempotency_key: "retry-key-0002" });
    assert.equal(h.db.idempotency.get("retry-key-0002")?.status, "failed");
    h.db.taskInsertError = false;
    const retry = await h.call("create_task", { ...task, idempotency_key: "retry-key-0002" });
    assert.equal(retry.body.created, true);
  });

  it("refuses an idempotency key reused for a different action", async () => {
    const h = harness({ allow_writes: true, tool_overrides: { create_task: true, create_contact: true } });
    await h.call("create_task", { ...task, idempotency_key: "retry-key-0003" });
    const { body } = await h.call("create_contact", { name: "Grace", lead_id: LEAD_A, idempotency_key: "retry-key-0003" });
    assert.equal(errorCode(body), "invalid_input");
  });
});

describe("idempotency hardening (L1, L2)", () => {
  const writable = { allow_writes: true, tool_overrides: { create_task: true } };
  const task = { subject: "Call Priya", lead_id: LEAD_A, due_date: "2026-10-12" };

  it("refuses to replay a forged 'succeeded' reservation whose record the caller cannot see", async () => {
    const forgedId = "44444444-4444-4444-8444-444444444444";
    const h = harness(writable, {
      idempotency: new Map([["forged-key-0001", { tool_name: "create_task", status: "succeeded", record_id: forgedId, updated_at: NOW }]]),
    });
    const { body } = await h.call("create_task", { ...task, idempotency_key: "forged-key-0001" });
    assert.equal(errorCode(body), "not_found");
    assert.equal(h.calls.filter((c) => c.table === "tasks" && c.op === "insert").length, 0);
    // The replay check went through the normal RLS read path, scoped to the caller's company.
    const check = h.calls.find((c) => c.table === "tasks" && c.op === "select") as RecordedCall;
    assert.equal(eqValue(check, "id"), forgedId);
    assert.equal(eqValue(check, "customer_id"), "cust-a");
  });

  it("refuses to replay a reservation with no record id", async () => {
    const h = harness(writable, {
      idempotency: new Map([["empty-key-0001", { tool_name: "create_task", status: "succeeded", record_id: null, updated_at: NOW }]]),
    });
    assert.equal(errorCode((await h.call("create_task", { ...task, idempotency_key: "empty-key-0001" })).body), "not_found");
  });

  it("tells the caller to check and use a new key when a reservation was abandoned, without retrying", async () => {
    const stale = new Date(new Date(NOW).getTime() - 16 * 60_000).toISOString();
    const h = harness(writable, {
      idempotency: new Map([["stale-key-0001", { tool_name: "create_task", status: "pending", record_id: null, updated_at: stale }]]),
    });
    const { body } = await h.call("create_task", { ...task, idempotency_key: "stale-key-0001" });
    assert.equal(errorCode(body), "conflict");
    assert.match((body.error as { message: string }).message, /never finished/);
    assert.equal(h.calls.filter((c) => c.table === "tasks" && c.op === "insert").length, 0);
    assert.equal(h.db.idempotency.get("stale-key-0001")?.status, "pending");
  });

  it("reports a recent pending reservation as still in progress", async () => {
    const h = harness(writable, {
      idempotency: new Map([["busy-key-00001", { tool_name: "create_task", status: "pending", record_id: null, updated_at: NOW }]]),
    });
    const { body } = await h.call("create_task", { ...task, idempotency_key: "busy-key-00001" });
    assert.match((body.error as { message: string }).message, /still being processed/);
  });

  it("creates a new record on every call when no key is sent (the server never invents one)", async () => {
    const h = harness(writable);
    await h.call("create_task", task);
    await h.call("create_task", task);
    assert.equal(h.calls.filter((c) => c.table === "tasks" && c.op === "insert").length, 2);
    assert.equal(h.calls.filter((c) => c.table === "mcp_idempotency_keys").length, 0);
  });
});

describe("audit privacy (L6, L7)", () => {
  it("stores a SHA-256 of the idempotency key, never the key", async () => {
    const h = harness({ allow_writes: true, tool_overrides: { create_task: true } });
    const key = "priya.shah:9876543210";
    await h.call("create_task", { subject: "x", lead_id: LEAD_A, due_date: "2026-10-12", idempotency_key: key });
    const row = h.audits[0];
    assert.match(String(row.idempotency_key_sha256), /^[0-9a-f]{64}$/);
    assert.equal("idempotency_key" in row, false);
    assert.ok(!JSON.stringify(h.audits).includes(key));
    assert.ok(!JSON.stringify(h.audits).includes("9876543210"));
  });

  it("records only the tool's own parameter names plus identity names", async () => {
    const h = harness();
    await h.call("search_leads", { limit: 5, priya_shah_phone: "x", owner_id: "y", made_up_field: 1 });
    assert.deepEqual((h.audits[0].field_names as string[]).sort(), ["limit", "owner_id"]);
  });

  it("records only identity names for an unknown tool", async () => {
    const h = harness();
    await h.call("delete_everything", { customer_id: "x", secret_note: "y" });
    assert.deepEqual(h.audits[0].field_names, ["customer_id"]);
  });
});
