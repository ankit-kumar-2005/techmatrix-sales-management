import {
  ACTION_TASK_CREATE,
  CONDITION_LEAD_HAS_OWNER,
  CONDITION_LEAD_SOURCE_IS,
  SUBJECT_TOKENS,
  TRIGGER_LEAD_CREATED,
} from "../registry/definitions";
import { MAX_NODES_PER_WORKFLOW } from "../config/safeguards";
import type { WorkflowDefinition, WorkflowNode } from "@/types/automation";

/**
 * The facts a workflow is evaluated against. Deliberately a small, flat,
 * FIXED record rather than the lead row itself: a condition can only
 * read what is named here, so a workflow definition has no way to reach
 * a field it was never granted, however it was authored.
 */
export type LeadFacts = {
  leadId: string;
  source: string | null;
  hasOwner: boolean;
  company: string;
  contactName: string;
};

export type PlannedAction = {
  nodeId: string;
  type: string;
  config: Record<string, unknown>;
};

export type WorkflowPlan = {
  /** False when the trigger's own filter excluded this event. The
   *  automation is not at fault and nothing ran — recorded as `skipped`
   *  rather than as a failure. */
  triggered: boolean;
  actions: PlannedAction[];
  /** One readable line per decision, for the run log and for test mode.
   *  Never contains anything a caller supplied beyond the lead's own
   *  source name. */
  trace: string[];
};

/**
 * Walks a validated workflow and decides what should happen — WITHOUT
 * doing any of it.
 *
 * Pure. No Supabase, no fetch, no clock, no randomness. That is the
 * point: the execution engine and test mode run this identical function
 * over the identical definition, so what an admin sees in a test is
 * what the engine will decide at 3am. Test mode differs from a real run
 * in exactly one respect — it stops here, and never calls an executor.
 *
 * Assumes the definition has already passed validateWorkflow(). It is
 * still defensive about node lookups, because the engine re-validates
 * stored definitions but a plan built from a partially-edited canvas in
 * the builder may be one keystroke behind.
 */
export function planWorkflow(definition: WorkflowDefinition, facts: LeadFacts): WorkflowPlan {
  const trace: string[] = [];
  const actions: PlannedAction[] = [];

  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const trigger = definition.nodes.find((node) => node.kind === "trigger");

  if (!trigger) {
    return { triggered: false, actions, trace: ["This workflow has no trigger."] };
  }

  if (!evaluateTrigger(trigger, facts, trace)) {
    return { triggered: false, actions, trace };
  }

  // Breadth-first from the trigger. The step budget is the node ceiling,
  // not an arbitrary number: validateWorkflow() has already refused
  // anything with a cycle, so a graph inside that ceiling cannot make
  // this loop run longer than the ceiling. The guard is a backstop for
  // the one caller that plans an unvalidated canvas mid-edit.
  const queue: string[] = outgoingTargets(definition, trigger.id, null);
  const visited = new Set<string>([trigger.id]);
  let steps = 0;

  while (queue.length > 0 && steps < MAX_NODES_PER_WORKFLOW) {
    steps += 1;
    const nodeId = queue.shift() as string;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodeById.get(nodeId);
    if (!node) continue;

    if (node.kind === "condition") {
      const result = evaluateCondition(node, facts, trace);
      for (const next of outgoingTargets(definition, node.id, result ? "true" : "false")) {
        queue.push(next);
      }
      continue;
    }

    if (node.kind === "action") {
      actions.push({ nodeId: node.id, type: node.type, config: node.config });
      for (const next of outgoingTargets(definition, node.id, null)) {
        queue.push(next);
      }
    }
  }

  if (actions.length === 0) {
    trace.push("No action was reached on this path.");
  }

  return { triggered: true, actions, trace };
}

function outgoingTargets(
  definition: WorkflowDefinition,
  nodeId: string,
  branch: "true" | "false" | null,
): string[] {
  return definition.edges
    .filter((edge) => edge.source === nodeId && (branch === null || edge.branch === branch))
    .map((edge) => edge.target);
}

function evaluateTrigger(node: WorkflowNode, facts: LeadFacts, trace: string[]): boolean {
  if (node.type !== TRIGGER_LEAD_CREATED) {
    // An unknown trigger never fires. validateWorkflow() rejects one
    // long before here; this is the belt to that braces.
    trace.push(`Unknown trigger "${node.type}" — nothing ran.`);
    return false;
  }

  const sources = asStringArray(node.config.sources);
  if (sources.length === 0) {
    trace.push("Trigger: a lead was created (any source).");
    return true;
  }

  const matched = facts.source !== null && sources.includes(facts.source);
  trace.push(
    matched
      ? `Trigger: a lead was created from ${facts.source}, which is on the list.`
      : `Trigger: the lead came from ${facts.source ?? "no recorded source"}, which is not on the list — skipped.`,
  );
  return matched;
}

function evaluateCondition(node: WorkflowNode, facts: LeadFacts, trace: string[]): boolean {
  if (node.type === CONDITION_LEAD_SOURCE_IS) {
    const sources = asStringArray(node.config.sources);
    const result = facts.source !== null && sources.includes(facts.source);
    trace.push(`Condition: lead source is ${facts.source ?? "not set"} → ${result ? "yes" : "no"}.`);
    return result;
  }

  if (node.type === CONDITION_LEAD_HAS_OWNER) {
    const expected = node.config.expected === "yes";
    const result = facts.hasOwner === expected;
    trace.push(
      `Condition: the lead ${facts.hasOwner ? "already has" : "does not have"} an owner → ${result ? "yes" : "no"}.`,
    );
    return result;
  }

  trace.push(`Unknown condition "${node.type}" → treated as no.`);
  return false;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Substitutes the registry's fixed placeholder tokens into a subject or
 * description.
 *
 * A LITERAL REPLACE OVER A CLOSED LIST — not a template engine. It
 * iterates SUBJECT_TOKENS and replaces each exact string with a value
 * read from LeadFacts. There is no expression to evaluate, no property
 * path resolved from the text, and no way for `{{anything.else}}` to
 * reach a field: an unrecognised placeholder is simply left in the
 * string, visible to whoever reads the task, which is the honest
 * outcome.
 */
export function renderTemplate(text: string, facts: LeadFacts): string {
  const values: Record<string, string> = {
    "{{lead.company}}": facts.company,
    "{{lead.contact_name}}": facts.contactName,
    "{{lead.source}}": facts.source ?? "",
  };

  let out = text;
  for (const { token } of SUBJECT_TOKENS) {
    if (out.includes(token)) {
      out = out.split(token).join(values[token] ?? "");
    }
  }
  return out.trim();
}

/** Registry key helpers used by both the engine and test mode, so
 *  neither hardcodes the string. */
export const PLANNABLE_ACTION_KEYS = [ACTION_TASK_CREATE] as const;
