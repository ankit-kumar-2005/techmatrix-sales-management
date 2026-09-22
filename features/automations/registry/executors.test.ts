import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTION_GET_RECORDS, ACTION_LEAD_DEACTIVATE, ACTION_LOOP } from "./definitions";
import { getActionExecutor, type ActionContext } from "./executors";
import { MAX_LOOP_ITERATIONS } from "../config/safeguards";

/**
 * Direct tests of the REAL getRecords/loop executors — the same
 * functions engine.ts calls — not a re-implementation of their logic.
 * Every other executor in this file is tested end-to-end against a real
 * PostgreSQL instance (test/db/*.mjs), which is the right call when the
 * database itself owns the interesting behaviour (tenancy, idempotency,
 * allowlists). Loop's own iteration/budget accounting has NONE of that
 * — it is pure TypeScript orchestration over whatever a mocked
 * context.supabase.rpc and a real registered body action (Deactivate
 * Lead, chosen because it needs no config at all) report back — so a
 * plain unit test against the real code is both sufficient and more
 * direct than standing up a database just to prove a loop counter.
 */

function makeContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    supabase: {
      rpc: async () => ({ data: "deactivated", error: null }),
    } as unknown as ActionContext["supabase"],
    workerToken: "test-token",
    customerId: "cust-1",
    leadId: "lead-1",
    automationId: "auto-1",
    version: 1,
    eventId: "evt-1",
    nodeId: "loop-1",
    facts: { leadId: "lead-1", source: null, hasOwner: false, company: "", contactName: "", fields: {} },
    todayIso: "2026-01-01",
    rootEventId: "root-1",
    correlationId: "corr-1",
    depth: 0,
    recordVariables: new Map(),
    remainingActionBudget: 1000,
    ...overrides,
  };
}

function fakeCollection(size: number) {
  return Array.from({ length: size }, (_, i) => ({ id: `row-${i}` }));
}

describe("loop executor — the iteration cap and its interaction with the shared action budget", () => {
  const loop = getActionExecutor(ACTION_LOOP)!;

  it("caps at MAX_LOOP_ITERATIONS even when the collection is much larger", async () => {
    const context = makeContext({
      recordVariables: new Map([["items", { kind: "collection", object: "task", records: fakeCollection(MAX_LOOP_ITERATIONS * 3) }]]),
    });
    const outcome = await loop(context, {
      collectionVariable: "items",
      itemVariable: "item",
      bodyAction: { type: ACTION_LEAD_DEACTIVATE, config: {} },
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.actionsPerformed, MAX_LOOP_ITERATIONS, "ran exactly the cap, not the collection's real size");
  });

  it("stops early, before MAX_LOOP_ITERATIONS, if the shared per-event budget runs out first", async () => {
    const smallBudget = 5;
    const context = makeContext({
      remainingActionBudget: smallBudget,
      recordVariables: new Map([["items", { kind: "collection", object: "task", records: fakeCollection(MAX_LOOP_ITERATIONS) }]]),
    });
    const outcome = await loop(context, {
      collectionVariable: "items",
      itemVariable: "item",
      bodyAction: { type: ACTION_LEAD_DEACTIVATE, config: {} },
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.actionsPerformed, smallBudget, "a loop cannot spend more of the shared budget than was left, regardless of MAX_LOOP_ITERATIONS");
  });

  it("a large budget AND a large collection both still respect MAX_LOOP_ITERATIONS as the tighter of the two", async () => {
    const context = makeContext({
      remainingActionBudget: 100_000,
      recordVariables: new Map([["items", { kind: "collection", object: "task", records: fakeCollection(100_000) }]]),
    });
    const outcome = await loop(context, {
      collectionVariable: "items",
      itemVariable: "item",
      bodyAction: { type: ACTION_LEAD_DEACTIVATE, config: {} },
    });
    assert.equal(outcome.actionsPerformed, MAX_LOOP_ITERATIONS, "MAX_LOOP_ITERATIONS is the binding constraint when the budget would otherwise allow far more");
  });

  it("stops entirely on the first body failure — does not continue to later items, and does not silently succeed", async () => {
    let calls = 0;
    const context = makeContext({
      supabase: {
        rpc: async () => {
          calls += 1;
          // Fail on the 3rd call specifically.
          if (calls === 3) return { data: "invalid_lead", error: null };
          return { data: "deactivated", error: null };
        },
      } as unknown as ActionContext["supabase"],
      recordVariables: new Map([["items", { kind: "collection", object: "task", records: fakeCollection(10) }]]),
    });
    const outcome = await loop(context, {
      collectionVariable: "items",
      itemVariable: "item",
      bodyAction: { type: ACTION_LEAD_DEACTIVATE, config: {} },
    });
    assert.equal(outcome.ok, false);
    assert.equal(calls, 3, "stopped immediately after the failing call — never attempted a 4th");
  });

  it("fails clearly, not silently, when the named collection variable was never set", async () => {
    const context = makeContext({ recordVariables: new Map() });
    const outcome = await loop(context, {
      collectionVariable: "nonexistent",
      itemVariable: "item",
      bodyAction: { type: ACTION_LEAD_DEACTIVATE, config: {} },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /never set/);
  });

  it("fails clearly when the named variable exists but is a single record, not a collection", async () => {
    const context = makeContext({
      recordVariables: new Map([["items", { kind: "record", object: "task", fields: {} }]]),
    });
    const outcome = await loop(context, {
      collectionVariable: "items",
      itemVariable: "item",
      bodyAction: { type: ACTION_LEAD_DEACTIVATE, config: {} },
    });
    assert.equal(outcome.ok, false);
  });

  it("fails clearly when no body action is attached at all (validate-workflow should have refused this at save time)", async () => {
    const context = makeContext({
      recordVariables: new Map([["items", { kind: "collection", object: "task", records: fakeCollection(3) }]]),
    });
    const outcome = await loop(context, { collectionVariable: "items", itemVariable: "item" });
    assert.equal(outcome.ok, false);
    assert.match(outcome.detail, /no step/i);
  });

  it("an empty collection runs zero times and still reports success", async () => {
    const context = makeContext({
      recordVariables: new Map([["items", { kind: "collection", object: "task", records: [] }]]),
    });
    const outcome = await loop(context, {
      collectionVariable: "items",
      itemVariable: "item",
      bodyAction: { type: ACTION_LEAD_DEACTIVATE, config: {} },
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.actionsPerformed, 0);
  });
});

describe("getRecords executor — filters with the real evaluateFieldGroup engine, writes a real collection variable", () => {
  const getRecords = getActionExecutor(ACTION_GET_RECORDS)!;

  it("only keeps rows the filter actually matches, and stores exactly those in the named variable", async () => {
    const rawRows = [
      { record_json: { subject: "Call Acme", priority: "High" } },
      { record_json: { subject: "Email Beta", priority: "Low" } },
      { record_json: { subject: "Call Charlie", priority: "High" } },
    ];
    const context = makeContext({
      supabase: { rpc: async () => ({ data: rawRows, error: null }) } as unknown as ActionContext["supabase"],
    });
    const outcome = await getRecords(context, {
      object: "task",
      filters: { kind: "group", match: "all", rules: [{ kind: "rule", field: "priority", operator: "equals", value: "High", valueTo: null }] },
      limit: 20,
      resultVariable: "highPriority",
    });
    assert.equal(outcome.ok, true);
    const stored = context.recordVariables.get("highPriority");
    assert.ok(stored && stored.kind === "collection");
    assert.equal(stored.records.length, 2);
    assert.ok(stored.records.every((r) => r.priority === "High"));
  });

  it("an empty filter (no rules) matches every row returned", async () => {
    const rawRows = [{ record_json: { subject: "A" } }, { record_json: { subject: "B" } }];
    const context = makeContext({
      supabase: { rpc: async () => ({ data: rawRows, error: null }) } as unknown as ActionContext["supabase"],
    });
    const outcome = await getRecords(context, {
      object: "task",
      filters: { kind: "group", match: "all", rules: [] },
      limit: 20,
      resultVariable: "all",
    });
    assert.equal(outcome.ok, true);
    const stored = context.recordVariables.get("all");
    assert.ok(stored && stored.kind === "collection");
    assert.equal(stored.records.length, 2);
  });

  it("a database error is reported as a real failure, not silently swallowed", async () => {
    const context = makeContext({
      supabase: { rpc: async () => ({ data: null, error: { code: "500" } }) } as unknown as ActionContext["supabase"],
    });
    const outcome = await getRecords(context, {
      object: "task",
      filters: { kind: "group", match: "all", rules: [] },
      limit: 20,
      resultVariable: "x",
    });
    assert.equal(outcome.ok, false);
    assert.equal(context.recordVariables.has("x"), false);
  });
});
