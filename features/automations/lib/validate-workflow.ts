import { MAX_EDGES_PER_WORKFLOW, MAX_NODES_PER_WORKFLOW } from "../config/safeguards";
import { getRegistryEntry } from "../registry/definitions";
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

  // 6. Condition branches. A condition that does not say which of its
  //    two outputs an edge leaves from is a coin flip at execution time.
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
    } else if (outgoing.some((edge) => edge.branch)) {
      add(node.id, "Only a condition has yes and no outputs.");
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

  // 8. Cycles IN THE GRAPH ITSELF. Distinct from the cross-automation
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
