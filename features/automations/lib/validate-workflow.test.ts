import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_EDGES_PER_WORKFLOW, MAX_NODES_PER_WORKFLOW } from "../config/safeguards";
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
  DECISION_DEFAULT_BRANCH,
  DECISION_MULTI_OUTCOME,
  TRIGGER_LEAD_CREATED,
} from "../registry/definitions";
import { getTriggerType, validateWorkflow } from "./validate-workflow";
import type { WorkflowDefinition } from "@/types/automation";

/**
 * THE ONE VALIDATOR, tested on its own.
 *
 * This is the function the builder runs live, the save action runs
 * server-side, the AI output is checked against, test mode runs before a
 * dry run, and the ENGINE runs against a stored definition immediately
 * before executing it. A workflow that passes here is a workflow all
 * five of those accepted, because there is only one of it.
 */

const ASSIGNEE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function validTaskConfig(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Call {{lead.company}}",
    description: null,
    type: "Call",
    priority: "High",
    dueInDays: 1,
    assignmentMode: "Fixed",
    assigneeId: ASSIGNEE,
    rotation: [],
    ...overrides,
  };
}

function validWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    nodes: [
      {
        id: "t1",
        kind: "trigger",
        type: TRIGGER_LEAD_CREATED,
        position: { x: 0, y: 0 },
        config: {},
      },
      {
        id: "a1",
        kind: "action",
        type: ACTION_TASK_CREATE,
        position: { x: 300, y: 0 },
        config: validTaskConfig(),
      },
    ],
    edges: [{ id: "e1", source: "t1", target: "a1" }],
    ...overrides,
  };
}

function messages(definition: unknown): string {
  return validateWorkflow(definition)
    .issues.map((issue) => issue.message)
    .join(" | ");
}

describe("validateWorkflow — the happy path", () => {
  it("accepts a minimal trigger -> action workflow", () => {
    const result = validateWorkflow(validWorkflow());
    assert.equal(result.ok, true, messages(validWorkflow()));
    assert.equal(result.issues.length, 0);
  });

  it("accepts a trigger with no entry condition at all (the default)", () => {
    const definition = validWorkflow();
    definition.nodes[0].config = {};
    assert.equal(validateWorkflow(definition).ok, true);
  });

  it("accepts a round-robin action with a non-empty rotation", () => {
    const definition = validWorkflow();
    definition.nodes[1].config = validTaskConfig({
      assignmentMode: "RoundRobin",
      assigneeId: null,
      rotation: [ASSIGNEE],
    });
    assert.equal(validateWorkflow(definition).ok, true, messages(definition));
  });
});

describe("validateWorkflow — structure", () => {
  it("rejects a workflow with no trigger", () => {
    const definition = validWorkflow();
    definition.nodes = definition.nodes.filter((node) => node.kind !== "trigger");
    definition.edges = [];
    assert.match(messages(definition), /needs exactly one trigger/i);
  });

  it("rejects two triggers", () => {
    const definition = validWorkflow();
    definition.nodes.push({
      id: "t2",
      kind: "trigger",
      type: TRIGGER_LEAD_CREATED,
      position: { x: 0, y: 200 },
      config: {},
    });
    assert.match(messages(definition), /only have one trigger/i);
  });

  it("rejects a workflow that does nothing", () => {
    const definition = validWorkflow();
    definition.nodes = definition.nodes.filter((node) => node.kind !== "action");
    definition.edges = [];
    assert.match(messages(definition), /does not do anything/i);
  });

  it("rejects an unreachable node", () => {
    const definition = validWorkflow();
    definition.nodes.push({
      id: "a2",
      kind: "action",
      type: ACTION_TASK_CREATE,
      position: { x: 600, y: 200 },
      config: validTaskConfig(),
    });
    // deliberately not connected
    assert.match(messages(definition), /never run/i);
  });

  it("rejects an edge pointing into the trigger", () => {
    const definition = validWorkflow();
    definition.edges.push({ id: "e2", source: "a1", target: "t1" });
    assert.match(messages(definition), /connect into a trigger|loops back/i);
  });

  it("rejects a cycle", () => {
    const definition = validWorkflow();
    definition.nodes.push({
      id: "a2",
      kind: "action",
      type: ACTION_TASK_CREATE,
      position: { x: 600, y: 0 },
      config: validTaskConfig(),
    });
    definition.edges.push({ id: "e2", source: "a1", target: "a2" });
    definition.edges.push({ id: "e3", source: "a2", target: "a1" });
    assert.match(messages(definition), /loops back on itself/i);
  });

  it("rejects a node connected to itself", () => {
    const definition = validWorkflow();
    definition.edges.push({ id: "e2", source: "a1", target: "a1" });
    assert.match(messages(definition), /connected to itself/i);
  });

  it("rejects duplicate node ids", () => {
    const definition = validWorkflow();
    definition.nodes.push({ ...definition.nodes[1], position: { x: 300, y: 200 } });
    assert.match(messages(definition), /same id/i);
  });

  it("rejects an edge pointing at a node that is not on the canvas", () => {
    const definition = validWorkflow();
    definition.edges.push({ id: "e2", source: "a1", target: "ghost" });
    assert.match(messages(definition), /no longer on the canvas/i);
  });
});

describe("validateWorkflow — the registry is the menu", () => {
  it("rejects a node type that does not exist", () => {
    // THE CENTRAL SAFETY PROPERTY. Whether a workflow was hand-built or
    // generated, a step the app cannot perform has nothing to look up in
    // the registry, so it is refused here — before storage, and again
    // before execution.
    const definition = validWorkflow();
    definition.nodes[1].type = "lead.delete_everything";
    assert.match(messages(definition), /not something this app can do/i);
  });

  it("rejects an action smuggled in as a condition", () => {
    const definition = validWorkflow();
    definition.nodes[1].kind = "condition";
    assert.match(messages(definition), /is a action, but it is placed as a condition/i);
  });

  it("rejects a task action with no assignee in Fixed mode", () => {
    const definition = validWorkflow();
    definition.nodes[1].config = validTaskConfig({ assigneeId: null });
    assert.match(messages(definition), /assigneeId/);
  });

  it("rejects a round-robin action with an empty rotation", () => {
    const definition = validWorkflow();
    definition.nodes[1].config = validTaskConfig({
      assignmentMode: "RoundRobin",
      assigneeId: null,
      rotation: [],
    });
    assert.match(messages(definition), /rotation/);
  });

  it("rejects a due-date offset beyond the safeguard", () => {
    const definition = validWorkflow();
    definition.nodes[1].config = validTaskConfig({ dueInDays: 100_000 });
    assert.equal(validateWorkflow(definition).ok, false);
  });

  it("rejects a negative due-date offset", () => {
    const definition = validWorkflow();
    definition.nodes[1].config = validTaskConfig({ dueInDays: -1 });
    assert.equal(validateWorkflow(definition).ok, false);
  });

  it("rejects a blank subject", () => {
    const definition = validWorkflow();
    definition.nodes[1].config = validTaskConfig({ subject: "   " });
    assert.equal(validateWorkflow(definition).ok, false);
  });
});

describe("validateWorkflow — condition branches", () => {
  function withCondition(): WorkflowDefinition {
    return {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        {
          id: "c1",
          kind: "condition",
          type: CONDITION_LEAD_HAS_OWNER,
          position: { x: 300, y: 0 },
          config: { expected: "no" },
        },
        {
          id: "a1",
          kind: "action",
          type: ACTION_TASK_CREATE,
          position: { x: 600, y: 0 },
          config: validTaskConfig(),
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "c1" },
        { id: "e2", source: "c1", target: "a1", branch: "true" },
      ],
    };
  }

  it("accepts a condition with one branch connected", () => {
    assert.equal(validateWorkflow(withCondition()).ok, true, messages(withCondition()));
  });

  it("rejects an unbranded edge leaving a condition", () => {
    const definition = withCondition();
    delete definition.edges[1].branch;
    assert.match(messages(definition), /yes or its no output/i);
  });

  it("rejects a condition that leads nowhere", () => {
    const definition = withCondition();
    definition.edges = [definition.edges[0]];
    // The action is now unreachable too; both are reported.
    assert.match(messages(definition), /does not lead anywhere/i);
  });

  it("rejects two edges from the same branch", () => {
    const definition = withCondition();
    definition.nodes.push({
      id: "a2",
      kind: "action",
      type: ACTION_TASK_CREATE,
      position: { x: 600, y: 200 },
      config: validTaskConfig(),
    });
    definition.edges.push({ id: "e3", source: "c1", target: "a2", branch: "true" });
    assert.match(messages(definition), /can only lead to one node/i);
  });

  it("rejects a branch label on an edge leaving a non-condition", () => {
    const definition = validWorkflow();
    definition.edges[0].branch = "true";
    assert.match(messages(definition), /only a condition or a decision has more than one output/i);
  });
});

describe("validateWorkflow — decision branches", () => {
  function withDecision(): WorkflowDefinition {
    return {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
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
                root: { kind: "group", match: "all", rules: [{ kind: "rule", field: "deal_value", operator: "greater_than", value: 100, valueTo: null }] },
              },
            ],
          },
        },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: -100 }, config: validTaskConfig() },
        { id: "a2", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 100 }, config: validTaskConfig() },
      ],
      edges: [
        { id: "e1", source: "t1", target: "d1" },
        { id: "e2", source: "d1", target: "a1", branch: "high" },
        { id: "e3", source: "d1", target: "a2", branch: DECISION_DEFAULT_BRANCH },
      ],
    };
  }

  it("accepts a decision with its outcome and default both connected", () => {
    assert.equal(validateWorkflow(withDecision()).ok, true, messages(withDecision()));
  });

  it("accepts a decision with only the default path connected", () => {
    const definition = withDecision();
    definition.edges = [definition.edges[0], definition.edges[2]];
    definition.nodes = definition.nodes.filter((node) => node.id !== "a1");
    assert.equal(validateWorkflow(definition).ok, true, messages(definition));
  });

  it("rejects an edge leaving a decision with a branch that names no real outcome", () => {
    const definition = withDecision();
    definition.edges[1].branch = "not-a-real-outcome";
    assert.match(messages(definition), /one of its named outcomes, or Otherwise/i);
  });

  it("rejects two edges leaving the same decision outcome", () => {
    const definition = withDecision();
    definition.nodes.push({ id: "a3", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 200 }, config: validTaskConfig() });
    definition.edges.push({ id: "e4", source: "d1", target: "a3", branch: "high" });
    assert.match(messages(definition), /leads to more than one node/i);
  });

  it("rejects a decision that leads nowhere at all", () => {
    const definition = withDecision();
    definition.edges = [definition.edges[0]];
    definition.nodes = definition.nodes.filter((node) => node.kind !== "action");
    assert.match(messages(definition), /does not lead anywhere/i);
  });
});

describe("validateWorkflow — assignment nodes", () => {
  it("accepts an assignment node with a single, unbranded output", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        {
          id: "s1",
          kind: "assignment",
          type: ASSIGNMENT_SET_VARIABLE,
          position: { x: 300, y: 0 },
          config: { assignments: [{ variable: "note", operator: "set", valueSource: "static", staticValue: "x", fieldKey: "" }] },
        },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 0 }, config: validTaskConfig() },
      ],
      edges: [
        { id: "e1", source: "t1", target: "s1" },
        { id: "e2", source: "s1", target: "a1" },
      ],
    };
    assert.equal(validateWorkflow(definition).ok, true, messages(definition));
  });

  it("rejects a branch label on an edge leaving an assignment", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        {
          id: "s1",
          kind: "assignment",
          type: ASSIGNMENT_SET_VARIABLE,
          position: { x: 300, y: 0 },
          config: { assignments: [{ variable: "note", operator: "set", valueSource: "static", staticValue: "x", fieldKey: "" }] },
        },
        { id: "a1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 600, y: 0 }, config: validTaskConfig() },
      ],
      edges: [
        { id: "e1", source: "t1", target: "s1" },
        { id: "e2", source: "s1", target: "a1", branch: "true" },
      ],
    };
    assert.match(messages(definition), /only a condition or a decision has more than one output/i);
  });
});

describe("validateWorkflow — node-reference fields (Task/Contact Update/Deactivate targeting)", () => {
  function withCreateAndUpdate(overrides: { updateSourceNodeId?: string; noEdgeFromCreateToUpdate?: boolean } = {}): WorkflowDefinition {
    return {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        { id: "create1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 0 }, config: validTaskConfig() },
        {
          id: "update1",
          kind: "action",
          type: ACTION_TASK_UPDATE,
          position: { x: 600, y: 0 },
          config: {
            sourceNodeId: overrides.updateSourceNodeId ?? "create1",
            subject: "New subject",
            description: "",
            priority: "",
            due_date: "",
            type: "",
            status: "",
            assignmentMode: "None",
            assigneeId: null,
            rotation: [],
          },
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "create1" },
        ...(overrides.noEdgeFromCreateToUpdate ? [] : [{ id: "e2", source: "create1", target: "update1" }]),
      ],
    };
  }

  it("accepts a valid Update Task pointing at an earlier Create Task ancestor", () => {
    const definition = withCreateAndUpdate();
    assert.equal(validateWorkflow(definition).ok, true, messages(definition));
  });

  it("rejects a sourceNodeId that names no node on the canvas", () => {
    const definition = withCreateAndUpdate({ updateSourceNodeId: "does-not-exist" });
    assert.match(messages(definition), /no longer exists on this canvas/i);
  });

  it("rejects a sourceNodeId pointing at the wrong kind of node (not a Create Task)", () => {
    const definition = withCreateAndUpdate({ updateSourceNodeId: "t1" });
    definition.edges.push({ id: "e3", source: "t1", target: "update1" });
    assert.match(messages(definition), /must point at a/i);
  });

  it("rejects a sourceNodeId no path from this node can ever reach", () => {
    const definition = withCreateAndUpdate({ noEdgeFromCreateToUpdate: true });
    // update1 needs SOME path in from the trigger to be reachable at all
    // (existing reachability rule) — give it one that does not pass
    // through create1, so create1 is genuinely not its ancestor.
    definition.edges.push({ id: "e3", source: "t1", target: "update1" });
    assert.match(messages(definition), /no path from here can ever reach/i);
  });

  it("accepts a reference reachable via only ONE of several branches (ordinary conditional logic, not an error)", () => {
    // create1 -> update1 on one path; a second, unrelated action node
    // also reachable straight from the trigger. The reference need not
    // be on EVERY path to this node, only some.
    const definition = withCreateAndUpdate();
    definition.nodes.push({ id: "other", kind: "action", type: ACTION_TASK_CREATE, position: { x: 300, y: 200 }, config: validTaskConfig() });
    definition.edges.push({ id: "e4", source: "t1", target: "other" });
    assert.equal(validateWorkflow(definition).ok, true, messages(definition));
  });

  it("Deactivate Task uses the identical targeting rule", () => {
    const definition = withCreateAndUpdate();
    definition.nodes[2] = {
      id: "deact1",
      kind: "action",
      type: ACTION_TASK_DEACTIVATE,
      position: { x: 600, y: 0 },
      config: { sourceNodeId: "does-not-exist" },
    };
    definition.edges[1] = { id: "e2", source: "create1", target: "deact1" };
    assert.match(messages(definition), /no longer exists on this canvas/i);
  });
});

describe("validateWorkflow — Create Contact requires an assignee, no 'None' mode", () => {
  it("rejects a Create Contact node whose assignmentMode omits an assignee", () => {
    const definition: WorkflowDefinition = {
      nodes: [
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: {} },
        {
          id: "c1",
          kind: "action",
          type: ACTION_CONTACT_CREATE,
          position: { x: 300, y: 0 },
          config: { name: "Priya", company: "", title: "", email: "", phone: "", assignmentMode: "Fixed", assigneeId: null, rotation: [] },
        },
      ],
      edges: [{ id: "e1", source: "t1", target: "c1" }],
    };
    assert.match(messages(definition), /assigneeId/);
  });
});

describe("validateWorkflow — limits come from the safeguards config", () => {
  it("rejects more nodes than the ceiling allows", () => {
    const definition = validWorkflow();
    for (let index = 0; index < MAX_NODES_PER_WORKFLOW + 5; index += 1) {
      definition.nodes.push({
        id: `extra-${index}`,
        kind: "action",
        type: ACTION_TASK_CREATE,
        position: { x: 0, y: 0 },
        config: validTaskConfig(),
      });
    }
    assert.match(messages(definition), new RegExp(String(MAX_NODES_PER_WORKFLOW)));
  });

  it("rejects more edges than the ceiling allows", () => {
    const definition = validWorkflow();
    for (let index = 0; index < MAX_EDGES_PER_WORKFLOW + 2; index += 1) {
      definition.edges.push({ id: `extra-${index}`, source: "t1", target: "a1" });
    }
    assert.equal(validateWorkflow(definition).ok, false);
  });
});

describe("validateWorkflow — malformed input", () => {
  for (const [label, value] of [
    ["null", null],
    ["a string", "not a workflow"],
    ["an empty object", {}],
    ["nodes as a string", { nodes: "x", edges: [] }],
    ["a node with no type", { nodes: [{ id: "a", kind: "action", position: { x: 0, y: 0 }, config: {} }], edges: [] }],
    [
      "a non-finite position",
      {
        nodes: [
          { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: Infinity, y: 0 }, config: {} },
        ],
        edges: [],
      },
    ],
  ] as const) {
    it(`refuses ${label} without throwing`, () => {
      const result = validateWorkflow(value);
      assert.equal(result.ok, false);
      assert.ok(result.issues.length > 0);
    });
  }
});

describe("validateWorkflow — a Loop's body must be exactly one real, exclusively-owned action", () => {
  function withLoop(overrides: {
    loopEdges?: { target: string; extra?: boolean }[];
    bodyKind?: "action" | "condition";
    bodyType?: string;
    extraIncoming?: boolean;
  } = {}) {
    const bodyType = overrides.bodyType ?? ACTION_LEAD_DEACTIVATE;
    const definition: WorkflowDefinition = {
      nodes: [
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
        {
          id: "body1",
          kind: overrides.bodyKind ?? "action",
          type: bodyType,
          position: { x: 900, y: 0 },
          config: bodyType === ACTION_LEAD_DEACTIVATE ? {} : {},
        },
      ],
      edges: [
        { id: "e1", source: "t1", target: "get1" },
        { id: "e2", source: "get1", target: "loop1" },
        { id: "e3", source: "loop1", target: "body1" },
      ],
    };
    if (overrides.extraIncoming) {
      definition.nodes.push({ id: "extra1", kind: "action", type: ACTION_TASK_CREATE, position: { x: 0, y: 300 }, config: validTaskConfig() });
      definition.edges.push({ id: "e4", source: "extra1", target: "body1" });
    }
    return definition;
  }

  it("a Loop with exactly one edge to a real action is valid", () => {
    assert.equal(validateWorkflow(withLoop()).ok, true);
  });

  it("a Loop with zero outgoing edges is refused", () => {
    const definition = withLoop();
    definition.edges = definition.edges.filter((e) => e.source !== "loop1");
    assert.match(messages(definition), /exactly one step/);
  });

  it("a Loop with two outgoing edges is refused", () => {
    const definition = withLoop();
    definition.nodes.push({ id: "body2", kind: "action", type: ACTION_LEAD_DEACTIVATE, position: { x: 900, y: 200 }, config: {} });
    definition.edges.push({ id: "e5", source: "loop1", target: "body2" });
    assert.match(messages(definition), /exactly one step/);
  });

  it("a Loop pointed at a condition, not an action, is refused", () => {
    const definition = withLoop({ bodyKind: "condition", bodyType: CONDITION_LEAD_HAS_OWNER });
    assert.match(messages(definition), /must be an action/);
  });

  it("a Loop pointed at another Loop is refused — no nesting", () => {
    const definition = withLoop({ bodyType: ACTION_LOOP });
    // Give the nested loop node a config shape that would otherwise pass.
    definition.nodes[3].config = { collectionVariable: "items", itemVariable: "inner" };
    assert.match(messages(definition), /cannot repeat another Loop/);
  });

  it("a Loop's body node cannot also be reached by any other edge on the canvas", () => {
    const definition = withLoop({ extraIncoming: true });
    assert.match(messages(definition), /cannot also be reached/);
  });
});

describe("getTriggerType", () => {
  it("returns the trigger's registry key", () => {
    assert.equal(getTriggerType(validWorkflow()), TRIGGER_LEAD_CREATED);
  });

  it("returns null when there is no trigger", () => {
    const definition = validWorkflow();
    definition.nodes = definition.nodes.filter((node) => node.kind !== "trigger");
    assert.equal(getTriggerType(definition), null);
  });
});
