import { z } from "zod";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_DUE_DATE_OFFSET_DAYS,
  MAX_ROUND_ROBIN_POOL,
  MAX_SUBJECT_LENGTH,
  MAX_TRIGGER_SOURCES,
} from "../config/safeguards";
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
  | "source-multi";

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
   *  particular value — how the Fixed/round-robin branch is expressed
   *  without a second node type. */
  visibleWhen?: { field: string; equals: string };
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
 * Tokens allowed in a generated task subject or description.
 *
 * A FIXED LOOKUP TABLE, NOT AN EXPRESSION LANGUAGE. Substitution is a
 * literal replace of these exact strings with values read off the lead
 * row; anything else in the text is left alone. There is no path here
 * that evaluates, indexes by a caller-supplied key, or reaches any field
 * not named below — which is why a workflow definition cannot use this
 * to read something it was never granted.
 */
export const SUBJECT_TOKENS = [
  { token: "{{lead.company}}", description: "The lead's company name" },
  { token: "{{lead.contact_name}}", description: "The contact's name" },
  { token: "{{lead.source}}", description: "Where the lead came from, e.g. IndiaMART" },
] as const;

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

const leadCreatedConfigSchema = z.object({
  /** Empty means every source, including leads entered by hand. Kept as
   *  an explicit empty array rather than an absent key so a stored
   *  definition always states its own filter. */
  sources: z.array(z.string().trim().min(1)).max(MAX_TRIGGER_SOURCES).default([]),
});

const triggers: RegistryEntry[] = [
  {
    key: TRIGGER_LEAD_CREATED,
    kind: "trigger",
    label: "Lead is created",
    description:
      "Runs once each time a new lead is added, whether it was captured from a connected source or entered by hand.",
    example: "Run whenever a new IndiaMART enquiry arrives.",
    limitations: [
      "Fires on creation only — editing a lead later does not run the automation again.",
      "Cannot filter on anything except the lead's source. Deal value, stage and owner are not available as trigger filters.",
    ],
    fields: [
      {
        name: "sources",
        label: "Only for these sources",
        kind: "source-multi",
        required: false,
        helperText: "Leave empty to run for every new lead, however it was created.",
      },
    ],
    configSchema: leadCreatedConfigSchema,
    defaultConfig: { sources: [] },
  },
];

// ---------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------

export const CONDITION_LEAD_SOURCE_IS = "lead.source.is";
export const CONDITION_LEAD_HAS_OWNER = "lead.has_owner";

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
];

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
      },
      {
        name: "description",
        label: "Description",
        kind: "textarea",
        required: false,
        maxLength: MAX_DESCRIPTION_LENGTH,
        helperText: "Optional. The same placeholders work here.",
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
];

// ---------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------

export const REGISTRY_ENTRIES: ReadonlyArray<RegistryEntry> = [...triggers, ...conditions, ...actions];

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
