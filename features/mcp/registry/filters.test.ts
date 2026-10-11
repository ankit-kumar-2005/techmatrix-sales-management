import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeSupabase } from "@/test/fake-supabase";
import { MCP_MAX_FILTER_CONDITIONS, MCP_MAX_IN_VALUES } from "../config/limits";
import { McpToolError } from "../lib/errors";
import { LEAD_FILTERS, TASK_FILTERS } from "./fields";
import { applyConditions, applySortAndLimit, toContainsPattern, validateFilters, type FilterableQuery } from "./filters";

function rejectsWith(fn: () => unknown, pattern: RegExp) {
  assert.throws(fn, (error: unknown) => error instanceof McpToolError && error.code === "invalid_input" && pattern.test(error.message));
}

function captureQuery(build: (q: FilterableQuery) => FilterableQuery) {
  const { client, calls } = createFakeSupabase(() => ({ data: [], error: null }));
  const query = build(client.from("leads").select("id") as unknown as FilterableQuery);
  return { query, calls, settle: () => (query as unknown as PromiseLike<unknown>).then(() => calls[0]) };
}

describe("validateFilters — only registered fields and operators", () => {
  it("rejects an unregistered field, including real columns that are not allowlisted", () => {
    for (const field of ["customer_id", "external_source_id", "notes", "owner_id", "1=1", "company; drop table leads"]) {
      rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field, operator: "equals", value: "x" }]), /not a field you can filter on/);
    }
  });

  it("rejects an unknown operator and an operator the field's type does not support", () => {
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "company", operator: "like", value: "x" }]), /not a supported operator/);
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "company", operator: "greater_than", value: "x" }]), /cannot be used/);
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "deal_value", operator: "contains", value: "1" }]), /cannot be used/);
  });

  it("type-checks values", () => {
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "deal_value", operator: "greater_than", value: "1000" }]), /needs a number/);
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "expected_close_date", operator: "less_than", value: "2026-02-30" }]), /YYYY-MM-DD/);
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "id", operator: "equals", value: "1 or 1=1" }]), /record id/);
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "status", operator: "equals", value: "Deleted" }]), /must be one of/);
    rejectsWith(() => validateFilters(TASK_FILTERS, [{ field: "priority", operator: "equals", value: "Urgent" }]), /must be one of/);
  });

  it("bounds the number of conditions and of `in` values", () => {
    const many = Array.from({ length: MCP_MAX_FILTER_CONDITIONS + 1 }, () => ({ field: "company", operator: "equals", value: "x" }));
    rejectsWith(() => validateFilters(LEAD_FILTERS, many), /At most/);
    const values = Array.from({ length: MCP_MAX_IN_VALUES + 1 }, (_, i) => `v${i}`);
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "source", operator: "in", value: values }]), /list of 1/);
  });

  it("refuses quotes and backslashes inside an `in` list", () => {
    rejectsWith(() => validateFilters(LEAD_FILTERS, [{ field: "source", operator: "in", value: ['a"),or(id.neq.0'] }]), /quotes/);
  });

  it("normalizes enum case to the canonical option", () => {
    const [condition] = validateFilters(TASK_FILTERS, [{ field: "status", operator: "equals", value: "pending" }]);
    assert.equal(condition.value, "Pending");
  });
});

describe("applyConditions — values are bound parameters, never query text", () => {
  it("passes an injection-shaped value through as a literal equality value", async () => {
    const hostile = "x'); delete from leads; --";
    const conditions = validateFilters(LEAD_FILTERS, [{ field: "company", operator: "equals", value: hostile }]);
    const { settle } = captureQuery((q) => applyConditions(q, conditions));
    const call = await settle();
    assert.deepEqual(call.filters, [["eq", "company", hostile]]);
    assert.equal(call.op, "select");
  });

  it("escapes LIKE metacharacters so they match literally", () => {
    assert.equal(toContainsPattern("100%_off\\"), "%100\\%\\_off\\\\%");
    assert.equal(toContainsPattern("a*b"), "%ab%");
  });

  it("maps is_closed to a null check on closed_at", async () => {
    const closed = validateFilters(LEAD_FILTERS, [{ field: "is_closed", operator: "equals", value: true }]);
    const open = validateFilters(LEAD_FILTERS, [{ field: "is_closed", operator: "equals", value: false }]);
    assert.deepEqual((await captureQuery((q) => applyConditions(q, closed)).settle()).filters, [["not", "closed_at", "is", null]]);
    assert.deepEqual((await captureQuery((q) => applyConditions(q, open)).settle()).filters, [["is", "closed_at", null]]);
  });

  it("resolves a stage name to the company's own stage id, and rejects an unknown one", async () => {
    const conditions = validateFilters(LEAD_FILTERS, [{ field: "stage", operator: "equals", value: "qualified" }]);
    const resolvers = {
      stageIdByName: (name: string) => (name.toLowerCase() === "qualified" ? "stage-q" : null),
      stageNames: () => ["New", "Qualified"],
    };
    const call = await captureQuery((q) => applyConditions(q, conditions, resolvers)).settle();
    assert.deepEqual(call.filters, [["eq", "stage_id", "stage-q"]]);

    const unknown = validateFilters(LEAD_FILTERS, [{ field: "stage", operator: "equals", value: "Negotiation" }]);
    rejectsWith(() => captureQuery((q) => applyConditions(q, unknown, resolvers)), /Unknown stage/);
  });

  it("sorts only by allowlisted fields and fetches one extra row for has_more", async () => {
    const call = await captureQuery((q) => applySortAndLimit(q, LEAD_FILTERS, { field: "deal_value", direction: "asc" }, 10)).settle();
    assert.deepEqual(call.modifiers, [
      ["order", "deal_value", { ascending: true, nullsFirst: false }],
      ["order", "id", { ascending: true }],
      ["limit", 11],
    ]);
    rejectsWith(() => captureQuery((q) => applySortAndLimit(q, LEAD_FILTERS, { field: "customer_id" }, 10)), /sort by/);
  });
});
