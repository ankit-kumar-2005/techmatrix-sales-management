import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_CONTACT_CREATE,
  ACTION_GET_RECORDS,
  ACTION_LEAD_DEACTIVATE,
  ACTION_LOOP,
  ACTION_TASK_CREATE,
  ACTION_TASK_DEACTIVATE,
  ACTION_TASK_UPDATE,
  ASSIGNMENT_SET_VARIABLE,
  CONDITION_LEAD_HAS_OWNER,
  CONDITION_LEAD_SOURCE_IS,
  DECISION_DEFAULT_BRANCH,
  DECISION_MULTI_OUTCOME,
  TRIGGER_CONTACT_CREATED,
  TRIGGER_LEAD_CREATED,
  TRIGGER_TASK_CREATED,
} from "../registry/definitions";
import { planWorkflow, renderTemplate, type LeadFacts } from "./plan-workflow";
import { buildAutomationKey } from "./idempotency";
import type { WorkflowDefinition } from "@/types/automation";

/**
 * planWorkflow IS the engine's decision function — the engine imports
 * this exact function, and test mode in the builder imports it too. So
 * these assertions describe what will actually happen at 3am, not an
 * approximation of it.
 */

const ASSIGNEE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const TASK_CONFIG = {
  subject: "Call {{lead.company}}",
  description: null,
  type: "Call",
  priority: "High",
  dueInDays: 1,
  assignmentMode: "Fixed",
  assigneeId: ASSIGNEE,
  rotation: [],
};

function facts(overrides: Partial<LeadFacts> = {}): LeadFacts {
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

function simple(): WorkflowDefinition {
  return {
    nodes: [
      { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
      { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: TASK_CONFIG },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
}

describe("planWorkflow — trigger validity", () => {
  // The trigger's own dedicated "sources" filter was removed — the same
  // narrowing is now expressed as a Source condition inside "Only run
  // when…" (see plan-workflow-triggers.test.ts's entry-condition suite,
  // including the regression proving that replacement covers exactly
  // what this filter used to). What is still the trigger's own job is
  // simpler: recognising whether it is a trigger this app can run at
  // all.
  it("never fires for an unknown trigger type", () => {
    const definition = simple();
    definition.nodes[0].type = "lead.exploded";
    const plan = planWorkflow(definition, facts());
    assert.equal(plan.triggered, false);
  });

  it("fires for a plain trigger with no source or entry-condition filter at all", () => {
    const plan = planWorkflow(simple(), facts({ source: "SomethingElse" }));
    assert.equal(plan.triggered, true);
    assert.equal(plan.actions.length, 1);
  });
});

describe("planWorkflow — conditions and branches", () => {
  function branching(): WorkflowDefinition {
    return {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: { sources: [] } },
        {
          id: "c1",
          kind: "condition",
          type: CONDITION_LEAD_HAS_OWNER,
          position: { x: 300, y: 0 },
          config: { expected: "no" },
        },
        {
          id: "yes",
          kind: "action",
          type: ACTION_TASK_CREATE,
          position: { x: 600, y: 0 },
          config: { ...TASK_CONFIG, subject: "UNASSIGNED PATH" },
        },
        {
          id: "no",
          kind: "action",
          type: ACTION_TASK_CREATE,
          position: { x: 600, y: 200 },
          config: { ...TASK_CONFIG, subject: "ASSIGNED PATH" },
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "c1" },
        { id: "e2", source: "c1", target: "yes", branch: "true" },
        { id: "e3", source: "c1", target: "no", branch: "false" },
      ],
    };
  }

  it("takes the yes branch and ONLY the yes branch", () => {
    const plan = planWorkflow(branching(), facts({ hasOwner: false }));
    assert.deepEqual(
      plan.actions.map((action) => action.nodeId),
      ["yes"],
    );
  });

  it("takes the no branch and ONLY the no branch", () => {
    const plan = planWorkflow(branching(), facts({ hasOwner: true }));
    assert.deepEqual(
      plan.actions.map((action) => action.nodeId),
      ["no"],
    );
  });

  it("evaluates a source condition independently of the trigger filter", () => {
    const definition = branching();
    definition.nodes[1] = {
      id: "c1",
      kind: "condition",
      type: CONDITION_LEAD_SOURCE_IS,
      position: { x: 300, y: 0 },
      config: { sources: ["IndiaMART"] },
    };

    assert.deepEqual(
      planWorkflow(definition, facts({ source: "IndiaMART" })).actions.map((action) => action.nodeId),
      ["yes"],
    );
    assert.deepEqual(
      planWorkflow(definition, facts({ source: "JustDial" })).actions.map((action) => action.nodeId),
      ["no"],
    );
  });

  it("reports when a branch leads nowhere rather than silently doing nothing", () => {
    const definition = branching();
    definition.nodes = definition.nodes.filter((node) => node.id !== "no");
    definition.edges = definition.edges.filter((edge) => edge.target !== "no");
    const plan = planWorkflow(definition, facts({ hasOwner: true }));
    assert.equal(plan.triggered, true);
    assert.equal(plan.actions.length, 0);
    assert.match(plan.trace.join(" "), /no action was reached/i);
  });

  it("treats an unknown condition as no rather than as yes", () => {
    // Failing CLOSED matters here: an unrecognised condition defaulting
    // to "yes" would make an unknown step behave as though it had passed.
    const definition = branching();
    definition.nodes[1].type = "lead.vibes";
    const plan = planWorkflow(definition, facts());
    assert.deepEqual(
      plan.actions.map((action) => action.nodeId),
      ["no"],
    );
  });
});

describe("planWorkflow — decision (named, ordered outcomes)", () => {
  function decisionWorkflow(): WorkflowDefinition {
    return {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: { sources: [] } },
        {
          id: "d1",
          kind: "decision",
          type: DECISION_MULTI_OUTCOME,
          position: { x: 300, y: 0 },
          config: {
            outcomes: [
              {
                id: "high",
                name: "High value",
                root: { kind: "group", match: "all", rules: [{ kind: "rule", field: "deal_value", operator: "greater_than_or_equal", value: 100000, valueTo: null }] },
              },
              {
                id: "medium",
                name: "Medium value",
                root: { kind: "group", match: "all", rules: [{ kind: "rule", field: "deal_value", operator: "greater_than_or_equal", value: 10000, valueTo: null }] },
              },
            ],
          },
        },
        { id: "a-high", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: -100 }, config: { ...TASK_CONFIG, subject: "HIGH" } },
        { id: "a-medium", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 0 }, config: { ...TASK_CONFIG, subject: "MEDIUM" } },
        { id: "a-default", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 100 }, config: { ...TASK_CONFIG, subject: "DEFAULT" } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "d1" },
        { id: "e2", source: "d1", target: "a-high", branch: "high" },
        { id: "e3", source: "d1", target: "a-medium", branch: "medium" },
        { id: "e4", source: "d1", target: "a-default", branch: DECISION_DEFAULT_BRANCH },
      ],
    };
  }

  it("takes the FIRST matching outcome, not every matching one", () => {
    // deal_value 150000 matches BOTH "high" (>= 100000) and "medium"
    // (>= 10000) — only "high" (listed first) must run.
    const plan = planWorkflow(decisionWorkflow(), facts({ fields: { deal_value: 150000 } }));
    assert.deepEqual(plan.actions.map((action) => action.nodeId), ["a-high"]);
  });

  it("takes a later outcome when an earlier one does not match", () => {
    const plan = planWorkflow(decisionWorkflow(), facts({ fields: { deal_value: 50000 } }));
    assert.deepEqual(plan.actions.map((action) => action.nodeId), ["a-medium"]);
  });

  it("falls through to the Otherwise path when nothing matches", () => {
    const plan = planWorkflow(decisionWorkflow(), facts({ fields: { deal_value: 100 } }));
    assert.deepEqual(plan.actions.map((action) => action.nodeId), ["a-default"]);
  });

  it("names the matched outcome in the trace", () => {
    const plan = planWorkflow(decisionWorkflow(), facts({ fields: { deal_value: 150000 } }));
    assert.match(plan.trace.join(" "), /High value/);
  });
});

describe("planWorkflow — assignment (temporary, in-run variables)", () => {
  function assignmentWorkflow(assignments: unknown[]): WorkflowDefinition {
    return {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: { sources: [] } },
        { id: "set1", kind: "assignment", type: ASSIGNMENT_SET_VARIABLE, position: { x: 300, y: 0 }, config: { assignments } },
        {
          id: "a1",
          kind: "action",
          type: ACTION_TASK_CREATE,
          position: { x: 600, y: 0 },
          config: { ...TASK_CONFIG, subject: "Note: {{var.note}}" },
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "set1" },
        { id: "e2", source: "set1", target: "a1" },
      ],
    };
  }

  it("resolves a variable set from a lead field into a later action's config", () => {
    const definition = assignmentWorkflow([{ variable: "note", operator: "set", valueSource: "field", fieldKey: "company", staticValue: "" }]);
    const plan = planWorkflow(definition, facts({ fields: { company: "Acme Industries" } }));
    assert.equal(plan.actions[0].config.subject, "Note: Acme Industries");
  });

  it("resolves a variable set from typed text", () => {
    const definition = assignmentWorkflow([{ variable: "note", operator: "set", valueSource: "static", staticValue: "hand-typed", fieldKey: "" }]);
    const plan = planWorkflow(definition, facts());
    assert.equal(plan.actions[0].config.subject, "Note: hand-typed");
  });

  it("append adds to the existing value rather than replacing it", () => {
    const definition = assignmentWorkflow([
      { variable: "note", operator: "set", valueSource: "static", staticValue: "A", fieldKey: "" },
      { variable: "note", operator: "append", valueSource: "static", staticValue: "B", fieldKey: "" },
    ]);
    const plan = planWorkflow(definition, facts());
    assert.equal(plan.actions[0].config.subject, "Note: AB");
  });

  it("add/subtract do arithmetic, not string concatenation", () => {
    const definition = assignmentWorkflow([
      { variable: "note", operator: "set", valueSource: "static", staticValue: "10", fieldKey: "" },
      { variable: "note", operator: "add", valueSource: "static", staticValue: "5", fieldKey: "" },
      { variable: "note", operator: "subtract", valueSource: "static", staticValue: "2", fieldKey: "" },
    ]);
    const plan = planWorkflow(definition, facts());
    assert.equal(plan.actions[0].config.subject, "Note: 13");
  });

  it("an unresolved variable token substitutes to empty, not left verbatim", () => {
    const definition = assignmentWorkflow([{ variable: "other", operator: "set", valueSource: "static", staticValue: "x", fieldKey: "" }]);
    const plan = planWorkflow(definition, facts());
    assert.equal(plan.actions[0].config.subject, "Note: ");
  });

  it("a static value can use the same {{lead.*}} tokens task subject/description do", () => {
    const definition = assignmentWorkflow([
      { variable: "note", operator: "set", valueSource: "static", staticValue: "{{lead.company}}", fieldKey: "" },
    ]);
    const plan = planWorkflow(definition, facts({ company: "Acme" }));
    // A static value is free-typed text, same as task subject/description
    // and Update Lead's "Next step" — all four now go through the
    // identical renderTemplate call, so the reference picker offered on
    // any of them (see field-reference-picker.tsx) behaves identically
    // everywhere it appears, and none of them is a second, narrower
    // templating mechanism.
    assert.equal(plan.actions[0].config.subject, "Note: Acme");
  });

  it("a variable set on one decision branch is not visible on a sibling branch", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: { sources: [] } },
        {
          id: "d1",
          kind: "decision",
          type: DECISION_MULTI_OUTCOME,
          position: { x: 300, y: 0 },
          config: {
            outcomes: [
              {
                id: "high",
                name: "High",
                root: { kind: "group", match: "all", rules: [{ kind: "rule", field: "deal_value", operator: "greater_than_or_equal", value: 100000, valueTo: null }] },
              },
            ],
          },
        },
        {
          id: "set1",
          kind: "assignment",
          type: ASSIGNMENT_SET_VARIABLE,
          position: { x: 600, y: -100 },
          config: { assignments: [{ variable: "note", operator: "set", valueSource: "static", staticValue: "high-path", fieldKey: "" }] },
        },
        {
          id: "a-high",
          kind: "action",
          type: ACTION_TASK_CREATE,
          position: { x: 900, y: -100 },
          config: { ...TASK_CONFIG, subject: "{{var.note}}" },
        },
        {
          id: "a-default",
          kind: "action",
          type: ACTION_TASK_CREATE,
          position: { x: 900, y: 100 },
          config: { ...TASK_CONFIG, subject: "{{var.note}}" },
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "d1" },
        { id: "e2", source: "d1", target: "set1", branch: "high" },
        { id: "e3", source: "set1", target: "a-high" },
        { id: "e4", source: "d1", target: "a-default", branch: DECISION_DEFAULT_BRANCH },
      ],
    };

    const plan = planWorkflow(definition, facts({ fields: { deal_value: 100 } }));
    assert.deepEqual(plan.actions.map((action) => action.nodeId), ["a-default"]);
    // The default path never passed through the assignment node, so its
    // own {{var.note}} token has nothing to resolve to.
    assert.equal(plan.actions[0].config.subject, "");
  });
});

describe("planWorkflow — Task/Contact actions are planned like any other action", () => {
  it("collects Create Task -> Update Task in order, config untouched (targeting is resolved later, in the executor)", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        { id: "create1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: TASK_CONFIG },
        {
          id: "update1",
          kind: "action",
          type: ACTION_TASK_UPDATE,
          position: { x: 600, y: 0 },
          config: { sourceNodeId: "create1", subject: "Done", description: "", priority: "", due_date: "", type: "", status: "", assignmentMode: "None", assigneeId: null, rotation: [] },
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "create1" },
        { id: "e2", source: "create1", target: "update1" },
      ],
    };

    const plan = planWorkflow(definition, facts());
    assert.deepEqual(plan.actions.map((action) => action.nodeId), ["create1", "update1"], "Create runs before Update, in the order the graph connects them");
    assert.equal(plan.actions[1].config.sourceNodeId, "create1", "planWorkflow passes sourceNodeId through unresolved — buildAutomationKey happens in the executor, not here");
  });

  it("Create Contact and Deactivate Task are ordinary, plannable actions too", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        {
          id: "c1",
          kind: "action",
          type: ACTION_CONTACT_CREATE,
          position: { x: 300, y: 0 },
          config: { name: "Priya", company: "", title: "", email: "", phone: "", assignmentMode: "Fixed", assigneeId: ASSIGNEE, rotation: [] },
        },
        { id: "create1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 200 }, config: TASK_CONFIG },
        {
          id: "deact1",
          kind: "action",
          type: ACTION_TASK_DEACTIVATE,
          position: { x: 600, y: 200 },
          config: { sourceNodeId: "create1" },
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "c1" },
        { id: "e2", source: "t1", target: "create1" },
        { id: "e3", source: "create1", target: "deact1" },
      ],
    };

    const plan = planWorkflow(definition, facts());
    assert.deepEqual(new Set(plan.actions.map((action) => action.nodeId)), new Set(["c1", "create1", "deact1"]));
  });
});

describe("planWorkflow — multiple actions in sequence", () => {
  it("collects every action on the taken path", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: { sources: [] } },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: TASK_CONFIG },
        { id: "a2", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 0 }, config: TASK_CONFIG },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "a2" },
      ],
    };
    assert.deepEqual(
      planWorkflow(definition, facts()).actions.map((action) => action.nodeId),
      ["a1", "a2"],
    );
  });

  it("visits a node reachable by two paths only once", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: { sources: [] } },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: TASK_CONFIG },
        { id: "a2", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 200 }, config: TASK_CONFIG },
        { id: "a3", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 100 }, config: TASK_CONFIG },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "t1", target: "a2" },
        { id: "e3", source: "a1", target: "a3" },
        { id: "e4", source: "a2", target: "a3" },
      ],
    };
    const ids = planWorkflow(definition, facts()).actions.map((action) => action.nodeId);
    assert.equal(ids.filter((id) => id === "a3").length, 1, "a3 must not be planned twice");
  });
});

describe("renderTemplate — a fixed lookup table, not an expression language", () => {
  it("substitutes each known token", () => {
    assert.equal(
      renderTemplate("{{lead.company}} / {{lead.contact_name}} / {{lead.source}}", facts()),
      "Acme Industries / Priya Sharma / IndiaMART",
    );
  });

  it("substitutes a token used more than once", () => {
    assert.equal(renderTemplate("{{lead.company}} and {{lead.company}}", facts()), "Acme Industries and Acme Industries");
  });

  it("leaves an unknown placeholder exactly as written", () => {
    // Visible to whoever reads the task, which is the honest outcome —
    // far better than silently deleting it or resolving it to something.
    assert.equal(renderTemplate("Call {{lead.secret_field}}", facts()), "Call {{lead.secret_field}}");
  });

  it("cannot be used to reach a field that is not in the token table", () => {
    const rendered = renderTemplate("{{lead.leadId}} {{leadId}} {{constructor}} {{__proto__}}", facts());
    assert.ok(!rendered.includes(facts().leadId), "no path may resolve an untabled field");
    assert.match(rendered, /\{\{lead\.leadId\}\}/);
  });

  it("does not evaluate anything that looks like an expression", () => {
    const input = "{{1+1}} ${process.env.SECRET} <script>alert(1)</script>";
    // Returned verbatim: there is no evaluation step anywhere in this
    // function, only a literal string replace over a closed list.
    assert.equal(renderTemplate(input, facts()), input);
  });

  it("resolves a null source to an empty string rather than the word null", () => {
    assert.equal(renderTemplate("From {{lead.source}}", facts({ source: null })), "From");
  });
});

describe("buildAutomationKey — deterministic idempotency", () => {
  const params = { automationId: "auto-1", version: 3, eventId: "evt-9", nodeId: "a1" };

  it("returns the same key for the same inputs, every time", () => {
    assert.equal(buildAutomationKey(params), buildAutomationKey(params));
  });

  it("is stable across separate calls, which is what makes a retry safe", () => {
    const first = buildAutomationKey(params);
    // A retry happens in a different process, minutes later. Nothing in
    // the key may come from a clock or a random source.
    const later = buildAutomationKey({ ...params });
    assert.equal(first, later);
  });

  it("differs per automation, so two automations can both act on one lead", () => {
    assert.notEqual(buildAutomationKey(params), buildAutomationKey({ ...params, automationId: "auto-2" }));
  });

  it("differs per version, so an edited workflow is not suppressed as a duplicate", () => {
    assert.notEqual(buildAutomationKey(params), buildAutomationKey({ ...params, version: 4 }));
  });

  it("differs per event", () => {
    assert.notEqual(buildAutomationKey(params), buildAutomationKey({ ...params, eventId: "evt-10" }));
  });

  it("differs per node, so two task nodes in one workflow both write", () => {
    assert.notEqual(buildAutomationKey(params), buildAutomationKey({ ...params, nodeId: "a2" }));
  });
});

describe("planWorkflow — Loop's body capture", () => {
  function loopWorkflow(afterLoop = true): WorkflowDefinition {
    const nodes: WorkflowDefinition["nodes"] = [
      { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
      {
        id: "get1",
        kind: "action",
        type: ACTION_GET_RECORDS,
        position: { x: 300, y: 0 },
        config: { object: "task", filters: { kind: "group", match: "all", rules: [] }, limit: 20, resultVariable: "items" },
      },
      {
        id: "loop1",
        kind: "action",
        type: ACTION_LOOP,
        position: { x: 600, y: 0 },
        config: { collectionVariable: "items", itemVariable: "item" },
      },
      { id: "body1", kind: "action", type: ACTION_LEAD_DEACTIVATE, position: { x: 900, y: 0 }, config: {} },
    ];
    const edges: WorkflowDefinition["edges"] = [
      { id: "e1", source: "t1", target: "get1" },
      { id: "e2", source: "get1", target: "loop1" },
      { id: "e3", source: "loop1", target: "body1" },
    ];
    if (afterLoop) {
      nodes.push({ id: "after1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 1200, y: 0 }, config: TASK_CONFIG });
      edges.push({ id: "e4", source: "body1", target: "after1" });
    }
    return { nodes, edges };
  }

  it("the body node's own type/config is captured inside the Loop's own planned action, not emitted as a separate action", () => {
    const plan = planWorkflow(loopWorkflow(false), facts(), "created");
    assert.equal(plan.actions.length, 2, "Get Records, then Loop — the body is NOT its own third entry");
    const loopAction = plan.actions[1];
    assert.equal(loopAction.type, ACTION_LOOP);
    const bodyAction = (loopAction.config as { bodyAction?: { type: string; config: Record<string, unknown> } }).bodyAction;
    assert.ok(bodyAction);
    assert.equal(bodyAction!.type, ACTION_LEAD_DEACTIVATE);
  });

  it("whatever comes AFTER the loop's body still runs once, as its own normal action", () => {
    const plan = planWorkflow(loopWorkflow(true), facts(), "created");
    assert.equal(plan.actions.length, 3, "Get Records, Loop (body captured inside it), then the one after-loop action");
    assert.equal(plan.actions[2].type, ACTION_TASK_CREATE);
  });

  it("a Loop with no valid body connected plans zero actions from it and says so in the trace, rather than guessing", () => {
    const definition = loopWorkflow(false);
    definition.edges = definition.edges.filter((e) => e.source !== "loop1");
    const plan = planWorkflow(definition, facts(), "created");
    assert.equal(plan.actions.length, 1, "only Get Records — the Loop itself never becomes a planned action with no body");
    assert.ok(plan.trace.some((line) => line.includes("no step is connected")));
  });
});

describe("planWorkflow — Task/Contact triggers, and Deactivate Lead", () => {
  function triggerWorkflow(triggerType: string, actionType: string, actionConfig: Record<string, unknown>): WorkflowDefinition {
    return {
      nodes: [
        { id: "t1", kind: "trigger", type: triggerType, position: { x: 0, y: 0 }, config: { eventType: "created" } },
        { id: "a1", kind: "action", type: actionType, position: { x: 300, y: 0 }, config: actionConfig },
      ],
      edges: [{ id: "e1", source: "t1", target: "a1" }],
    };
  }

  it("a task.created trigger is recognised by matchesEventType, not rejected as 'unknown trigger'", () => {
    const plan = planWorkflow(triggerWorkflow(TRIGGER_TASK_CREATED, ACTION_LEAD_DEACTIVATE, {}), facts(), "created");
    assert.equal(plan.triggered, true);
    assert.equal(plan.actions.length, 1);
    assert.ok(!plan.trace.some((line) => line.includes("Unknown trigger")));
  });

  it("a contact.created trigger is recognised the same way", () => {
    const plan = planWorkflow(triggerWorkflow(TRIGGER_CONTACT_CREATED, ACTION_LEAD_DEACTIVATE, {}), facts(), "created");
    assert.equal(plan.triggered, true);
  });

  it("a task.created trigger configured for 'updated' does not fire on a 'created' operation", () => {
    const def = triggerWorkflow(TRIGGER_TASK_CREATED, ACTION_LEAD_DEACTIVATE, {});
    (def.nodes[0].config as Record<string, unknown>).eventType = "updated";
    const plan = planWorkflow(def, facts(), "created");
    assert.equal(plan.triggered, false);
  });

  it("Deactivate Lead plans as a single action with no config required", () => {
    const plan = planWorkflow(triggerWorkflow(TRIGGER_LEAD_CREATED, ACTION_LEAD_DEACTIVATE, {}), facts(), "created");
    assert.equal(plan.triggered, true);
    assert.equal(plan.actions[0].type, ACTION_LEAD_DEACTIVATE);
  });
});
