import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ACTION_TASK_CREATE, CONDITION_FIELD_GROUP, TRIGGER_LEAD_CREATED } from "../registry/definitions";
import { planWorkflow, type LeadFacts } from "./plan-workflow";
import type { WorkflowDefinition } from "@/types/automation";

/**
 * Record-triggered events — Created / Updated / Created-or-Updated, and
 * "only when it starts matching" — plus the generic field-group
 * condition. Complements plan-workflow.test.ts, which pre-dates this
 * phase and stays focused on the original two fixed condition types.
 */

const ASSIGNEE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TASK_CONFIG = {
  subject: "Follow up",
  description: null,
  type: "Call",
  priority: "High",
  dueInDays: 1,
  assignmentMode: "Fixed",
  assigneeId: ASSIGNEE,
  rotation: [],
};

function facts(overrides: Partial<LeadFacts> & { fields?: Record<string, unknown> } = {}): LeadFacts {
  return {
    leadId: "11111111-1111-4111-8111-111111111111",
    source: "IndiaMART",
    hasOwner: false,
    company: "Acme Industries",
    contactName: "Priya Sharma",
    fields: {},
    ...overrides,
  };
}

function withTrigger(eventType: string, updateMode = "every_time"): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "t1",
        kind: "trigger",
        type: TRIGGER_LEAD_CREATED,
        position: { x: 0, y: 0 },
        config: { eventType, updateMode },
      },
      { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: TASK_CONFIG },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
}

describe("planWorkflow — eventType matching", () => {
  it("a 'created' trigger fires on a created event", () => {
    assert.equal(planWorkflow(withTrigger("created"), facts(), "created").triggered, true);
  });

  it("a 'created' trigger does NOT fire on an updated event", () => {
    assert.equal(planWorkflow(withTrigger("created"), facts(), "updated").triggered, false);
  });

  it("an 'updated' trigger does NOT fire on a created event", () => {
    assert.equal(planWorkflow(withTrigger("updated"), facts(), "created").triggered, false);
  });

  it("an 'updated' trigger fires on an updated event", () => {
    assert.equal(planWorkflow(withTrigger("updated"), facts(), "updated").triggered, true);
  });

  it("a 'created_or_updated' trigger fires on both", () => {
    assert.equal(planWorkflow(withTrigger("created_or_updated"), facts(), "created").triggered, true);
    assert.equal(planWorkflow(withTrigger("created_or_updated"), facts(), "updated").triggered, true);
  });

  it("defaults to 'created' when eventType is absent — an old saved definition", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: TASK_CONFIG },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
    assert.equal(planWorkflow(definition, facts(), "created").triggered, true);
    assert.equal(planWorkflow(definition, facts(), "updated").triggered, false);
  });

  it("explains the mismatch in the trace", () => {
    const plan = planWorkflow(withTrigger("created"), facts(), "updated");
    assert.match(plan.trace.join(" "), /runs on created.*event was a updated/i);
  });
});

describe("planWorkflow — \"only when it starts matching\" (entered mode)", () => {
  function conditionalWorkflow(eventType: string, updateMode: string): WorkflowDefinition {
    return {
      nodes: [
        {
          id: "t1",
          kind: "trigger",
          type: TRIGGER_LEAD_CREATED,
          position: { x: 0, y: 0 },
          config: { eventType, updateMode },
        },
        {
          id: "c1",
          kind: "condition",
          type: CONDITION_FIELD_GROUP,
          position: { x: 300, y: 0 },
          config: { root: { kind: "group", match: "all", rules: [{ kind: "rule", field: "deal_value", operator: "greater_than", value: 50000, valueTo: null }] } },
        },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 0 }, config: TASK_CONFIG },
      ],
      edges: [
        { id: "e1", source: "t1", target: "c1" },
        { id: "e2", source: "c1", target: "a1", branch: "true" },
      ],
    };
  }

  it("fires when the lead was NOT matching before and IS matching now", () => {
    const definition = conditionalWorkflow("updated", "entered");
    const plan = planWorkflow(
      definition,
      facts({ fields: { deal_value: "60000" } }),
      "updated",
      facts({ fields: { deal_value: "10000" } }),
    );
    assert.equal(plan.triggered, true);
    assert.equal(plan.actions.length, 1);
  });

  it("does NOT fire when the lead already matched before this update", () => {
    const definition = conditionalWorkflow("updated", "entered");
    const plan = planWorkflow(
      definition,
      facts({ fields: { deal_value: "70000" } }),
      "updated",
      facts({ fields: { deal_value: "60000" } }), // already over 50000 before
    );
    assert.equal(plan.triggered, false);
    assert.match(plan.trace.join(" "), /already matched before this update/i);
  });

  it("reaches no action when it still doesn't match after the update", () => {
    // The trigger's OWN filters (eventType, entry condition) still pass here —
    // "triggered" answers "did the trigger fire", not "did an action
    // run". Nothing to compare old vs. new against below the trigger:
    // there is no "false" branch wired in conditionalWorkflow, so a
    // still-not-matching condition correctly reaches zero actions
    // rather than a distinct "not triggered" outcome.
    const definition = conditionalWorkflow("updated", "entered");
    const plan = planWorkflow(
      definition,
      facts({ fields: { deal_value: "20000" } }),
      "updated",
      facts({ fields: { deal_value: "10000" } }),
    );
    assert.equal(plan.triggered, true);
    assert.equal(plan.actions.length, 0);
  });

  it("'every_time' mode fires on every matching update, not just transitions", () => {
    const definition = conditionalWorkflow("updated", "every_time");
    const plan = planWorkflow(
      definition,
      facts({ fields: { deal_value: "70000" } }),
      "updated",
      facts({ fields: { deal_value: "60000" } }), // already matched before too
    );
    assert.equal(plan.triggered, true);
  });

  it("entered mode does not apply to a created event — always evaluates fresh", () => {
    const definition = conditionalWorkflow("created_or_updated", "entered");
    const plan = planWorkflow(definition, facts({ fields: { deal_value: "60000" } }), "created", undefined);
    assert.equal(plan.triggered, true);
  });

  it("with no previousFacts supplied, entered mode does not block (defensive fallback)", () => {
    const definition = conditionalWorkflow("updated", "entered");
    const plan = planWorkflow(definition, facts({ fields: { deal_value: "60000" } }), "updated", undefined);
    assert.equal(plan.triggered, true);
  });
});

describe("planWorkflow — the trigger's own \"Only run when…\" entry condition", () => {
  function withEntryCondition(entryCondition: unknown, eventType = "created", updateMode = "every_time"): WorkflowDefinition {
    return {
      nodes: [
        {
          id: "t1",
          kind: "trigger",
          type: TRIGGER_LEAD_CREATED,
          position: { x: 0, y: 0 },
          config: { eventType, updateMode, entryCondition },
        },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: TASK_CONFIG },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
  }

  const condition = { kind: "group", match: "all", rules: [{ kind: "rule", field: "deal_value", operator: "greater_than", value: 50000, valueTo: null }] };

  it("null (off) runs exactly as before — no entry condition at all", () => {
    const plan = planWorkflow(withEntryCondition(null), facts({ fields: { deal_value: "10" } }));
    assert.equal(plan.triggered, true);
  });

  it("blocks the trigger when the condition does not match", () => {
    const plan = planWorkflow(withEntryCondition(condition), facts({ fields: { deal_value: "100" } }));
    assert.equal(plan.triggered, false);
    assert.match(plan.trace.join(" "), /entry condition did not match/i);
  });

  it("lets the trigger through when the condition matches", () => {
    const plan = planWorkflow(withEntryCondition(condition), facts({ fields: { deal_value: "60000" } }));
    assert.equal(plan.triggered, true);
    assert.equal(plan.actions.length, 1);
  });

  it("a Source rule inside the entry condition fully replaces the old dedicated sources filter", () => {
    // The trigger used to have a SEPARATE `sources` field alongside this
    // one. It was removed — a source restriction is now just another
    // rule in the same AND/OR list, combined here with a second rule to
    // prove it is genuinely the general field-group engine doing the
    // work, not a special case.
    const sourceAndValue = {
      kind: "group",
      match: "all",
      rules: [
        { kind: "rule", field: "source", operator: "is_any_of", value: ["IndiaMART"], valueTo: null },
        { kind: "rule", field: "deal_value", operator: "greater_than", value: 50000, valueTo: null },
      ],
    };
    const definition = withEntryCondition(sourceAndValue);

    // Matches deal_value but not the source restriction.
    assert.equal(planWorkflow(definition, facts({ fields: { source: "Website", deal_value: "60000" } })).triggered, false);
    // Matches the source restriction but not deal_value.
    assert.equal(planWorkflow(definition, facts({ fields: { source: "IndiaMART", deal_value: "100" } })).triggered, false);
    // Matches both.
    assert.equal(planWorkflow(definition, facts({ fields: { source: "IndiaMART", deal_value: "60000" } })).triggered, true);
  });

  it('a hand-entered lead (no source) is matched with "is empty", not a fake source value', () => {
    const noSource = { kind: "group", match: "all", rules: [{ kind: "rule", field: "source", operator: "is_empty", value: null, valueTo: null }] };
    const definition = withEntryCondition(noSource);

    assert.equal(planWorkflow(definition, facts({ fields: { source: null } })).triggered, true);
    assert.equal(planWorkflow(definition, facts({ fields: { source: "IndiaMART" } })).triggered, false);
  });

  it("is a hard gate on CURRENT facts only — orthogonal to 'entered' mode's transition check", () => {
    // A downstream condition (status) is what 'entered' mode's dual walk
    // actually compares old vs. new against; the trigger's own entry
    // condition (deal_value) is satisfied by BOTH old and new facts
    // here, which is the point — it is checked once against current
    // facts, not folded into the old/new comparison the way a
    // downstream condition node is.
    const definition: WorkflowDefinition = {
      nodes: [
        {
          id: "t1",
          kind: "trigger",
          type: TRIGGER_LEAD_CREATED,
          position: { x: 0, y: 0 },
          config: { eventType: "updated", updateMode: "entered", entryCondition: condition },
        },
        {
          id: "c1",
          kind: "condition",
          type: CONDITION_FIELD_GROUP,
          position: { x: 300, y: 0 },
          config: { root: { kind: "group", match: "all", rules: [{ kind: "rule", field: "status", operator: "equals", value: "Active", valueTo: null }] } },
        },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 0 }, config: TASK_CONFIG },
      ],
      edges: [
        { id: "e1", source: "t1", target: "c1" },
        { id: "e2", source: "c1", target: "a1", branch: "true" },
      ],
    };

    // Entry condition (deal_value > 50000) matches both old and new;
    // the downstream condition (status) transitions Inactive -> Active.
    const transitioned = planWorkflow(
      definition,
      facts({ fields: { deal_value: "70000", status: "Active" } }),
      "updated",
      facts({ fields: { deal_value: "60000", status: "Inactive" } }),
    );
    assert.equal(transitioned.triggered, true);
    assert.equal(transitioned.actions.length, 1);

    // Entry condition fails on CURRENT facts — blocked regardless of
    // what the downstream condition would have done.
    const entryFails = planWorkflow(
      definition,
      facts({ fields: { deal_value: "10", status: "Active" } }),
      "updated",
      facts({ fields: { deal_value: "60000", status: "Inactive" } }),
    );
    assert.equal(entryFails.triggered, false);
    assert.match(entryFails.trace.join(" "), /entry condition did not match/i);
  });
});

describe("planWorkflow — the generic field-group condition", () => {
  function withFieldGroup(root: unknown): WorkflowDefinition {
    return {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        { id: "c1", kind: "condition", type: CONDITION_FIELD_GROUP, position: { x: 300, y: 0 }, config: { root } },
        { id: "yes", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 0 }, config: TASK_CONFIG },
        { id: "no", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 200 }, config: TASK_CONFIG },
      ],
      edges: [
        { id: "e1", source: "t1", target: "c1" },
        { id: "e2", source: "c1", target: "yes", branch: "true" },
        { id: "e3", source: "c1", target: "no", branch: "false" },
      ],
    };
  }

  function ruleGroup(match: "all" | "any", rules: unknown[]) {
    return { kind: "group", match, rules };
  }
  function rule(field: string, operator: string, value: unknown = null, valueTo: unknown = null) {
    return { kind: "rule", field, operator, value, valueTo };
  }

  it("AND: both must be true", () => {
    const root = ruleGroup("all", [rule("source", "equals", "IndiaMART"), rule("deal_value", "greater_than", 50000)]);
    const takenPath = (dealValue: string, source: string | null) =>
      planWorkflow(withFieldGroup(root), facts({ source, fields: { source, deal_value: dealValue } })).actions.map((a) => a.nodeId);

    assert.deepEqual(takenPath("60000", "IndiaMART"), ["yes"]);
    assert.deepEqual(takenPath("10000", "IndiaMART"), ["no"]);
    assert.deepEqual(takenPath("60000", "Website"), ["no"]);
  });

  it("OR: either is enough", () => {
    const root = ruleGroup("any", [rule("source", "equals", "IndiaMART"), rule("status", "equals", "Active")]);
    const takenPath = (source: string, status: string) =>
      planWorkflow(withFieldGroup(root), facts({ fields: { source, status } })).actions.map((a) => a.nodeId);

    assert.deepEqual(takenPath("IndiaMART", "Inactive"), ["yes"]);
    assert.deepEqual(takenPath("Website", "Active"), ["yes"]);
    assert.deepEqual(takenPath("Website", "Inactive"), ["no"]);
  });

  it("nested groups: (A AND B) OR C", () => {
    const root = ruleGroup("any", [
      ruleGroup("all", [rule("source", "equals", "IndiaMART"), rule("deal_value", "greater_than", 50000)]),
      rule("status", "equals", "Active"),
    ]);
    const takenPath = (source: string, dealValue: string, status: string) =>
      planWorkflow(withFieldGroup(root), facts({ fields: { source, deal_value: dealValue, status } })).actions.map(
        (a) => a.nodeId,
      );

    assert.deepEqual(takenPath("IndiaMART", "60000", "Inactive"), ["yes"], "the AND branch alone should satisfy the OR");
    assert.deepEqual(takenPath("Website", "10000", "Active"), ["yes"], "the plain C branch alone should satisfy the OR");
    assert.deepEqual(takenPath("Website", "10000", "Inactive"), ["no"], "neither branch matches");
  });

  it("text operators: contains / starts_with are case-insensitive", () => {
    const contains = ruleGroup("all", [rule("company", "contains", "acme")]);
    assert.deepEqual(planWorkflow(withFieldGroup(contains), facts({ fields: { company: "Acme Industries" } })).actions.map((a) => a.nodeId), ["yes"]);

    const startsWith = ruleGroup("all", [rule("company", "starts_with", "ACME")]);
    assert.deepEqual(planWorkflow(withFieldGroup(startsWith), facts({ fields: { company: "Acme Industries" } })).actions.map((a) => a.nodeId), ["yes"]);
    assert.deepEqual(planWorkflow(withFieldGroup(startsWith), facts({ fields: { company: "Not Acme" } })).actions.map((a) => a.nodeId), ["no"]);
  });

  it("is_empty / is_not_empty", () => {
    const isEmpty = ruleGroup("all", [rule("next_step", "is_empty")]);
    assert.deepEqual(planWorkflow(withFieldGroup(isEmpty), facts({ fields: { next_step: null } })).actions.map((a) => a.nodeId), ["yes"]);
    assert.deepEqual(planWorkflow(withFieldGroup(isEmpty), facts({ fields: { next_step: "Call back" } })).actions.map((a) => a.nodeId), ["no"]);
  });

  it("reference type (owner_id): is_not_empty means 'has an owner'", () => {
    const hasOwner = ruleGroup("all", [rule("owner_id", "is_not_empty")]);
    assert.deepEqual(planWorkflow(withFieldGroup(hasOwner), facts({ fields: { owner_id: "some-user-id" } })).actions.map((a) => a.nodeId), ["yes"]);
    assert.deepEqual(planWorkflow(withFieldGroup(hasOwner), facts({ fields: { owner_id: null } })).actions.map((a) => a.nodeId), ["no"]);
  });

  it("date equals compares by calendar day, not exact timestamp", () => {
    const sameDay = ruleGroup("all", [rule("expected_close_date", "equals", "2026-06-15")]);
    assert.deepEqual(
      planWorkflow(withFieldGroup(sameDay), facts({ fields: { expected_close_date: "2026-06-15T18:42:00Z" } })).actions.map((a) => a.nodeId),
      ["yes"],
    );
    assert.deepEqual(
      planWorkflow(withFieldGroup(sameDay), facts({ fields: { expected_close_date: "2026-06-16T00:01:00Z" } })).actions.map((a) => a.nodeId),
      ["no"],
    );
  });

  it("between is inclusive of both bounds", () => {
    const between = ruleGroup("all", [rule("expected_close_date", "between", "2026-01-01", "2026-01-31")]);
    assert.deepEqual(planWorkflow(withFieldGroup(between), facts({ fields: { expected_close_date: "2026-01-01" } })).actions.map((a) => a.nodeId), ["yes"]);
    assert.deepEqual(planWorkflow(withFieldGroup(between), facts({ fields: { expected_close_date: "2026-01-31" } })).actions.map((a) => a.nodeId), ["yes"]);
    assert.deepEqual(planWorkflow(withFieldGroup(between), facts({ fields: { expected_close_date: "2026-02-01" } })).actions.map((a) => a.nodeId), ["no"]);
  });

  it("is_any_of matches any listed value", () => {
    const anyOf = ruleGroup("all", [rule("source", "is_any_of", ["IndiaMART", "Website"])]);
    assert.deepEqual(planWorkflow(withFieldGroup(anyOf), facts({ fields: { source: "Website" } })).actions.map((a) => a.nodeId), ["yes"]);
    assert.deepEqual(planWorkflow(withFieldGroup(anyOf), facts({ fields: { source: "Manual" } })).actions.map((a) => a.nodeId), ["no"]);
  });

  it("an unregistered field key fails CLOSED (treated as false), never throws", () => {
    const root = ruleGroup("all", [rule("ssn", "equals", "123")]);
    assert.doesNotThrow(() => planWorkflow(withFieldGroup(root), facts()));
    assert.deepEqual(planWorkflow(withFieldGroup(root), facts()).actions.map((a) => a.nodeId), ["no"]);
  });

  it("a numeric string field value compares correctly (deal_value arrives from JSONB as text-shaped)", () => {
    const root = ruleGroup("all", [rule("deal_value", "greater_than_or_equal", 50000)]);
    assert.deepEqual(planWorkflow(withFieldGroup(root), facts({ fields: { deal_value: "50000" } })).actions.map((a) => a.nodeId), ["yes"]);
    assert.deepEqual(planWorkflow(withFieldGroup(root), facts({ fields: { deal_value: "49999.99" } })).actions.map((a) => a.nodeId), ["no"]);
  });
});
