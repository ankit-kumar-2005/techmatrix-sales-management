import { MAX_EDGES_PER_WORKFLOW, MAX_NODES_PER_WORKFLOW } from "../config/safeguards";
import { ACTION_LOOP, DECISION_DEFAULT_BRANCH, getRegistryEntry, type DecisionOutcome } from "../registry/definitions";
import { workflowDefinitionSchema } from "../schemas";
import type { ValidationIssue, ValidationResult, WorkflowDefinition } from "@/types/automation";

/**
 * THE ONE VALIDATOR. Five callers, one set of rules:
 *
 *   the builder      live, as the admin works, so problems surface
 *                    before Save rather than after
 *   the save action  server-side, because the builder's copy is a
 *                    convenience and convenience is not security
 *   AI output        the identical function on the identical shape —
 *                    a generated workflow passes exactly what a
 *                    hand-built one passes, and there is no argument,
 *                    flag or branch here that could let it pass on
 *                    easier terms
 *   test mode        before running a synthetic event through it
 *   the engine       before executing a stored definition, because a
 *                    definition stored by an older version of this code
 *                    is untrusted input too
 *
 * Pure and isomorphic — no I/O, no Supabase, no `window`. That is what
 * lets the client and the server run the same code rather than two
 * implementations that agree today.
 *
 * WHAT IT DOES NOT CHECK: whether a referenced person still works here,
 * or whether a lead belongs to the right tenant. Those are not
 * structural facts about a workflow, they are facts about the database
 * at the moment of execution, and they are re-checked inside
 * create_automation_task() every single time it runs. A validator that
 * pretended to answer them would be answering them at the wrong moment.
 */
export function validateWorkflow(definition: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (nodeId: string | null, message: string) => issues.push({ nodeId, message });

  // 1. Structure. Anything that fails here is malformed rather than
  //    merely wrong, so there is nothing further worth reporting about
  //    it — a caller would just get noise derived from a broken shape.
  const structural = workflowDefinitionSchema.safeParse(definition);
  if (!structural.success) {
    const nodeCount = Array.isArray((definition as { nodes?: unknown })?.nodes)
      ? ((definition as { nodes: unknown[] }).nodes.length ?? 0)
      : 0;
    if (nodeCount > MAX_NODES_PER_WORKFLOW) {
      add(null, `A workflow can have at most ${MAX_NODES_PER_WORKFLOW} nodes. This one has ${nodeCount}.`);
    } else {
      add(null, "This workflow could not be read. Start again from a blank canvas.");
    }
    return { ok: false, issues };
  }

  const graph = structural.data as WorkflowDefinition;
  const { nodes, edges } = graph;

  // 2. Ids must be unique, or every lookup below is ambiguous.
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) {
      add(node.id, "Two nodes share the same id.");
    }
    seen.add(node.id);
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  // 3. Every node must name a real capability, and its `kind` must
  //    match what that capability actually is. Both halves matter: an
  //    action mislabelled as a condition would be validated against the
  //    wrong rules and then dispatched by a switch that never expected
  //    it.
  for (const node of nodes) {
    const entry = getRegistryEntry(node.type);
    if (!entry) {
      add(node.id, `"${node.type}" is not something this app can do.`);
      continue;
    }
    if (entry.kind !== node.kind) {
      add(node.id, `"${entry.label}" is a ${entry.kind}, but it is placed as a ${node.kind}.`);
      continue;
    }

    const parsed = entry.configSchema.safeParse(node.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path.join(".");
        add(node.id, field ? `${entry.label} — ${field}: ${issue.message}` : `${entry.label} — ${issue.message}`);
      }
    }
  }

  // 4. Exactly one trigger, and at least one action. A workflow with no
  //    action is a workflow that cannot do anything; a workflow with two
  //    triggers has no single starting point to walk from.
  const triggerNodes = nodes.filter((node) => node.kind === "trigger");
  if (triggerNodes.length === 0) {
    add(null, "Every workflow needs exactly one trigger. Add one from the palette.");
  } else if (triggerNodes.length > 1) {
    for (const extra of triggerNodes.slice(1)) {
      add(extra.id, "A workflow can only have one trigger.");
    }
  }

  if (!nodes.some((node) => node.kind === "action")) {
    add(null, "This workflow does not do anything yet. Add at least one action.");
  }

  // 5. Edges.
  if (edges.length > MAX_EDGES_PER_WORKFLOW) {
    add(null, `A workflow can have at most ${MAX_EDGES_PER_WORKFLOW} connections.`);
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) {
      add(null, "A connection points at a node that is no longer on the canvas.");
      continue;
    }
    if (edge.source === edge.target) {
      add(edge.source, "A node cannot be connected to itself.");
      continue;
    }
    if (nodeById.get(edge.target)?.kind === "trigger") {
      add(edge.target, "Nothing can connect into a trigger — it is where the workflow starts.");
    }

    const key = `${edge.source}->${edge.target}:${edge.branch ?? ""}`;
    if (edgeKeys.has(key)) {
      add(edge.source, "The same two nodes are connected twice.");
    }
    edgeKeys.add(key);
  }

  // 6. Branch outputs. A branching node whose edge does not say which of
  //    its outputs it leaves from is a coin flip at execution time.
  //    Condition and decision are BOTH branching kinds — a condition's
  //    branch is always exactly "true"/"false", a decision's is one of
  //    its own outcome ids (or the fixed DECISION_DEFAULT_BRANCH) — and
  //    every other kind has exactly one, unbranched output.
  for (const node of nodes) {
    const outgoing = edges.filter((edge) => edge.source === node.id);

    if (node.kind === "condition") {
      for (const edge of outgoing) {
        if (edge.branch !== "true" && edge.branch !== "false") {
          add(node.id, "Each line leaving a condition has to come from either its yes or its no output.");
        }
      }
      if (outgoing.length === 0) {
        add(node.id, "This condition does not lead anywhere. Connect at least one of its outputs.");
      }
      for (const branch of ["true", "false"] as const) {
        if (outgoing.filter((edge) => edge.branch === branch).length > 1) {
          add(node.id, `The ${branch === "true" ? "yes" : "no"} output can only lead to one node.`);
        }
      }
    } else if (node.kind === "decision") {
      // A malformed config (caught in step 3 already) has no reliable
      // outcome list to check branches against — skip rather than
      // produce noise derived from a shape that is already reported as
      // broken.
      const outcomes = Array.isArray((node.config as { outcomes?: unknown }).outcomes)
        ? ((node.config as { outcomes: DecisionOutcome[] }).outcomes)
        : null;
      if (outcomes) {
        const validBranches = new Set<string>([...outcomes.map((outcome) => outcome.id), DECISION_DEFAULT_BRANCH]);
        for (const edge of outgoing) {
          if (!edge.branch || !validBranches.has(edge.branch)) {
            add(node.id, "Each line leaving a decision has to come from one of its named outcomes, or Otherwise.");
          }
        }
        for (const branch of validBranches) {
          if (outgoing.filter((edge) => edge.branch === branch).length > 1) {
            add(node.id, `One output of this decision leads to more than one node. Each output can only lead to one.`);
          }
        }
      }
      if (outgoing.length === 0) {
        add(node.id, "This decision does not lead anywhere. Connect at least one of its outcomes.");
      }
    } else if (outgoing.some((edge) => edge.branch)) {
      add(node.id, "Only a condition or a decision has more than one output.");
    }
  }

  // 7. Reachability. An orphaned node is almost always a half-finished
  //    edit rather than an intention, and silently never running is the
  //    worst way to find that out — this feature runs with nobody
  //    watching.
  if (triggerNodes.length === 1) {
    const reachable = new Set<string>([triggerNodes[0].id]);
    const queue = [triggerNodes[0].id];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const edge of edges) {
        if (edge.source === current && !reachable.has(edge.target)) {
          reachable.add(edge.target);
          queue.push(edge.target);
        }
      }
    }
    for (const node of nodes) {
      if (!reachable.has(node.id)) {
        add(node.id, "Nothing leads to this node, so it will never run. Connect it or remove it.");
      }
    }
  }

  // 8. Node-reference fields — every Task/Contact Update/Deactivate
  //    action names an earlier Create node by id (see the migration's
  //    own design note 7 and registry/executors.ts's resolveTargetKey).
  //    Three things must all be true for that reference to ever resolve
  //    to anything at runtime, and a violation of any of them is checked
  //    here rather than discovered as a permanent target_not_found at
  //    3am: the named node must exist, it must be the right KIND of
  //    Create node (never an arbitrary node id), and it must be
  //    reachable by at least one path ending at THIS node — a reference
  //    to a node nothing can ever route through could never resolve, no
  //    matter what a lead's facts are.
  for (const node of nodes) {
    const entry = getRegistryEntry(node.type);
    if (!entry) continue;

    for (const field of entry.fields) {
      if (field.kind !== "node-reference") continue;

      const sourceNodeId = (node.config as Record<string, unknown>)[field.name];
      if (typeof sourceNodeId !== "string" || sourceNodeId.trim() === "") {
        // Already reported by the schema check in step 3 (the field is
        // required) — not repeated here.
        continue;
      }

      const referenced = nodeById.get(sourceNodeId);
      if (!referenced) {
        add(node.id, `"${field.label}" points at a step that no longer exists on this canvas.`);
        continue;
      }
      if (field.targetType && referenced.type !== field.targetType) {
        add(node.id, `"${field.label}" must point at a ${getRegistryEntry(field.targetType)?.label ?? field.targetType} step.`);
        continue;
      }
      if (!isAncestor(sourceNodeId, node.id, edges)) {
        add(node.id, `"${field.label}" points at a step no path from here can ever reach — connect it upstream of this node first.`);
      }
    }
  }

  // 9. A Loop's body — checked structurally, at save time, rather than
  //    discovered as "no step connected to run" at 3am. A Loop's body is
  //    the SINGLE node its own output connects to (see planWorkflow's
  //    own note on why that is graph structure, not a config field) —
  //    which means it has to actually BE exactly that: one edge out, to
  //    a real action, never another Loop (nesting would need each Loop
  //    to capture its own body during the SAME walk that is already
  //    capturing the outer one, which planWorkflow does not do — a
  //    nested Loop would silently fail at runtime instead, exactly the
  //    kind of half-built behaviour this refuses at the door instead),
  //    and not an action anything else also points at, so it can never
  //    be ambiguous whether a given node belongs to a loop or is a
  //    normal step something else also reaches.
  for (const node of nodes) {
    if (node.type !== ACTION_LOOP) continue;
    const outgoing = edges.filter((edge) => edge.source === node.id);
    if (outgoing.length !== 1) {
      add(node.id, "A Loop must connect to exactly one step to repeat — no more, no fewer.");
      continue;
    }
    const bodyId = outgoing[0].target;
    const bodyNode = nodeById.get(bodyId);
    if (!bodyNode || bodyNode.kind !== "action") {
      add(node.id, "A Loop's step to repeat must be an action — not a condition, decision, or another Loop.");
      continue;
    }
    if (bodyNode.type === ACTION_LOOP) {
      add(node.id, "A Loop cannot repeat another Loop — nesting isn't available yet.");
      continue;
    }
    const bodyIncoming = edges.filter((edge) => edge.target === bodyId);
    if (bodyIncoming.length > 1) {
      add(node.id, "The step this Loop repeats cannot also be reached any other way on this canvas.");
    }
  }

  // 10. Cycles IN THE GRAPH ITSELF. Distinct from the cross-automation
  //    loop safeguards in the engine, which bound what happens between
  //    automations at runtime. This one is structural: a definition that
  //    loops back on itself would make the engine's own walk
  //    non-terminating, so it is refused at the door rather than
  //    depended on to trip a limit later.
  if (hasCycle(nodes.map((node) => node.id), edges)) {
    add(null, "This workflow loops back on itself. Remove the connection that goes backwards.");
  }

  return { ok: issues.length === 0, issues };
}

/** Is `candidateId` reachable by walking BACKWARD (target -> source)
 *  from `nodeId` — i.e. does at least one path from candidateId to
 *  nodeId exist? Used only for node-reference fields, where "connected
 *  upstream, on at least one path" is the bar (not "on every path" —
 *  a reference that only resolves on some branches is ordinary
 *  conditional logic, handled at runtime by target_not_found, not a
 *  validation error). Plain BFS over the reversed edge set; the graph
 *  is already confirmed acyclic by the time this matters in practice,
 *  but this terminates correctly either way since `visited` is checked
 *  before enqueueing. */
function isAncestor(candidateId: string, nodeId: string, edges: ReadonlyArray<{ source: string; target: string }>): boolean {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.target);
    if (list) {
      list.push(edge.source);
    } else {
      incoming.set(edge.target, [edge.source]);
    }
  }

  const visited = new Set<string>([nodeId]);
  const queue = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const parent of incoming.get(current) ?? []) {
      if (parent === candidateId) return true;
      if (!visited.has(parent)) {
        visited.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** Iterative DFS with an explicit colour map — iterative rather than
 *  recursive so a deep graph cannot blow the stack in the browser. */
function hasCycle(nodeIds: string[], edges: ReadonlyArray<{ source: string; target: string }>): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.source);
    if (list) {
      list.push(edge.target);
    } else {
      outgoing.set(edge.source, [edge.target]);
    }
  }

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>(nodeIds.map((id) => [id, WHITE]));

  for (const start of nodeIds) {
    if (colour.get(start) !== WHITE) continue;

    const stack: Array<{ id: string; index: number }> = [{ id: start, index: 0 }];
    colour.set(start, GREY);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbours = outgoing.get(frame.id) ?? [];

      if (frame.index >= neighbours.length) {
        colour.set(frame.id, BLACK);
        stack.pop();
        continue;
      }

      const next = neighbours[frame.index];
      frame.index += 1;

      const nextColour = colour.get(next);
      if (nextColour === GREY) {
        // Back edge to something still on the stack — a cycle.
        return true;
      }
      if (nextColour === WHITE) {
        colour.set(next, GREY);
        stack.push({ id: next, index: 0 });
      }
    }
  }

  return false;
}

/** The trigger's registry key, for storing on the version row so the
 *  engine can match events in SQL instead of parsing every definition. */
export function getTriggerType(definition: WorkflowDefinition): string | null {
  return definition.nodes.find((node) => node.kind === "trigger")?.type ?? null;
}

/**
 * The trigger's configured eventType ('created' | 'updated' |
 * 'created_or_updated'), for storing on the version row as
 * trigger_event_type — the same denormalize-for-cheap-SQL-matching move
 * getTriggerType already makes, extended to the second fact the engine
 * now needs to filter on before it ever parses `definition`.
 *
 * Defaults to "created" for a trigger with no eventType at all — not a
 * fallback invented here, but the same default leadCreatedConfigSchema
 * itself declares, so a definition saved before this field existed and
 * one that explicitly chose "created" are indistinguishable, which is
 * exactly correct: they always meant the same thing.
 */
export function getTriggerEventType(definition: WorkflowDefinition): "created" | "updated" | "created_or_updated" {
  const trigger = definition.nodes.find((node) => node.kind === "trigger");
  const eventType = trigger?.config.eventType;
  return eventType === "updated" || eventType === "created_or_updated" ? eventType : "created";
}
