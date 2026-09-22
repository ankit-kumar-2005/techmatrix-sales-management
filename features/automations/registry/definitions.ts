import { z } from "zod";
import {
  MAX_ASSIGNMENTS_PER_NODE,
  MAX_CONTACT_NAME_LENGTH,
  MAX_CONTACT_TEXT_FIELD_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_DUE_DATE_OFFSET_DAYS,
  MAX_DEAL_VALUE_TEXT_LENGTH,
  MAX_DECISION_OUTCOMES,
  MAX_LOOP_ITERATIONS,
  MAX_NEXT_STEP_LENGTH,
  MAX_NODE_ID_LENGTH,
  MAX_NODE_REFERENCE_LENGTH,
  MAX_OUTCOME_NAME_LENGTH,
  MAX_RECORDS_PER_QUERY,
  MAX_ROUND_ROBIN_POOL,
  MAX_SUBJECT_LENGTH,
  MAX_TRIGGER_SOURCES,
  MAX_VARIABLE_NAME_LENGTH,
  MAX_VARIABLE_VALUE_LENGTH,
} from "../config/safeguards";
import { OBJECT_OPTIONS } from "./object-fields";
import {
  CONDITION_FIELD_GROUP,
  conditionFieldGroupConfigSchema,
  conditionGroupSchema,
  DEFAULT_CONDITION_GROUP_CONFIG,
  validateConditionGroupShape,
  type ConditionGroup,
} from "./condition-group";
import { CONTACT_FIELD_REGISTRY, getWritableContactFields } from "./contact-fields";
import { LEAD_FIELD_REGISTRY, getFieldDefinition } from "./fields";
import { TASK_FIELD_REGISTRY, getWritableTaskFields } from "./task-fields";
import { isRealIsoDate } from "@/utils/iso-date";
import type { FieldRegistryEntry } from "./fields";
import type { AutomationNodeKind } from "@/types/automation";

/**
 * THE CAPABILITY REGISTRY — the fixed menu of everything an automation
 * can be made of, and the only place any of it is described.
 *
 * Eight consumers read this one file, and none of them keeps its own
 * copy of any of it:
 *
 *   1. the node palette in the builder          (label, description, kind)
 *   2. the node configuration panel             (fields)
 *   3. workflow validation                      (configSchema, kind rules)
 *   4. the AI system prompt                     (label, description,
 *                                                example, limitations,
 *                                                fields)
 *   5. AI output validation                     (configSchema — the same
 *                                                object, not a parallel
 *                                                one)
 *   6. test mode                                (fields, configSchema)
 *   7. the execution engine                     (key -> executor, via
 *                                                registry/executors.ts)
 *   8. the learning module                      (description, example,
 *                                                limitations)
 *
 * WHAT MAKES THE AI PATH SAFE IS THIS FILE. The model never writes code,
 * never writes SQL, and never names an operation the application does
 * not already expose: it selects a `key` from this registry and fills in
 * a `config` that is parsed by that entry's own `configSchema`. An
 * unknown key fails before it is ever stored, because there is nothing
 * to look it up in. That is the whole mechanism — there is no separate
 * sanitizer to keep in sync with it, and nothing here is `eval`'d,
 * templated into a query, or otherwise interpreted as anything but data.
 *
 * NO LIMIT IS TYPED HERE. Every bound below is imported by name from
 * config/safeguards.ts.
 *
 * CLIENT-SAFE ON PURPOSE. This module is imported by Client Components
 * (the palette, the config panel), so it holds data and Zod schemas
 * only. Action executors need server-only imports and live in
 * registry/executors.ts, keyed by the same strings.
 */

/** How the config panel should render one field. A closed set — a new
 *  field kind is a deliberate change to the renderer, not something an
 *  entry can invent. */
export type FieldKind =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "team-single"
  | "team-multi"
  | "source-multi"
  /** The recursive AND/OR rule builder — bespoke UI (ConditionGroupEditor),
   *  not something the generic FormField/SelectField renderers can
   *  express, so it gets its own kind rather than being forced into one
   *  of the above. */
  | "condition-group"
  /** The Decision node's named-outcome list — bespoke UI
   *  (DecisionOutcomesEditor): add/rename/reorder/remove an outcome, each
   *  with its own embedded condition-group. */
  | "decision-outcomes"
  /** The Assignment node's variable list — bespoke UI (AssignmentEditor). */
  | "assignment-list"
  /** The trigger's own "Only run when…" filter — bespoke UI
   *  (EntryConditionEditor): an on/off toggle wrapping one FLAT
   *  condition-group (no nested groups — see leadCreatedConfigSchema). */
  | "entry-condition"
  /** Picks an earlier node in THIS workflow by id — bespoke UI
   *  (NodeReferenceSelect), needing the full node list the generic
   *  renderer never otherwise sees. Used by every Task/Contact
   *  Update/Deactivate action to name which Create node's row it acts
   *  on (see the migration's own design note 7 on why targeting works
   *  this way, and why a raw row id has nothing to be, since a
   *  Lead-triggered workflow has no Task/Contact of its own). */
  | "node-reference";

export type FieldDescriptor = {
  name: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  helperText?: string;
  placeholder?: string;
  options?: ReadonlyArray<{ value: string; label: string }>;
  min?: number;
  max?: number;
  maxLength?: number;
  /** Render this field only when another field in the same node holds a
   *  particular value (or one of several) — how the Fixed/round-robin
   *  branch, and the update-only trigger options, are expressed without
   *  a second node type. */
  visibleWhen?: { field: string; equals: string | string[] };
  /** "node-reference" only — the registry key the referenced node's own
   *  `type` must equal (e.g. ACTION_TASK_CREATE), so the picker only
   *  ever offers Create nodes of the right object, never an arbitrary
   *  node. */
  targetType?: string;
  /** "text"/"textarea" only — this field is rendered through renderTemplate before
   *  it is used (see plan-workflow.ts), so {{lead.*}} tokens in it are
   *  live, not literal text. The config panel uses this to decide
   *  whether to offer the field-reference picker (a button that inserts
   *  a token without the admin typing its exact syntax) next to the
   *  field — never on a field this is missing from, since a token typed
   *  into one would just sit there unresolved (Contact's fields, for
   *  one concrete example — see executors.ts's own note on why those are
   *  deliberately literal pass-through text, not templated). */
  templated?: boolean;
  /** "condition-group" only — the name of a sibling field on this same
   *  node holding "lead"/"task"/"contact" (Get Records' own "object"
   *  field). When set, the config panel passes THAT object's field
   *  registry (object-fields.ts's fieldRegistryForObject) down to the
   *  condition builder instead of the default Lead-only one — so Get
   *  Records' filter always offers the fields of whichever type the
   *  admin actually picked. Omitted everywhere else (Decision,
   *  lead.match, a trigger's entry condition), which is what keeps all
   *  three exactly Lead-only, unchanged. */
  objectFieldName?: string;
};

export type RegistryEntry = {
  key: string;
  kind: AutomationNodeKind;
  label: string;
  /** One plain-English line. Shown in the palette AND given to the model
   *  verbatim — the same sentence, so what an admin reads and what the
   *  model is told can never drift apart. */
  description: string;
  /** A concrete example from this CRM, for the help panel and the
   *  prompt. */
  example: string;
  /** What this capability deliberately cannot do. Given to the model so
   *  it answers UNSUPPORTED instead of inventing something adjacent, and
   *  shown in the learning panel so an admin is not left guessing. */
  limitations: ReadonlyArray<string>;
  fields: ReadonlyArray<FieldDescriptor>;
  configSchema: z.ZodType;
  defaultConfig: Record<string, unknown>;
};

/**
 * Tokens allowed in a generated task subject, description, Update Lead's
 * "Next step", or a "Set a variable" static value.
 *
 * A FIXED LOOKUP TABLE, NOT AN EXPRESSION LANGUAGE — DERIVED FROM
 * LEAD_FIELD_REGISTRY, not a second hand-maintained list. Substitution
 * (renderTemplate, in plan-workflow.ts) is a literal replace of these
 * exact strings with values read off `facts.fields`, itself already
 * scoped to this same registry; anything else in the text is left
 * alone. There is no path here that evaluates, indexes by a
 * caller-supplied key, or reaches any field not named below — which is
 * why a workflow definition cannot use this to read something it was
 * never granted.
 *
 * `reference`-typed fields (today, only `owner_id`) are excluded: their
 * runtime value is an opaque uuid with no name-resolution plumbed in
 * here, so a raw id in a task subject would be actively wrong, not
 * merely unpolished — the same reasoning LEAD_FIELD_REGISTRY's own
 * `owner_id` entry already gives for why it supports only is-set/is-not,
 * applied here to a second, independent consumer of that same field.
 */
export const SUBJECT_TOKENS: ReadonlyArray<{ token: string; description: string }> = LEAD_FIELD_REGISTRY.filter(
  (field) => field.type !== "reference",
).map((field) => ({ token: `{{lead.${field.key}}}`, description: field.label }));

const TASK_TYPE_OPTIONS = [
  { value: "Call", label: "Call" },
  { value: "Meeting", label: "Meeting" },
  { value: "Email", label: "Email" },
  { value: "Other", label: "Other" },
] as const;

const TASK_PRIORITY_OPTIONS = [
  { value: "Low", label: "Low" },
  { value: "Medium", label: "Medium" },
  { value: "High", label: "High" },
] as const;

const ASSIGNMENT_MODE_OPTIONS = [
  { value: "Fixed", label: "Fixed — always the same person" },
  { value: "RoundRobin", label: "Round-robin — rotate through a list" },
] as const;

// ---------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------

export const TRIGGER_LEAD_CREATED = "lead.created";

const EVENT_TYPE_OPTIONS = [
  { value: "created", label: "A lead is created" },
  { value: "updated", label: "A lead is updated" },
  { value: "created_or_updated", label: "A lead is created or updated" },
] as const;

const UPDATE_MODE_OPTIONS = [
  { value: "every_time", label: "Every time it matches" },
  { value: "entered", label: "Only when it starts matching" },
] as const;

const leadCreatedConfigSchema = z
  .object({
    /** Defaults to "created" so every automation saved before this field
     *  existed keeps meaning exactly what it always meant — a stored
     *  definition with no eventType at all is not a validation failure,
     *  it is last week's automation, unchanged. */
    eventType: z.enum(["created", "updated", "created_or_updated"]).default("created"),
    /** Only consulted for an `updated` (or the update half of a
     *  created_or_updated) event — see plan-workflow.ts for the exact
     *  "entered" semantics: the downstream decision is evaluated against
     *  the lead's state BEFORE and AFTER the edit, and only proceeds if it
     *  went from no match to a match. */
    updateMode: z.enum(["every_time", "entered"]).default("every_time"),
    /** "Only run when…" — a plain filter checked once against the
     *  current lead, orthogonal to `updateMode`'s transition semantics
     *  (see plan-workflow.ts's evaluateEntryCondition). `null` (the
     *  default) means off. Reuses the SAME ConditionGroup shape
     *  `lead.match` uses — including its own Source field, which is what
     *  replaced this trigger's OWN separate, dedicated `sources` filter
     *  (removed; see the field registry's `source` enum for why a
     *  hand-entered lead is matched with "is empty", not a fake value).
     *  One AND/OR mechanism, not two that could drift apart. Deliberately
     *  kept FLAT (checked below) rather than allowing nested groups — a
     *  Condition node downstream still has the nested version for
     *  anything more elaborate. */
    entryCondition: conditionGroupSchema.nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (!value.entryCondition) return;
    validateConditionGroupShape(value.entryCondition, 1, ["entryCondition"], ctx);
    if (value.entryCondition.rules.some((rule) => rule.kind === "group")) {
      ctx.addIssue({
        code: "custom",
        path: ["entryCondition"],
        message: "Keep this to a single list of conditions — nested groups aren't available for entry conditions yet.",
      });
    }
  });

export const TRIGGER_TASK_CREATED = "task.created";
export const TRIGGER_CONTACT_CREATED = "contact.created";

/** Task/Contact triggers share eventType/updateMode with Lead's own
 *  trigger (see matchesEventType in plan-workflow.ts, which now
 *  recognises all three) but deliberately have NO entryCondition field.
 *  A condition builder needs a field registry wired into
 *  evaluateFieldRule/getFieldDefinition for the object it is filtering,
 *  and Task/Contact conditions are not built yet — see this entry's own
 *  `limitations` and docs/automations.md. Offering the field anyway
 *  would either silently do nothing or need its own, different
 *  ConditionGroup semantics — both are exactly the kind of half-built
 *  behaviour this app's process forbids, so the field is simply absent
 *  rather than present-but-inert. */
const objectTriggerConfigSchema = z.object({
  eventType: z.enum(["created", "updated", "created_or_updated"]).default("created"),
  updateMode: z.enum(["every_time", "entered"]).default("every_time"),
});

const triggers: RegistryEntry[] = [
  {
    key: TRIGGER_LEAD_CREATED,
    kind: "trigger",
    label: "Lead created or updated",
    description:
      "Runs when a lead is created, updated, or either — whether it was captured from a connected source, entered by hand, or edited later.",
    example: "Run whenever a new IndiaMART enquiry arrives, or whenever any lead's deal value changes.",
    limitations: [
      "\"Only when it starts matching\" compares the lead's state immediately before and after this specific edit — it has no memory of edits from before that.",
      "\"Only run when…\" is a single flat list of AND or OR conditions — no nested groups. Add a Condition or Decision step after the trigger for anything more elaborate.",
      "To match a lead entered by hand with no source picked, add a Source condition using \"is empty\" — there is no separate source picker on this step any more.",
    ],
    fields: [
      {
        name: "eventType",
        label: "Run when",
        kind: "select",
        required: true,
        options: EVENT_TYPE_OPTIONS,
      },
      {
        name: "updateMode",
        label: "On an update, run",
        kind: "select",
        required: true,
        options: UPDATE_MODE_OPTIONS,
        visibleWhen: { field: "eventType", equals: ["updated", "created_or_updated"] },
        helperText: "Only applies to the update half of what this trigger watches.",
      },
      {
        name: "entryCondition",
        label: "Only run when…",
        kind: "entry-condition",
        required: false,
        helperText:
          "A quick filter on the lead itself, checked before anything else on the canvas — including which source it came from.",
      },
    ],
    configSchema: leadCreatedConfigSchema,
    defaultConfig: { eventType: "created", updateMode: "every_time", entryCondition: null },
  },
  {
    key: TRIGGER_TASK_CREATED,
    kind: "trigger",
    label: "Task created or updated",
    description: "Runs when a task is created, updated, or either — any task in your organisation, not just automation-created ones.",
    example: "Run whenever any task is marked Completed, to update the lead it belongs to.",
    limitations: [
      "Cannot yet filter on the task's own fields — there is no condition builder for Task fields in this version. Every task change matching \"Run when\" reaches every action on this canvas unconditionally.",
      "An Update Task or Deactivate Task action further down this same canvas can only target a Create Task step earlier in the SAME run — not the task that triggered this workflow. Acting on the triggering task itself is not available yet.",
      "\"Only when it starts matching\" is not offered here — with no condition to have started matching, every update this trigger watches runs every time.",
    ],
    fields: [
      { name: "eventType", label: "Run when", kind: "select", required: true, options: EVENT_TYPE_OPTIONS.map((o) => ({ ...o, label: o.label.replace("lead", "task") })) },
    ],
    configSchema: objectTriggerConfigSchema,
    defaultConfig: { eventType: "created", updateMode: "every_time" },
  },
  {
    key: TRIGGER_CONTACT_CREATED,
    kind: "trigger",
    label: "Contact created or updated",
    description: "Runs when a contact is created, updated, or either — any contact in your organisation, not just automation-created ones.",
    example: "Run whenever a new contact is added, to create a follow-up task for them.",
    limitations: [
      "Cannot yet filter on the contact's own fields — there is no condition builder for Contact fields in this version. Every contact change matching \"Run when\" reaches every action on this canvas unconditionally.",
      "An Update Contact or Deactivate Contact action further down this same canvas can only target a Create Contact step earlier in the SAME run — not the contact that triggered this workflow. Acting on the triggering contact itself is not available yet.",
      "\"Only when it starts matching\" is not offered here — with no condition to have started matching, every update this trigger watches runs every time.",
    ],
    fields: [
      { name: "eventType", label: "Run when", kind: "select", required: true, options: EVENT_TYPE_OPTIONS.map((o) => ({ ...o, label: o.label.replace("lead", "contact") })) },
    ],
    configSchema: objectTriggerConfigSchema,
    defaultConfig: { eventType: "created", updateMode: "every_time" },
  },
];

// ---------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------

export const CONDITION_LEAD_SOURCE_IS = "lead.source.is";
export const CONDITION_LEAD_HAS_OWNER = "lead.has_owner";
export { CONDITION_FIELD_GROUP };

const leadSourceIsConfigSchema = z.object({
  sources: z.array(z.string().trim().min(1)).min(1).max(MAX_TRIGGER_SOURCES),
});

const leadHasOwnerConfigSchema = z.object({
  expected: z.enum(["yes", "no"]),
});

const conditions: RegistryEntry[] = [
  {
    key: CONDITION_LEAD_SOURCE_IS,
    kind: "condition",
    label: "Lead source is",
    description:
      "Splits the workflow in two: leads from the sources you pick follow one path, everything else follows the other.",
    example: "Send IndiaMART leads to a call task and everything else to an email task.",
    limitations: ["Matches the source exactly. There is no partial or pattern matching."],
    fields: [
      {
        name: "sources",
        label: "Sources that take the yes path",
        kind: "source-multi",
        required: true,
        helperText: "Pick at least one. Leads from any other source take the no path.",
      },
    ],
    configSchema: leadSourceIsConfigSchema,
    defaultConfig: { sources: [] },
  },
  {
    key: CONDITION_LEAD_HAS_OWNER,
    kind: "condition",
    label: "Lead already has an owner",
    description:
      "Splits the workflow on whether the lead arrived already assigned to someone, or came in unassigned.",
    example: "Only create a follow-up task for leads that arrived without an owner.",
    limitations: ["Checks only whether an owner is set, not who it is."],
    fields: [
      {
        name: "expected",
        label: "Take the yes path when the lead",
        kind: "select",
        required: true,
        options: [
          { value: "yes", label: "already has an owner" },
          { value: "no", label: "has no owner yet" },
        ],
      },
    ],
    configSchema: leadHasOwnerConfigSchema,
    defaultConfig: { expected: "no" },
  },
  {
    key: CONDITION_FIELD_GROUP,
    kind: "condition",
    label: "Check the lead's fields",
    description:
      "Splits the workflow on any combination of the lead's fields — company, deal value, status and more — combined with AND/OR, nested up to a few levels deep.",
    example: "Deal value is over ₹50,000 AND (source is IndiaMART OR source is Website).",
    limitations: [
      `Reads Lead fields only: ${LEAD_FIELD_REGISTRY.map((field) => field.label).join(", ")}.`,
      "Cannot compare two fields to each other — only a field to a value you type in.",
      "The lead's pipeline stage is not yet available here.",
    ],
    fields: [{ name: "root", label: "Conditions", kind: "condition-group", required: true }],
    configSchema: conditionFieldGroupConfigSchema,
    defaultConfig: DEFAULT_CONDITION_GROUP_CONFIG,
  },
];

// ---------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------
//
// A GENERALISATION OF "condition", NOT A SECOND MECHANISM. A condition
// node always has exactly two outputs (yes/no); a decision node has one
// output per outcome the admin names, evaluated in order, plus a
// permanent "Otherwise" default that needs no configuration and cannot
// be removed. Both walk the identical ConditionGroup shape per branch —
// see registry/condition-group.ts — so there is exactly one AND/OR
// engine in this app, not one for conditions and a second for decisions.

export type DecisionOutcome = { id: string; name: string; root: ConditionGroup };
export type DecisionConfig = { outcomes: DecisionOutcome[] };

/** The branch id every decision node reserves for "none of the named
 *  outcomes matched" — never a real outcome's own id (enforced below),
 *  and always present even though it has no config of its own to fail
 *  validation on. */
export const DECISION_DEFAULT_BRANCH = "default";

export const DECISION_MULTI_OUTCOME = "lead.decision";

const decisionOutcomeShape = z.object({
  id: z.string().trim().min(1).max(MAX_NODE_ID_LENGTH),
  name: z.string().trim().min(1).max(MAX_OUTCOME_NAME_LENGTH),
  root: conditionGroupSchema,
});

const decisionConfigSchema = z
  .object({
    outcomes: z.array(decisionOutcomeShape).min(1).max(MAX_DECISION_OUTCOMES),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.outcomes.forEach((outcome, index) => {
      if (outcome.id === DECISION_DEFAULT_BRANCH) {
        ctx.addIssue({
          code: "custom",
          path: ["outcomes", index, "id"],
          message: `"${DECISION_DEFAULT_BRANCH}" is reserved for the Otherwise path and cannot be used as an outcome id.`,
        });
      }
      if (seen.has(outcome.id)) {
        ctx.addIssue({ code: "custom", path: ["outcomes", index, "id"], message: "Two outcomes share the same id." });
      }
      seen.add(outcome.id);

      const names = new Set(value.outcomes.map((o) => o.name.trim().toLowerCase()));
      if (names.size !== value.outcomes.length) {
        ctx.addIssue({ code: "custom", path: ["outcomes", index, "name"], message: "Two outcomes have the same name." });
      }

      validateConditionGroupShape(outcome.root, 1, ["outcomes", index, "root"], ctx);
    });
  });

function newDecisionOutcome(id: string, name: string): DecisionOutcome {
  return {
    id,
    name,
    root: { kind: "group", match: "all", rules: [{ kind: "rule", field: LEAD_FIELD_REGISTRY[0].key, operator: "equals", value: null, valueTo: null }] },
  };
}

const DEFAULT_DECISION_CONFIG: DecisionConfig = { outcomes: [newDecisionOutcome("outcome-1", "Outcome 1")] };

const decisions: RegistryEntry[] = [
  {
    key: DECISION_MULTI_OUTCOME,
    kind: "decision",
    label: "Decide between outcomes",
    description:
      "Splits the workflow into several named paths, not just yes/no — the first outcome whose conditions match wins, and any lead that matches none of them takes the always-present \"Otherwise\" path.",
    example: 'High quality (score ≥ 80), Medium quality (score ≥ 50), Otherwise — three different follow-ups from one decision.',
    limitations: [
      `Reads Lead fields only: ${LEAD_FIELD_REGISTRY.map((field) => field.label).join(", ")}.`,
      "Checks outcomes in the order shown and stops at the first match — reorder them if two outcomes could both be true for the same lead.",
      `Up to ${MAX_DECISION_OUTCOMES} named outcomes per decision, on top of the default.`,
    ],
    fields: [{ name: "outcomes", label: "Outcomes", kind: "decision-outcomes", required: true }],
    configSchema: decisionConfigSchema,
    defaultConfig: DEFAULT_DECISION_CONFIG,
  },
];

// ---------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------
//
// A TEMPORARY, IN-MEMORY VALUE — never written to the database, never
// persisted between runs. An Assignment computes a value once (from a
// lead field or typed text) and stores it under a name that later steps
// IN THE SAME RUN can read back with the literal token {{var.name}}.
// Resolved once, at plan time, in plan-workflow.ts's walk — by the time
// an action's config reaches its executor every {{var.*}} token is
// already gone, replaced with a literal value or "". This is the exact
// same "fixed lookup table substituted into a string, never evaluated"
// mechanism SUBJECT_TOKENS already uses for {{lead.company}} and
// friends, extended with a second, equally closed vocabulary — there is
// still no expression language and no code path from a variable name to
// anything but a plain string replace.

export type AssignmentOperator = "set" | "add" | "subtract" | "append";
export type AssignmentValueSource = "static" | "field";
export type AssignmentEntry = {
  variable: string;
  operator: AssignmentOperator;
  valueSource: AssignmentValueSource;
  staticValue: string;
  fieldKey: string;
};
export type AssignmentConfig = { assignments: AssignmentEntry[] };

export const ASSIGNMENT_SET_VARIABLE = "workflow.assign";

const ASSIGNMENT_OPERATOR_OPTIONS = [
  { value: "set", label: "Set to" },
  { value: "add", label: "Add (numbers)" },
  { value: "subtract", label: "Subtract (numbers)" },
  { value: "append", label: "Append text" },
] as const;

const assignmentEntryShape = z
  .object({
    variable: z
      .string()
      .trim()
      .min(1)
      .max(MAX_VARIABLE_NAME_LENGTH)
      .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Use letters, numbers and underscores, starting with a letter."),
    operator: z.enum(["set", "add", "subtract", "append"]),
    valueSource: z.enum(["static", "field"]),
    staticValue: z.string().max(MAX_VARIABLE_VALUE_LENGTH).default(""),
    fieldKey: z.string().max(MAX_NODE_ID_LENGTH).default(""),
  })
  .superRefine((value, ctx) => {
    if (value.valueSource === "field" && !getFieldDefinition(value.fieldKey)) {
      ctx.addIssue({ code: "custom", path: ["fieldKey"], message: "Pick a lead field." });
    }
    if (value.valueSource === "static" && value.staticValue.trim() === "") {
      ctx.addIssue({ code: "custom", path: ["staticValue"], message: "Enter a value, or switch to a lead field." });
    }
  });

const assignmentConfigSchema = z.object({
  assignments: z.array(assignmentEntryShape).min(1).max(MAX_ASSIGNMENTS_PER_NODE),
});

const assignments: RegistryEntry[] = [
  {
    key: ASSIGNMENT_SET_VARIABLE,
    kind: "assignment",
    label: "Set a variable",
    description:
      "Computes a temporary value — from a lead field or text you type — that later steps in this run can reuse. Nothing is written to the database here.",
    example: "Build a note combining the lead's company and source, then use it in a task's subject.",
    limitations: [
      "Only lasts for the current run — nothing here is saved, and the next run starts with no memory of it.",
      'Can be reused in a task\'s subject/description or the Update Lead action\'s "Next step" field, written as {{var.name}}.',
      "Cannot read or write a database field directly — that is what Update Lead is for.",
    ],
    fields: [{ name: "assignments", label: "Assignments", kind: "assignment-list", required: true }],
    configSchema: assignmentConfigSchema,
    defaultConfig: {
      assignments: [{ variable: "note", operator: "set", valueSource: "field", staticValue: "", fieldKey: LEAD_FIELD_REGISTRY[0].key }],
    },
  },
];

export { ASSIGNMENT_OPERATOR_OPTIONS };

// ---------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------

export const ACTION_TASK_CREATE = "task.create";

const taskCreateConfigSchema = z
  .object({
    subject: z.string().trim().min(1).max(MAX_SUBJECT_LENGTH),
    description: z.string().trim().max(MAX_DESCRIPTION_LENGTH).nullable().default(null),
    type: z.enum(["Call", "Meeting", "Email", "Other"]),
    priority: z.enum(["Low", "Medium", "High"]),
    dueInDays: z.number().int().min(0).max(MAX_DUE_DATE_OFFSET_DAYS),
    assignmentMode: z.enum(["Fixed", "RoundRobin"]),
    /** A customer_users.id. Never trusted from here — the SQL function
     *  re-checks that it belongs to this tenant and is still Active
     *  before it writes anything. */
    assigneeId: z.string().uuid().nullable().default(null),
    rotation: z.array(z.string().uuid()).max(MAX_ROUND_ROBIN_POOL).default([]),
  })
  .superRefine((value, ctx) => {
    // The two modes need different fields, and a config that names a
    // mode without the field it depends on would fail at execution time
    // with nobody watching. Caught here instead, while somebody is
    // looking at a screen.
    if (value.assignmentMode === "Fixed" && !value.assigneeId) {
      ctx.addIssue({
        code: "custom",
        path: ["assigneeId"],
        message: "Pick who this task should be assigned to.",
      });
    }
    if (value.assignmentMode === "RoundRobin" && value.rotation.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["rotation"],
        message: "Add at least one person to rotate through.",
      });
    }
  });

export const ACTION_LEAD_UPDATE = "lead.update";
export const ACTION_LEAD_DEACTIVATE = "lead.deactivate";

const UPDATE_ASSIGNMENT_MODE_OPTIONS = [
  { value: "None", label: "Don't change the owner" },
  { value: "Fixed", label: "Fixed — always the same person" },
  { value: "RoundRobin", label: "Round-robin — rotate through a list" },
] as const;

const LEAD_UPDATE_STATUS_OPTIONS = [
  { value: "", label: "Don't change" },
  { value: "Active", label: "Active" },
  { value: "Inactive", label: "Inactive" },
] as const;

const leadUpdateConfigSchema = z
  .object({
    // "" means "leave this field alone" throughout this schema — see the
    // migration's design note 5 for why NULL (not empty string) is what
    // actually reaches the database as "untouched", and
    // registry/executors.ts for where "" is translated to that NULL.
    nextStep: z.string().trim().max(MAX_NEXT_STEP_LENGTH).default(""),
    // Kept as text, not a number field, specifically so an empty input
    // stays an unambiguous "untouched" rather than colliding with 0 as a
    // deliberately-entered value — see the same design note.
    dealValue: z.string().trim().max(MAX_DEAL_VALUE_TEXT_LENGTH).default(""),
    status: z.enum(["", "Active", "Inactive"]).default(""),
    assignmentMode: z.enum(["None", "Fixed", "RoundRobin"]).default("None"),
    assigneeId: z.string().uuid().nullable().default(null),
    rotation: z.array(z.string().uuid()).max(MAX_ROUND_ROBIN_POOL).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.dealValue !== "" && (Number.isNaN(Number(value.dealValue)) || Number(value.dealValue) < 0)) {
      ctx.addIssue({ code: "custom", path: ["dealValue"], message: "Enter a number of 0 or more, or leave blank." });
    }
    if (value.assignmentMode === "Fixed" && !value.assigneeId) {
      ctx.addIssue({ code: "custom", path: ["assigneeId"], message: "Pick who the lead should be assigned to." });
    }
    if (value.assignmentMode === "RoundRobin" && value.rotation.length === 0) {
      ctx.addIssue({ code: "custom", path: ["rotation"], message: "Add at least one person to rotate through." });
    }
  });

const actions: RegistryEntry[] = [
  {
    key: ACTION_TASK_CREATE,
    kind: "action",
    label: "Create a task",
    description:
      "Creates a task on the lead that triggered the automation, assigned either to one fixed person or to the next person in a rotation.",
    example: "Create a high-priority call task due tomorrow for every new IndiaMART lead.",
    limitations: [
      "Always attaches the task to the lead that triggered the automation. It cannot create a standalone task or attach one to a different lead.",
      "Can only assign to active members of your organisation.",
      "Cannot send an email, a notification or a WhatsApp message — creating the task is the whole action.",
    ],
    fields: [
      {
        name: "subject",
        label: "Subject",
        kind: "text",
        required: true,
        maxLength: MAX_SUBJECT_LENGTH,
        placeholder: "Call {{lead.company}} about their enquiry",
        helperText: `You can use ${SUBJECT_TOKENS.map((entry) => entry.token).join(", ")}.`,
        templated: true,
      },
      {
        name: "description",
        label: "Description",
        kind: "textarea",
        required: false,
        maxLength: MAX_DESCRIPTION_LENGTH,
        helperText: "Optional. The same placeholders work here.",
        templated: true,
      },
      { name: "type", label: "Type", kind: "select", required: true, options: TASK_TYPE_OPTIONS },
      { name: "priority", label: "Priority", kind: "select", required: true, options: TASK_PRIORITY_OPTIONS },
      {
        name: "dueInDays",
        label: "Due in (days)",
        kind: "number",
        required: true,
        min: 0,
        max: MAX_DUE_DATE_OFFSET_DAYS,
        helperText: "Counted from the day the automation runs. 0 means today.",
      },
      {
        name: "assignmentMode",
        label: "Assignment",
        kind: "select",
        required: true,
        options: ASSIGNMENT_MODE_OPTIONS,
      },
      {
        name: "assigneeId",
        label: "Assign to",
        kind: "team-single",
        required: true,
        visibleWhen: { field: "assignmentMode", equals: "Fixed" },
      },
      {
        name: "rotation",
        label: "Rotate through",
        kind: "team-multi",
        required: true,
        visibleWhen: { field: "assignmentMode", equals: "RoundRobin" },
        helperText:
          "Tasks are handed out in the order shown. This list starts empty and never includes your whole team automatically.",
      },
    ],
    configSchema: taskCreateConfigSchema,
    defaultConfig: {
      subject: "Follow up with {{lead.company}}",
      description: null,
      type: "Call",
      priority: "Medium",
      dueInDays: 1,
      assignmentMode: "Fixed",
      assigneeId: null,
      rotation: [],
    },
  },
  {
    key: ACTION_LEAD_UPDATE,
    kind: "action",
    label: "Update the lead",
    description:
      "Changes one or more fields on the lead that triggered the automation — its next step, deal value, status, or who owns it.",
    example: "When a lead's deal value passes ₹50,000, update its status and hand it to the next rep in rotation.",
    limitations: [
      "Can only change next step, deal value, status and owner — nothing else, and never the pipeline stage.",
      "Cannot change company, contact details or source.",
      "A field left blank here is left exactly as it was — this action cannot clear a field to empty.",
      "Can only assign to active members of your organisation.",
    ],
    fields: [
      {
        name: "nextStep",
        label: "Next step",
        kind: "text",
        required: false,
        maxLength: MAX_NEXT_STEP_LENGTH,
        placeholder: "Send pricing information",
        helperText: "Leave blank to leave the current next step unchanged.",
        templated: true,
      },
      {
        name: "dealValue",
        label: "Deal value",
        kind: "text",
        required: false,
        placeholder: "50000",
        helperText: "Leave blank to leave unchanged. Enter a number with no currency symbol or commas.",
      },
      {
        name: "status",
        label: "Status",
        kind: "select",
        required: true,
        options: LEAD_UPDATE_STATUS_OPTIONS,
      },
      {
        name: "assignmentMode",
        label: "Owner",
        kind: "select",
        required: true,
        options: UPDATE_ASSIGNMENT_MODE_OPTIONS,
      },
      {
        name: "assigneeId",
        label: "Assign to",
        kind: "team-single",
        required: true,
        visibleWhen: { field: "assignmentMode", equals: "Fixed" },
      },
      {
        name: "rotation",
        label: "Rotate through",
        kind: "team-multi",
        required: true,
        visibleWhen: { field: "assignmentMode", equals: "RoundRobin" },
        helperText: "This rotation is shared with any other action in this workflow that also rotates.",
      },
    ],
    configSchema: leadUpdateConfigSchema,
    defaultConfig: { nextStep: "", dealValue: "", status: "", assignmentMode: "None", assigneeId: null, rotation: [] },
  },
  {
    key: ACTION_LEAD_DEACTIVATE,
    kind: "action",
    label: "Deactivate the lead",
    description: "Marks the lead that triggered the automation Inactive — the same one-way, no-data-loss deactivation Task and Contact already have.",
    example: "When a lead has had no activity for 90 days, deactivate it instead of leaving it open forever.",
    limitations: [
      "One-way. There is no automation action that reactivates a lead — reactivation is a manual step outside this feature.",
      "Deactivating an already-Inactive lead is a safe no-op, not an error, so a retried event never fails because of this.",
      "Targets ONLY the lead that triggered this automation — never an arbitrary lead id.",
    ],
    fields: [],
    configSchema: z.object({}),
    defaultConfig: {},
  },
];

// ---------------------------------------------------------------------
// Records — Task and Contact
// ---------------------------------------------------------------------
//
// A second and third real write domain, alongside Lead. Every Update and
// Deactivate action here targets an earlier Create node IN THIS SAME
// WORKFLOW by reference (`sourceNodeId`) rather than a raw record id — a
// Lead-triggered workflow has no Task or Contact of its own to name, only
// ones a prior Create step made. See registry/executors.ts for how that
// reference is resolved (the referenced node's own deterministic
// idempotency key, recomputed) and the migration's own design note 7 for
// the full reasoning this was checked against (branching, retries,
// parallel execution, multiple Create nodes).
//
// Get Record and Loop are deliberately not here — see docs/automations.md.

export const ACTION_CONTACT_CREATE = "contact.create";
export const ACTION_TASK_UPDATE = "task.update";
export const ACTION_CONTACT_UPDATE = "contact.update";
export const ACTION_TASK_DEACTIVATE = "task.deactivate";
export const ACTION_CONTACT_DEACTIVATE = "contact.deactivate";

/** Builds an Update action's "" = untouched field descriptors STRAIGHT
 *  FROM a field registry (TASK_FIELD_REGISTRY/CONTACT_FIELD_REGISTRY) —
 *  never a hand-written list, so the config panel can never offer a
 *  field the backend does not also accept. Mirrors lead.update's own
 *  "" convention (a blank input means "leave alone", enforced in
 *  registry/executors.ts, which is also where "" becomes a real SQL
 *  NULL) — extended here to also generate the enum "Don't change"
 *  option and the date field's own validation. */
/** Keys `updateFieldDescriptors` marks `templated: true` — Task's
 *  `subject`/`description` are the only Update-action fields
 *  registry/executors.ts's `updateTask` actually passes through
 *  renderTemplate; Contact's fields are deliberately literal
 *  pass-through text (see executors.ts's own note on `updateContact`),
 *  and a token typed into one of those would just sit there unresolved.
 *  A plain key set, not a per-registry flag, because both
 *  TASK_FIELD_REGISTRY and CONTACT_FIELD_REGISTRY share this one
 *  function and only two keys across both need the distinction. */
const TEMPLATED_UPDATE_FIELD_KEYS = new Set(["subject", "description"]);

function updateFieldDescriptors(entries: ReadonlyArray<FieldRegistryEntry>): FieldDescriptor[] {
  return entries.map((field) => {
    if (field.type === "enum") {
      return {
        name: field.key,
        label: field.label,
        kind: "select" as const,
        required: false,
        options: [{ value: "", label: "Don't change" }, ...(field.enumOptions ?? [])],
      };
    }
    if (field.type === "date") {
      return {
        name: field.key,
        label: field.label,
        kind: "text" as const,
        required: false,
        placeholder: "YYYY-MM-DD",
        maxLength: 10,
        helperText: "Leave blank to leave unchanged.",
      };
    }
    return {
      name: field.key,
      label: field.label,
      kind: "text" as const,
      required: false,
      maxLength: field.maxLength,
      helperText: "Leave blank to leave unchanged.",
      templated: TEMPLATED_UPDATE_FIELD_KEYS.has(field.key),
    };
  });
}

/** The Zod half of updateFieldDescriptors — same registry, same "" =
 *  untouched convention, so the two can never disagree about which
 *  fields exist. */
function updateFieldShape(entries: ReadonlyArray<FieldRegistryEntry>): z.ZodRawShape {
  return Object.fromEntries(
    entries.map((field) => {
      if (field.type === "enum") {
        const values = ["", ...(field.enumOptions ?? []).map((option) => option.value)] as [string, ...string[]];
        return [field.key, z.enum(values).default("")];
      }
      return [field.key, z.string().trim().max(field.maxLength ?? MAX_CONTACT_TEXT_FIELD_LENGTH).default("")];
    }),
  );
}

const contactCreateConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_CONTACT_NAME_LENGTH),
    company: z.string().trim().max(MAX_CONTACT_TEXT_FIELD_LENGTH).default(""),
    title: z.string().trim().max(MAX_CONTACT_TEXT_FIELD_LENGTH).default(""),
    email: z.string().trim().max(MAX_CONTACT_TEXT_FIELD_LENGTH).default(""),
    phone: z.string().trim().max(MAX_CONTACT_TEXT_FIELD_LENGTH).default(""),
    // Contacts.owner_id is NOT NULL — unlike Lead/Task's Update actions,
    // there is no "None" mode here; a contact must always resolve to
    // someone, same as task.create's own assignment shape.
    assignmentMode: z.enum(["Fixed", "RoundRobin"]),
    assigneeId: z.string().uuid().nullable().default(null),
    rotation: z.array(z.string().uuid()).max(MAX_ROUND_ROBIN_POOL).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.assignmentMode === "Fixed" && !value.assigneeId) {
      ctx.addIssue({ code: "custom", path: ["assigneeId"], message: "Pick who this contact should be assigned to." });
    }
    if (value.assignmentMode === "RoundRobin" && value.rotation.length === 0) {
      ctx.addIssue({ code: "custom", path: ["rotation"], message: "Add at least one person to rotate through." });
    }
  });

function sourceNodeIdShape(message: string) {
  return z.string().trim().min(1, message).max(MAX_NODE_REFERENCE_LENGTH);
}

const taskUpdateConfigSchema = z
  .object({
    sourceNodeId: sourceNodeIdShape("Pick which Create Task step this updates."),
    ...updateFieldShape(TASK_FIELD_REGISTRY),
    assignmentMode: z.enum(["None", "Fixed", "RoundRobin"]).default("None"),
    assigneeId: z.string().uuid().nullable().default(null),
    rotation: z.array(z.string().uuid()).max(MAX_ROUND_ROBIN_POOL).default([]),
  })
  .superRefine((value, ctx) => {
    const raw = value as unknown as { due_date?: string };
    if (raw.due_date && raw.due_date !== "" && !isRealIsoDate(raw.due_date)) {
      ctx.addIssue({ code: "custom", path: ["due_date"], message: "Enter a real date as YYYY-MM-DD, or leave blank." });
    }
    if (value.assignmentMode === "Fixed" && !value.assigneeId) {
      ctx.addIssue({ code: "custom", path: ["assigneeId"], message: "Pick who this task should be assigned to." });
    }
    if (value.assignmentMode === "RoundRobin" && value.rotation.length === 0) {
      ctx.addIssue({ code: "custom", path: ["rotation"], message: "Add at least one person to rotate through." });
    }
  });

const contactUpdateConfigSchema = z
  .object({
    sourceNodeId: sourceNodeIdShape("Pick which Create Contact step this updates."),
    ...updateFieldShape(CONTACT_FIELD_REGISTRY),
    assignmentMode: z.enum(["None", "Fixed", "RoundRobin"]).default("None"),
    assigneeId: z.string().uuid().nullable().default(null),
    rotation: z.array(z.string().uuid()).max(MAX_ROUND_ROBIN_POOL).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.assignmentMode === "Fixed" && !value.assigneeId) {
      ctx.addIssue({ code: "custom", path: ["assigneeId"], message: "Pick who this contact should be assigned to." });
    }
    if (value.assignmentMode === "RoundRobin" && value.rotation.length === 0) {
      ctx.addIssue({ code: "custom", path: ["rotation"], message: "Add at least one person to rotate through." });
    }
  });

const taskDeactivateConfigSchema = z.object({
  sourceNodeId: sourceNodeIdShape("Pick which Create Task step this deactivates."),
});

const contactDeactivateConfigSchema = z.object({
  sourceNodeId: sourceNodeIdShape("Pick which Create Contact step this deactivates."),
});

const recordActions: RegistryEntry[] = [
  {
    key: ACTION_CONTACT_CREATE,
    kind: "action",
    label: "Create a contact",
    description: "Creates a contact on the lead that triggered the automation, assigned to one fixed person or the next person in a rotation.",
    example: "When a new IndiaMART lead comes in with a named contact, create a Contact record for them right away.",
    limitations: [
      "Always attaches the contact to the lead that triggered the automation.",
      "Can only assign to active members of your organisation.",
      "Tags cannot be set here — add them by hand after the contact is created.",
    ],
    fields: [
      { name: "name", label: "Name", kind: "text", required: true, maxLength: MAX_CONTACT_NAME_LENGTH },
      { name: "company", label: "Company", kind: "text", required: false, maxLength: MAX_CONTACT_TEXT_FIELD_LENGTH },
      { name: "title", label: "Title", kind: "text", required: false, maxLength: MAX_CONTACT_TEXT_FIELD_LENGTH },
      { name: "email", label: "Email", kind: "text", required: false, maxLength: MAX_CONTACT_TEXT_FIELD_LENGTH },
      { name: "phone", label: "Phone", kind: "text", required: false, maxLength: MAX_CONTACT_TEXT_FIELD_LENGTH },
      { name: "assignmentMode", label: "Assignment", kind: "select", required: true, options: ASSIGNMENT_MODE_OPTIONS },
      { name: "assigneeId", label: "Assign to", kind: "team-single", required: true, visibleWhen: { field: "assignmentMode", equals: "Fixed" } },
      {
        name: "rotation",
        label: "Rotate through",
        kind: "team-multi",
        required: true,
        visibleWhen: { field: "assignmentMode", equals: "RoundRobin" },
        helperText: "This rotation is shared with any other action in this workflow that also rotates.",
      },
    ],
    configSchema: contactCreateConfigSchema,
    defaultConfig: { name: "", company: "", title: "", email: "", phone: "", assignmentMode: "Fixed", assigneeId: null, rotation: [] },
  },
  {
    key: ACTION_TASK_UPDATE,
    kind: "action",
    label: "Update the task",
    description: "Changes one or more fields on a task an earlier Create a task step made in this same workflow.",
    example: "After creating a follow-up task, mark it High priority once the lead's deal value passes a threshold.",
    limitations: [
      "Only acts on a task created by a Create a task step earlier in this SAME workflow run — never an arbitrary or pre-existing task.",
      "If that step did not run on this event (a different branch was taken), this action does nothing and is recorded as such.",
      "A field left blank here is left exactly as it was — this action cannot clear a field to empty.",
    ],
    fields: [
      { name: "sourceNodeId", label: "Which task", kind: "node-reference", required: true, targetType: ACTION_TASK_CREATE },
      ...updateFieldDescriptors(getWritableTaskFields()),
      { name: "assignmentMode", label: "Owner", kind: "select", required: true, options: UPDATE_ASSIGNMENT_MODE_OPTIONS },
      { name: "assigneeId", label: "Assign to", kind: "team-single", required: true, visibleWhen: { field: "assignmentMode", equals: "Fixed" } },
      {
        name: "rotation",
        label: "Rotate through",
        kind: "team-multi",
        required: true,
        visibleWhen: { field: "assignmentMode", equals: "RoundRobin" },
        helperText: "This rotation is shared with any other action in this workflow that also rotates.",
      },
    ],
    configSchema: taskUpdateConfigSchema,
    defaultConfig: {
      sourceNodeId: "",
      subject: "",
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
  {
    key: ACTION_CONTACT_UPDATE,
    kind: "action",
    label: "Update the contact",
    description: "Changes one or more fields on a contact an earlier Create a contact step made in this same workflow.",
    example: "After creating a contact, fill in their title once it's known.",
    limitations: [
      "Only acts on a contact created by a Create a contact step earlier in this SAME workflow run.",
      "If that step did not run on this event, this action does nothing and is recorded as such.",
      "A field left blank here is left exactly as it was. Tags cannot be changed here.",
    ],
    fields: [
      { name: "sourceNodeId", label: "Which contact", kind: "node-reference", required: true, targetType: ACTION_CONTACT_CREATE },
      ...updateFieldDescriptors(getWritableContactFields()),
      { name: "assignmentMode", label: "Owner", kind: "select", required: true, options: UPDATE_ASSIGNMENT_MODE_OPTIONS },
      { name: "assigneeId", label: "Assign to", kind: "team-single", required: true, visibleWhen: { field: "assignmentMode", equals: "Fixed" } },
      {
        name: "rotation",
        label: "Rotate through",
        kind: "team-multi",
        required: true,
        visibleWhen: { field: "assignmentMode", equals: "RoundRobin" },
        helperText: "This rotation is shared with any other action in this workflow that also rotates.",
      },
    ],
    configSchema: contactUpdateConfigSchema,
    defaultConfig: {
      sourceNodeId: "",
      name: "",
      company: "",
      title: "",
      email: "",
      phone: "",
      assignmentMode: "None",
      assigneeId: null,
      rotation: [],
    },
  },
  {
    key: ACTION_TASK_DEACTIVATE,
    kind: "action",
    label: "Delete the task (deactivate)",
    description: "Deactivates a task an earlier Create a task step made in this same workflow. Never a real delete — the record stays, marked Inactive.",
    example: "If a lead is disqualified, deactivate the follow-up task an earlier step created for it.",
    limitations: [
      "Only deactivates — there is no automation action that permanently deletes a task.",
      "Only acts on a task created by a Create a task step earlier in this SAME workflow run.",
      "Cannot be undone by this workflow — reactivation is not an automation capability.",
    ],
    fields: [{ name: "sourceNodeId", label: "Which task", kind: "node-reference", required: true, targetType: ACTION_TASK_CREATE }],
    configSchema: taskDeactivateConfigSchema,
    defaultConfig: { sourceNodeId: "" },
  },
  {
    key: ACTION_CONTACT_DEACTIVATE,
    kind: "action",
    label: "Delete the contact (deactivate)",
    description: "Deactivates a contact an earlier Create a contact step made in this same workflow. Never a real delete — the record stays, marked Inactive.",
    example: "If a contact turns out to be a duplicate, deactivate the one an earlier step just created.",
    limitations: [
      "Only deactivates — there is no automation action that permanently deletes a contact.",
      "Only acts on a contact created by a Create a contact step earlier in this SAME workflow run.",
      "Cannot be undone by this workflow.",
    ],
    fields: [{ name: "sourceNodeId", label: "Which contact", kind: "node-reference", required: true, targetType: ACTION_CONTACT_CREATE }],
    configSchema: contactDeactivateConfigSchema,
    defaultConfig: { sourceNodeId: "" },
  },
];

// ---------------------------------------------------------------------
// Get Records and Loop — collection variables, read here, consumed here.
// ---------------------------------------------------------------------
//
// Get Records is the FIRST read-only step in this registry: it queries
// up to MAX_RECORDS_PER_QUERY of a tenant's own most-recent Lead, Task
// or Contact rows (get_automation_records, tenant-scoped the identical
// way every write function already is — see that migration's own
// design notes) and filters them, IN TYPESCRIPT, with the SAME AND/OR
// engine (evaluateFieldGroup) a Decision or Condition already runs —
// reusing the field registry for whichever object was picked
// (object-fields.ts), never a second filter language. The result is
// stored in a named COLLECTION variable a later Loop can consume.
//
// Loop iterates that collection, running its OWN single body action
// once per item (capped at MAX_LOOP_ITERATIONS) — see the Loop executor
// in registry/executors.ts for exactly how that composes with
// MAX_ACTIONS_PER_EVENT rather than bypassing it, and for the stated
// v1 shape of a loop body here: exactly one action, connected as the
// Loop node's own single output on the canvas, not a config field.

const variableNameShape = () =>
  z
    .string()
    .trim()
    .min(1, "Name this variable.")
    .max(MAX_VARIABLE_NAME_LENGTH)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, "Use letters, numbers and underscores, starting with a letter.");

const getRecordsConfigSchema = z.object({
  object: z.enum(["lead", "task", "contact"]).default("task"),
  filters: conditionGroupSchema,
  limit: z.coerce.number().int().min(1).max(MAX_RECORDS_PER_QUERY).default(20),
  resultVariable: variableNameShape(),
});

const loopConfigSchema = z.object({
  collectionVariable: variableNameShape(),
  itemVariable: variableNameShape(),
});

export const ACTION_GET_RECORDS = "records.get";
export const ACTION_LOOP = "workflow.loop";

const queryActions: RegistryEntry[] = [
  {
    key: ACTION_GET_RECORDS,
    kind: "action",
    label: "Get records",
    description:
      "Fetches this tenant's own most recent Leads, Tasks or Contacts matching a filter, and stores them in a variable a Loop step can go through one at a time.",
    example: "Get every open Task assigned to nobody, then loop through them and deactivate each one.",
    limitations: [
      `Looks at only the ${MAX_RECORDS_PER_QUERY} most recent records of the chosen type — an older matching record beyond that window will not be found. This is a search of recent history, not the whole table.`,
      "Filters use the same field list a Decision step reads for Lead, and the writable-field lists Update Task/Update Contact use for Task and Contact — not a separate list.",
      "Cannot read Lead, Task or Contact fields beyond what those registries already expose.",
    ],
    fields: [
      { name: "object", label: "Type of record", kind: "select", required: true, options: OBJECT_OPTIONS },
      { name: "filters", label: "Filter", kind: "condition-group", required: false, objectFieldName: "object" },
      {
        name: "limit",
        label: "How many (max)",
        kind: "number",
        required: true,
        min: 1,
        max: MAX_RECORDS_PER_QUERY,
        helperText: `Up to ${MAX_RECORDS_PER_QUERY}, searching the most recent records first.`,
      },
      {
        name: "resultVariable",
        label: "Store the results as",
        kind: "text",
        required: true,
        placeholder: "unassigned_tasks",
        helperText: "Name this so a Loop step below can go through what was found, one at a time.",
      },
    ],
    configSchema: getRecordsConfigSchema,
    // An EMPTY group (no rules), not DEFAULT_CONDITION_GROUP_CONFIG —
    // that constant is shaped `{ root: ConditionGroup }` for lead.match's
    // own config, one level removed from the bare ConditionGroup this
    // field holds directly. An empty AND-group is vacuously true, which
    // is exactly the right default here: "no filter configured yet"
    // reads as "match everything of this type," a genuinely useful
    // default rather than an unfixable one.
    defaultConfig: { object: "task", filters: { kind: "group", match: "all", rules: [] }, limit: 20, resultVariable: "" },
  },
  {
    key: ACTION_LOOP,
    kind: "action",
    label: "Loop through records",
    description: "Runs one step once for every record an earlier Get Records step found, up to a fixed safety limit.",
    example: "Loop through the tasks Get Records found and deactivate each one.",
    limitations: [
      `Runs at most ${MAX_LOOP_ITERATIONS} times per event, regardless of how many records were found.`,
      "The body is exactly ONE step — whichever single step this Loop connects to on the canvas. It cannot hold a branch or a sequence of several steps yet.",
      "Counts toward the same total-actions-per-event limit every other step does — a large loop can still be stopped part-way if the rest of the automation's own budget runs out first.",
      "Needs a collection from an earlier Get Records step in this SAME workflow — it cannot iterate a variable nothing set.",
    ],
    fields: [
      {
        name: "collectionVariable",
        label: "Go through",
        kind: "text",
        required: true,
        placeholder: "unassigned_tasks",
        helperText: "The name an earlier Get Records step stored its results as.",
      },
      {
        name: "itemVariable",
        label: "Call each one",
        kind: "text",
        required: true,
        placeholder: "task",
        helperText: 'Reuse this in the step below as {{item.fieldName}} — e.g. {{item.subject}}.',
      },
    ],
    configSchema: loopConfigSchema,
    defaultConfig: { collectionVariable: "", itemVariable: "item" },
  },
];

// ---------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------

export const REGISTRY_ENTRIES: ReadonlyArray<RegistryEntry> = [
  ...triggers,
  ...conditions,
  ...decisions,
  ...assignments,
  ...actions,
  ...recordActions,
  ...queryActions,
];

const BY_KEY = new Map(REGISTRY_ENTRIES.map((entry) => [entry.key, entry]));

/**
 * The single lookup every consumer uses. Returns undefined for anything
 * not in the registry — which is how an AI-proposed node type that does
 * not exist is rejected: there is nothing to find, so there is nothing
 * to run.
 */
export function getRegistryEntry(key: string): RegistryEntry | undefined {
  return BY_KEY.get(key);
}

export function getEntriesByKind(kind: AutomationNodeKind): ReadonlyArray<RegistryEntry> {
  return REGISTRY_ENTRIES.filter((entry) => entry.kind === kind);
}

/** Every key the model is allowed to name, for the prompt and for the
 *  output validator. Derived, never listed a second time by hand. */
export function getAllRegistryKeys(): string[] {
  return REGISTRY_ENTRIES.map((entry) => entry.key);
}
