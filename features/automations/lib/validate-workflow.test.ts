import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_EDGES_PER_WORKFLOW, MAX_NODES_PER_WORKFLOW } from "../config/safeguards";
import { ACTION_TASK_CREATE, CONDITION_LEAD_HAS_OWNER, TRIGGER_LEAD_CREATED } from "../registry/definitions";
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
        config: { sources: ["IndiaMART"] },
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

  it("accepts a trigger with no source filter (meaning: any source)", () => {
    const definition = validWorkflow();
    definition.nodes[0].config = { sources: [] };
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
      config: { sources: [] },
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
        { id: "t1", kind: "trigger", type: TRIGGER_LEAD_CREATED, position: { x: 0, y: 0 }, config: { sources: [] } },
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
    assert.match(messages(definition), /only a condition has yes and no outputs/i);
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
