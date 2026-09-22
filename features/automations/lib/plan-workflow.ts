import {
  ACTION_CONTACT_CREATE,
  ACTION_CONTACT_DEACTIVATE,
  ACTION_CONTACT_UPDATE,
  ACTION_GET_RECORDS,
  ACTION_LEAD_DEACTIVATE,
  ACTION_LEAD_UPDATE,
  ACTION_LOOP,
  ACTION_TASK_CREATE,
  ACTION_TASK_DEACTIVATE,
  ACTION_TASK_UPDATE,
  CONDITION_FIELD_GROUP,
  CONDITION_LEAD_HAS_OWNER,
  CONDITION_LEAD_SOURCE_IS,
  DECISION_DEFAULT_BRANCH,
  DECISION_MULTI_OUTCOME,
  ASSIGNMENT_SET_VARIABLE,
  SUBJECT_TOKENS,
  TRIGGER_LEAD_CREATED,
  TRIGGER_TASK_CREATED,
  TRIGGER_CONTACT_CREATED,
  type AssignmentEntry,
  type DecisionOutcome,
} from "../registry/definitions";
import { MAX_NODES_PER_WORKFLOW } from "../config/safeguards";
import { getFieldDefinition, type FieldDataType, type FieldOperator, type FieldRegistryEntry } from "../registry/fields";
import type { ConditionGroup, ConditionRule } from "../registry/condition-group";
import type { WorkflowDefinition, WorkflowNode } from "@/types/automation";

/** Which lifecycle moment produced the event being evaluated. Mirrors
 *  automation_events.operation exactly — this is not a separate
 *  vocabulary invented in TypeScript. */
export type EventOperation = "created" | "updated";

/**
 * The facts a workflow is evaluated against.
 *
 * `fields` is what makes conditions dynamic: every allowlisted Lead
 * field (features/automations/registry/fields.ts), keyed by its
 * registry key, so the generic condition can read any of them. It is
 * still not the lead row itself — only fields the registry names ever
 * reach here, and a key absent from the registry is simply absent from
 * this object too.
 *
 * The four named properties alongside it are kept for the two ORIGINAL
 * fixed condition types (lead.source.is, lead.has_owner), which predate
 * the field registry and read facts by name rather than by a field key.
 * Both mechanisms coexist rather than one replacing the other — see
 * definitions.ts for why the old ones were not removed.
 */
export type LeadFacts = {
  leadId: string;
  source: string | null;
  hasOwner: boolean;
  company: string;
  contactName: string;
  fields: Record<string, unknown>;
};

/** Which object a trigger, a Get Records call, or a record variable is
 *  about — the same three-object vocabulary this app's trigger_type
 *  strings already use ("lead.created" / "task.created" /
 *  "contact.created"), named once here so engine.ts, executors.ts and
 *  this file all mean the same thing by it. */
export type TriggerObject = "lead" | "task" | "contact";

/**
 * A Get Records result, held in a variable for a later Loop (or,
 * eventually, another consumer) to read.
 *
 * EXECUTION-SCOPED ONLY — narrower than the existing scalar `variables`
 * map's already-documented per-branch scoping, and deliberately so: a
 * record/collection can only be populated by a REAL DATABASE QUERY
 * (get_automation_records), which is IO planWorkflow is not allowed to
 * perform (see this function's own docstring: "Pure. No Supabase, no
 * fetch..."). So unlike a scalar `{{var.name}}` — resolved once, at
 * plan time, before any action's config is even seen by an executor — a
 * record variable can only be resolved DURING execution, lives only for
 * the remainder of ONE automation's run against ONE event, and is never
 * written anywhere, never carried across a retry, and never shared
 * between two different automations reacting to the same event (each
 * gets its own map — see engine.ts's per-automation construction).
 */
export type RecordVariableValue =
  | { kind: "record"; object: TriggerObject; fields: Record<string, unknown> }
  | { kind: "collection"; object: TriggerObject; records: ReadonlyArray<Record<string, unknown>> };

export type PlannedAction = {
  nodeId: string;
  type: string;
  config: Record<string, unknown>;
};

export type WorkflowPlan = {
  /** False when the trigger's own filter excluded this event, OR when
   *  "only when it starts matching" determined this update was not a
   *  fresh transition. Either way the automation is not at fault and
   *  nothing ran — recorded as `skipped`, not a failure. */
  triggered: boolean;
  actions: PlannedAction[];
  /** One readable line per decision, for the run log and for test mode.
   *  Never contains anything a caller supplied beyond the lead's own
   *  field values. */
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
 * `operation` and `previousFacts` are what make Created/Updated/
 * Created-or-Updated and "only when it starts matching" real: the
 * trigger's own eventType is checked against `operation` before anything
 * else runs, and when the trigger is in "entered" mode for an update,
 * the ENTIRE downstream decision (every condition, not just the
 * trigger's own filter) is walked TWICE — once against `previousFacts`,
 * once against `facts` — and only proceeds if the old walk reached no
 * action and the new one reaches at least one. This is deliberately
 * defined in terms of "did anything become reachable", not "did this one
 * condition's answer change", because that is the only definition that
 * keeps meaning the same thing regardless of how many conditions a
 * workflow has.
 *
 * Assumes the definition has already passed validateWorkflow(). It is
 * still defensive about node lookups, because the engine re-validates
 * stored definitions but a plan built from a partially-edited canvas in
 * the builder may be one keystroke behind.
 */
export function planWorkflow(
  definition: WorkflowDefinition,
  facts: LeadFacts,
  operation: EventOperation = "created",
  previousFacts?: LeadFacts,
): WorkflowPlan {
  const trace: string[] = [];
  const trigger = definition.nodes.find((node) => node.kind === "trigger");

  if (!trigger) {
    return { triggered: false, actions: [], trace: ["This workflow has no trigger."] };
  }

  if (!matchesEventType(trigger, operation, trace)) {
    return { triggered: false, actions: [], trace };
  }

  if (!evaluateTriggerFilters(trigger, facts, trace)) {
    return { triggered: false, actions: [], trace };
  }

  const updateMode = trigger.config.updateMode === "entered" ? "entered" : "every_time";

  if (operation === "updated" && updateMode === "entered" && previousFacts) {
    // A silent dry-run trace (never shown) so this comparison cannot
    // leak two competing narratives into the one trace the admin reads.
    const before = walkFromTrigger(definition, trigger, previousFacts, []);
    if (before.actions.length > 0) {
      trace.push(
        "The lead already matched before this update — nothing changed that would re-trigger this automation.",
      );
      return { triggered: false, actions: [], trace };
    }
  }

  const { actions } = walkFromTrigger(definition, trigger, facts, trace);
  if (actions.length === 0) {
    trace.push("No action was reached on this path.");
  }

  return { triggered: true, actions, trace };
}

/**
 * The graph walk, extracted so it can run twice (old facts, new facts)
 * for "entered" mode without duplicating the traversal logic.
 *
 * BREADTH-FIRST, BUT THE QUEUE CARRIES EACH BRANCH'S OWN VARIABLES,
 * not one shared map. Two Assignment nodes on two different branches of
 * the same decision must not see each other's values — a workflow
 * variable is scoped to the PATH that set it, exactly like a condition's
 * yes and no paths already never observed each other's side effects
 * (there were none to observe before Assignment existed). Cloning the
 * variables map at every branch point is what keeps that true for an
 * arbitrarily-shaped graph without tracking parent/child relationships
 * explicitly.
 */
function walkFromTrigger(
  definition: WorkflowDefinition,
  trigger: WorkflowNode,
  facts: LeadFacts,
  trace: string[],
): { actions: PlannedAction[] } {
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const actions: PlannedAction[] = [];

  type QueueEntry = { nodeId: string; variables: Record<string, string> };
  const queue: QueueEntry[] = outgoingTargets(definition, trigger.id, null).map((nodeId) => ({ nodeId, variables: {} }));
  // A node can legitimately be reached more than once down different
  // branches (e.g. two decision outcomes that both lead to the same
  // follow-up action) — visited is keyed by node, not by (node, branch),
  // which means it runs at most once per walk. That already matched the
  // pre-decision behaviour for any diamond-shaped graph a condition
  // could produce; decisions just make diamonds far more common.
  const visited = new Set<string>([trigger.id]);
  let steps = 0;

  while (queue.length > 0 && steps < MAX_NODES_PER_WORKFLOW) {
    steps += 1;
    const { nodeId, variables } = queue.shift() as QueueEntry;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);

    const node = nodeById.get(nodeId);
    if (!node) continue;

    if (node.kind === "condition") {
      const result = evaluateCondition(node, facts, trace);
      for (const next of outgoingTargets(definition, node.id, result ? "true" : "false")) {
        queue.push({ nodeId: next, variables });
      }
      continue;
    }

    if (node.kind === "decision") {
      const branch = evaluateDecision(node, facts, trace);
      for (const next of outgoingTargets(definition, node.id, branch)) {
        queue.push({ nodeId: next, variables });
      }
      continue;
    }

    if (node.kind === "assignment") {
      const nextVariables = applyAssignments(node, facts, variables, trace);
      for (const next of outgoingTargets(definition, node.id, null)) {
        queue.push({ nodeId: next, variables: nextVariables });
      }
      continue;
    }

    if (node.kind === "action" && node.type === ACTION_LOOP) {
      // A Loop's own body is whichever single node it connects to — not
      // a config field, the graph edge itself (validate-workflow enforces
      // exactly one outgoing edge, to a real action). That body node is
      // captured HERE as data (bodyAction) inside the Loop's OWN
      // PlannedAction, rather than being walked and emitted as its own
      // independent action — the Loop executor (registry/executors.ts)
      // is what actually runs it, once per item, at execution time
      // (planWorkflow cannot: the collection to iterate only exists
      // after a real database query, which this pure function never
      // performs). The walk then CONTINUES from the body node's own
      // downstream edges, marking the body node itself visited but not
      // its own successors — which is what makes "whatever comes after
      // the loop" run exactly once, after all iterations, for free,
      // with no separate branch-reconvergence logic needed.
      const bodyTargets = outgoingTargets(definition, node.id, null);
      const bodyNode = bodyTargets.length === 1 ? nodeById.get(bodyTargets[0]) : undefined;

      if (bodyNode && bodyNode.kind === "action" && !visited.has(bodyNode.id)) {
        visited.add(bodyNode.id);
        actions.push({
          nodeId: node.id,
          type: node.type,
          config: {
            ...substituteVariables(node.config, variables),
            bodyAction: { type: bodyNode.type, config: substituteVariables(bodyNode.config, variables) },
          },
        });
        for (const next of outgoingTargets(definition, bodyNode.id, null)) {
          queue.push({ nodeId: next, variables });
        }
      } else {
        // No valid body connected — validate-workflow should have
        // refused this at save time, but planWorkflow must not silently
        // run a Loop with nothing to do, or run whatever happens to be
        // downstream unconditionally as if it were the loop's body.
        trace.push("Loop: no step is connected to run — skipped.");
      }
      continue;
    }

    if (node.kind === "action") {
      actions.push({ nodeId: node.id, type: node.type, config: substituteVariables(node.config, variables) });
      for (const next of outgoingTargets(definition, node.id, null)) {
        queue.push({ nodeId: next, variables });
      }
    }
  }

  return { actions };
}

function outgoingTargets(
  definition: WorkflowDefinition,
  nodeId: string,
  branch: string | null,
): string[] {
  return definition.edges
    .filter((edge) => edge.source === nodeId && (branch === null || edge.branch === branch))
    .map((edge) => edge.target);
}

/** Evaluates a decision's outcomes IN ORDER and returns the first
 *  match's branch id, or DECISION_DEFAULT_BRANCH when none match — the
 *  same "first match wins, otherwise the default" rule the canvas and
 *  the Learn panel both describe. Reuses evaluateFieldGroup, the exact
 *  AND/OR engine CONDITION_FIELD_GROUP already runs, once per outcome. */
function evaluateDecision(node: WorkflowNode, facts: LeadFacts, trace: string[]): string {
  if (node.type !== DECISION_MULTI_OUTCOME) {
    trace.push(`Unknown decision "${node.type}" → took the default path.`);
    return DECISION_DEFAULT_BRANCH;
  }

  const outcomes = Array.isArray(node.config.outcomes) ? (node.config.outcomes as DecisionOutcome[]) : [];
  for (const outcome of outcomes) {
    if (evaluateFieldGroup(outcome.root, facts.fields)) {
      trace.push(`Decision: matched "${outcome.name}".`);
      return outcome.id;
    }
  }
  trace.push("Decision: no outcome matched → Otherwise.");
  return DECISION_DEFAULT_BRANCH;
}

/**
 * Applies every assignment on one Assignment node, in order, to a COPY
 * of the incoming variables map — never mutated in place, since the
 * same map instance may still be queued for a sibling branch this node
 * is not actually on (see walkFromTrigger's own note on cloning at
 * every branch point).
 */
function applyAssignments(
  node: WorkflowNode,
  facts: LeadFacts,
  variables: Record<string, string>,
  trace: string[],
): Record<string, string> {
  if (node.type !== ASSIGNMENT_SET_VARIABLE) {
    trace.push(`Unknown assignment "${node.type}" → no variables changed.`);
    return variables;
  }

  const next = { ...variables };
  const entries = Array.isArray(node.config.assignments) ? (node.config.assignments as AssignmentEntry[]) : [];

  for (const assignment of entries) {
    // The static branch is free-typed text, so it gets the SAME
    // placeholder substitution task subject/description and Update
    // Lead's "Next step" already have — the reference picker (see
    // field-reference-picker.tsx) offers it here on that assumption,
    // and a variable set from typed text with no way to pull in
    // {{lead.company}} would be a strictly weaker tool than the fields
    // right next to it on the same canvas.
    const sourceValue =
      assignment.valueSource === "field"
        ? stringifyFieldValue(facts.fields[assignment.fieldKey])
        : renderTemplate(assignment.staticValue, facts);
    const current = next[assignment.variable] ?? "";

    switch (assignment.operator) {
      case "set":
        next[assignment.variable] = sourceValue;
        break;
      case "append":
        next[assignment.variable] = `${current}${sourceValue}`;
        break;
      case "add": {
        const sum = (numOf(current) ?? 0) + (numOf(sourceValue) ?? 0);
        next[assignment.variable] = String(sum);
        break;
      }
      case "subtract": {
        const diff = (numOf(current) ?? 0) - (numOf(sourceValue) ?? 0);
        next[assignment.variable] = String(diff);
        break;
      }
    }
  }

  trace.push(`Assignment: set ${entries.map((entry) => entry.variable).join(", ") || "nothing"}.`);
  return next;
}

function stringifyFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * Substitutes {{var.name}} tokens throughout an action's config — the
 * ONLY place a workflow variable ever leaves the walk. By the time an
 * action reaches its executor (registry/executors.ts), every token is
 * already a literal string or "": there is no variable concept past
 * this point, and no expression is ever evaluated — this is a plain
 * string replace over a closed {{var.*}} pattern, walking the config's
 * own JSON shape (only ever strings/numbers/booleans/arrays/objects,
 * since it already passed that action's Zod schema once).
 */
function substituteVariables(config: Record<string, unknown>, variables: Record<string, string>): Record<string, unknown> {
  // A cheap no-clone skip for the overwhelmingly common case (no
  // Assignment node anywhere upstream of this action) — NOT keyed on
  // whether `variables` happens to be empty, because an unresolved
  // {{var.*}} token must still substitute to "" even on a path an
  // Assignment never touched (e.g. a decision's Otherwise path when the
  // Assignment only runs on a named outcome). Keyed on the config's own
  // text instead, which is correct regardless of which branch produced
  // an empty variables map and why.
  if (!JSON.stringify(config).includes("{{var.")) return config;
  return JSON.parse(JSON.stringify(config), (_key, value) =>
    typeof value === "string" ? value.replace(/\{\{var\.([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, name) => variables[name] ?? "") : value,
  ) as Record<string, unknown>;
}

/** Every trigger key sharing the identical eventType/updateMode shape —
 *  "object.created", watched as Created/Updated/Created-or-Updated. Task
 *  and Contact triggers reuse leadCreatedConfigSchema's own shape MINUS
 *  entryCondition (see definitions.ts's own note on why that field is
 *  not offered for them yet), so this same function still applies. */
const TRIGGERS_WITH_EVENT_TYPE: ReadonlySet<string> = new Set([
  TRIGGER_LEAD_CREATED,
  TRIGGER_TASK_CREATED,
  TRIGGER_CONTACT_CREATED,
]);

function matchesEventType(trigger: WorkflowNode, operation: EventOperation, trace: string[]): boolean {
  if (!TRIGGERS_WITH_EVENT_TYPE.has(trigger.type)) {
    trace.push(`Unknown trigger "${trigger.type}" — nothing ran.`);
    return false;
  }

  const eventType = trigger.config.eventType === "updated" || trigger.config.eventType === "created_or_updated"
    ? trigger.config.eventType
    : "created";

  const matches =
    eventType === "created_or_updated" ||
    (eventType === "created" && operation === "created") ||
    (eventType === "updated" && operation === "updated");

  if (!matches) {
    trace.push(
      `Trigger: this automation runs on ${eventType.replace("_", " ")}, but this event was a ${operation} — skipped.`,
    );
  }
  return matches;
}

/**
 * The trigger's own hard gate, checked once against the CURRENT lead —
 * "Only run when…". A source filter used to live here too as a
 * dedicated, separately-maintained field; it was removed because it is
 * now just a Source condition inside this same entry condition (see
 * `evaluateFieldGroup`, the one AND/OR engine every condition in this
 * app shares) — one mechanism instead of two that could drift apart.
 *
 * Orthogonal to `updateMode`'s "entered" semantics: that toggle is about
 * whether the DOWNSTREAM decision graph just transitioned into matching,
 * evaluated separately in planWorkflow's own old-vs-new dual walk. This
 * only ever asks "is that true right now".
 */
function evaluateTriggerFilters(node: WorkflowNode, facts: LeadFacts, trace: string[]): boolean {
  return evaluateEntryCondition(node, facts, trace);
}

function evaluateEntryCondition(node: WorkflowNode, facts: LeadFacts, trace: string[]): boolean {
  const entryCondition = node.config.entryCondition;
  if (!entryCondition || typeof entryCondition !== "object") return true;

  const result = evaluateFieldGroup(entryCondition as ConditionGroup, facts.fields);
  trace.push(result ? "Trigger: entry condition matched." : "Trigger: entry condition did not match — skipped.");
  return result;
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

  if (node.type === CONDITION_FIELD_GROUP) {
    const root = node.config.root as ConditionGroup | undefined;
    if (!root) {
      trace.push("Condition: no conditions configured → no.");
      return false;
    }
    const result = evaluateFieldGroup(root, facts.fields);
    trace.push(`Condition: field checks → ${result ? "yes" : "no"}.`);
    return result;
  }

  trace.push(`Unknown condition "${node.type}" → treated as no.`);
  return false;
}

/**
 * Recursively evaluates an AND/OR tree over the field registry.
 *
 * FAILS CLOSED on anything it doesn't recognise — an unregistered field
 * key, an operator invalid for that field's type, or a comparison that
 * cannot be made (e.g. comparing text with "greater than") all evaluate
 * to `false` rather than throwing or being silently skipped. A stored
 * definition should never reach this state (validateWorkflow refuses it
 * first), so this is the same belt-and-braces stance every other
 * "unknown X" branch in this file already takes.
 */
/**
 * `getFieldDef` defaults to the Lead-only lookup every existing caller
 * (Decision, lead.match, entry conditions) already relies on — passing
 * nothing here is BYTE-FOR-BYTE the function this always was. The
 * optional parameter exists for exactly one other caller: Get Records
 * (registry/executors.ts), which evaluates the same AND/OR shape
 * against a Task or Contact row, and needs a Task/Contact-aware lookup
 * (object-fields.ts's fieldRegistryForObject) instead. This is NOT the
 * same thing as making the condition BUILDER (Decision/lead.match)
 * object-aware — those still only ever read Lead facts, unchanged; see
 * docs/automations.md for why that is still a stated v1 limitation.
 */
export function evaluateFieldGroup(
  group: ConditionGroup,
  fields: Record<string, unknown>,
  getFieldDef: (key: string) => FieldRegistryEntry | undefined = getFieldDefinition,
): boolean {
  const results = group.rules.map((rule) =>
    rule.kind === "group" ? evaluateFieldGroup(rule, fields, getFieldDef) : evaluateFieldRule(rule, fields, getFieldDef),
  );
  return group.match === "all" ? results.every(Boolean) : results.some(Boolean);
}

function evaluateFieldRule(
  rule: ConditionRule,
  fields: Record<string, unknown>,
  getFieldDef: (key: string) => FieldRegistryEntry | undefined = getFieldDefinition,
): boolean {
  const fieldDef = getFieldDef(rule.field);
  if (!fieldDef) return false;

  const actual = fields[rule.field] ?? null;
  const operator = rule.operator;

  switch (operator) {
    case "is_empty":
      return isBlank(actual);
    case "is_not_empty":
      return !isBlank(actual);
    case "is_true":
      return !isBlank(actual) && actual !== false;
    case "is_false":
      return isBlank(actual) || actual === false;
    case "equals":
      return evaluateEquals(fieldDef.type, actual, rule.value);
    case "not_equals":
      return !evaluateEquals(fieldDef.type, actual, rule.value);
    case "contains":
      return typeof actual === "string" && typeof rule.value === "string" && actual.toLowerCase().includes(rule.value.toLowerCase());
    case "starts_with":
      return typeof actual === "string" && typeof rule.value === "string" && actual.toLowerCase().startsWith(rule.value.toLowerCase());
    case "greater_than":
      return compareNumbers(actual, rule.value, (a, b) => a > b);
    case "less_than":
      return compareNumbers(actual, rule.value, (a, b) => a < b);
    case "greater_than_or_equal":
      return compareNumbers(actual, rule.value, (a, b) => a >= b);
    case "less_than_or_equal":
      return compareNumbers(actual, rule.value, (a, b) => a <= b);
    case "before":
      return compareDates(actual, rule.value, (a, b) => a < b);
    case "after":
      return compareDates(actual, rule.value, (a, b) => a > b);
    case "between": {
      const a = dateOf(actual);
      const from = dateOf(rule.value);
      const to = dateOf(rule.valueTo);
      return a !== null && from !== null && to !== null && a >= Math.min(from, to) && a <= Math.max(from, to);
    }
    case "is_any_of":
      return typeof actual === "string" && Array.isArray(rule.value) && rule.value.includes(actual);
    default:
      return false;
  }
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function numOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function dateOf(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function compareNumbers(actual: unknown, expected: unknown, compare: (a: number, b: number) => boolean): boolean {
  const a = numOf(actual);
  const b = numOf(expected);
  return a !== null && b !== null && compare(a, b);
}

function compareDates(actual: unknown, expected: unknown, compare: (a: number, b: number) => boolean): boolean {
  const a = dateOf(actual);
  const b = dateOf(expected);
  return a !== null && b !== null && compare(a, b);
}

/** "equals" is deliberately type-aware: a date field compares by
 *  calendar day (an exact-millisecond match on a timestamptz would
 *  almost never fire from a hand-typed date), text compares
 *  case-insensitively trimmed, everything else compares by value. */
function evaluateEquals(type: FieldDataType, actual: unknown, expected: unknown): boolean {
  if (type === "number") return compareNumbers(actual, expected, (a, b) => a === b);
  if (type === "date") {
    const a = dateOf(actual);
    const b = dateOf(expected);
    if (a === null || b === null) return false;
    const da = new Date(a);
    const db = new Date(b);
    return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth() && da.getUTCDate() === db.getUTCDate();
  }
  if (type === "boolean") return Boolean(actual) === Boolean(expected);
  return typeof actual === "string" && typeof expected === "string" && actual.trim().toLowerCase() === expected.trim().toLowerCase();
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Substitutes the registry's fixed placeholder tokens into a subject,
 * description, or other free-typed field (see SUBJECT_TOKENS's own note
 * on every place this now reaches).
 *
 * A LITERAL REPLACE OVER A CLOSED LIST — not a template engine. It
 * iterates SUBJECT_TOKENS (itself derived from LEAD_FIELD_REGISTRY) and
 * replaces each exact string with the matching key's value read from
 * `facts.fields` — the SAME allowlisted-field map a condition already
 * reads, so a token can never reach anything a condition could not
 * already see. There is no expression to evaluate, no property path
 * resolved from the text, and no way for `{{anything.else}}` to reach a
 * field: an unrecognised placeholder is simply left in the string,
 * visible to whoever reads the task, which is the honest outcome.
 */
export function renderTemplate(text: string, facts: LeadFacts): string {
  let out = text;
  for (const { token } of SUBJECT_TOKENS) {
    if (!out.includes(token)) continue;
    // "{{lead.company}}" -> "company"
    const key = token.slice("{{lead.".length, -"}}".length);
    // company/contact_name/source are the three ORIGINAL tokens, and
    // `facts` already resolves each of them its own deliberate way (see
    // loadLeadFacts in engine.ts) — company/contactName from a LIVE
    // re-read at processing time, not the trigger-time snapshot, so a
    // task names the company as it is now; source from the snapshot
    // falling back to the live row. `facts.fields[key]` is the flat,
    // snapshot-only map every OTHER field reads from, and using it here
    // instead would silently swap in stale data for these three.
    const value =
      key === "company"
        ? facts.company
        : key === "contact_name"
          ? facts.contactName
          : key === "source"
            ? (facts.source ?? "")
            : stringifyFieldValue(facts.fields[key]);
    out = out.split(token).join(value);
  }
  return out.trim();
}

/** Registry key helpers used by both the engine and test mode, so
 *  neither hardcodes the string. */
export const PLANNABLE_ACTION_KEYS = [
  ACTION_TASK_CREATE,
  ACTION_LEAD_UPDATE,
  ACTION_LEAD_DEACTIVATE,
  ACTION_CONTACT_CREATE,
  ACTION_TASK_UPDATE,
  ACTION_CONTACT_UPDATE,
  ACTION_TASK_DEACTIVATE,
  ACTION_CONTACT_DEACTIVATE,
  ACTION_GET_RECORDS,
  ACTION_LOOP,
] as const;

export type { FieldOperator };
