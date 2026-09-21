import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTION_TASK_CREATE,
  CONDITION_LEAD_HAS_OWNER,
  CONDITION_LEAD_SOURCE_IS,
  TRIGGER_LEAD_CREATED,
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
    ...overrides,
  };
}

function simple(triggerSources: string[]): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "t1",
        kind: "trigger",
        type: TRIGGER_LEAD_CREATED,
        position: { x: 0, y: 0 },
        config: { sources: triggerSources },
      },
      { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: TASK_CONFIG },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
  };
}

describe("planWorkflow — the trigger filter", () => {
  it("runs for any source when the filter is empty", () => {
    const plan = planWorkflow(simple([]), facts({ source: "SomethingElse" }));
    assert.equal(plan.triggered, true);
    assert.equal(plan.actions.length, 1);
  });

  it("runs when the lead's source is on the list", () => {
    const plan = planWorkflow(simple(["IndiaMART"]), facts({ source: "IndiaMART" }));
    assert.equal(plan.triggered, true);
  });

  it("does NOT run when the lead's source is not on the list", () => {
    const plan = planWorkflow(simple(["IndiaMART"]), facts({ source: "JustDial" }));
    assert.equal(plan.triggered, false);
    assert.equal(plan.actions.length, 0);
  });

  it("does not run a source-filtered workflow for a hand-entered lead", () => {
    // A lead typed into the app has source = null. "Only IndiaMART
    // leads" must not quietly include it.
    const plan = planWorkflow(simple(["IndiaMART"]), facts({ source: null }));
    assert.equal(plan.triggered, false);
  });

  it("explains the skip in the trace", () => {
    const plan = planWorkflow(simple(["IndiaMART"]), facts({ source: "JustDial" }));
    assert.match(plan.trace.join(" "), /not on the list/i);
  });

  it("never fires for an unknown trigger type", () => {
    const definition = simple([]);
    definition.nodes[0].type = "lead.exploded";
    const plan = planWorkflow(definition, facts());
    assert.equal(plan.triggered, false);
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
