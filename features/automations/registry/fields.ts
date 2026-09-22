import { LEAD_SOURCES } from "@/features/leads/schemas";

/**
 * THE LEAD FIELD REGISTRY — every field a condition may read, and the
 * only place that list is written down.
 *
 * This is an ALLOWLIST, not a reflection of the `leads` table. A field
 * only appears here once it has been checked against three things: it
 * exists on `leads` today (verified against the live migrations, not
 * assumed), it means something stable to compare against, and reading it
 * needs no further plumbing this phase doesn't already have.
 *
 * DELIBERATELY EXCLUDED, with reasons, not silently:
 *   customer_id     the tenant boundary itself — never a condition input
 *   id              the record's own identity; leadId is available on
 *                   LeadFacts directly, not as a filterable field
 *   stage_id        a per-tenant dynamic enum (customer_lead_stages).
 *                   Exposing it meaningfully needs the option list
 *                   loaded into the condition builder the same way
 *                   TeamSelect loads team members — real plumbing this
 *                   phase does not add. Deferred, not faked.
 *   whatsapp_phone  redundant with `phone` for a v1 condition set
 *   closed_at       every value here is either present (closed) or
 *                   absent (open); is_empty/is_not_empty on it already
 *                   answers "is this lead closed", so it is covered by
 *                   the boolean-shaped operators on the date type below
 *                   rather than needing a dedicated field entry
 *
 * Every value here flows through evaluateFieldRule in plan-workflow.ts,
 * which looks a field up BY THIS REGISTRY, never by a caller-supplied
 * column name — there is no path from a workflow definition to an
 * arbitrary SQL identifier.
 */

export type FieldDataType = "text" | "number" | "date" | "boolean" | "enum" | "reference";

export type FieldOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "starts_with"
  | "is_empty"
  | "is_not_empty"
  | "greater_than"
  | "less_than"
  | "greater_than_or_equal"
  | "less_than_or_equal"
  | "before"
  | "after"
  | "between"
  | "is_any_of"
  | "is_true"
  | "is_false";

/** Every operator valid for a given data type — the config panel and
 *  the AI prompt both read this, so an operator can never be offered
 *  for a type it cannot evaluate. */
export const OPERATORS_BY_TYPE: Record<FieldDataType, ReadonlyArray<FieldOperator>> = {
  text: ["equals", "not_equals", "contains", "starts_with", "is_empty", "is_not_empty"],
  number: ["equals", "not_equals", "greater_than", "less_than", "greater_than_or_equal", "less_than_or_equal"],
  date: ["equals", "before", "after", "between", "is_empty", "is_not_empty"],
  boolean: ["is_true", "is_false"],
  enum: ["equals", "not_equals", "is_any_of", "is_empty", "is_not_empty"],
  reference: ["is_empty", "is_not_empty"],
};

export const OPERATOR_LABELS: Record<FieldOperator, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  starts_with: "starts with",
  is_empty: "is empty",
  is_not_empty: "is not empty",
  greater_than: "is greater than",
  less_than: "is less than",
  greater_than_or_equal: "is at least",
  less_than_or_equal: "is at most",
  before: "is before",
  after: "is after",
  between: "is between",
  is_any_of: "is any of",
  is_true: "is set",
  is_false: "is not set",
};

export type FieldRegistryEntry = {
  key: string;
  label: string;
  type: FieldDataType;
  /** For "enum" only — the closed set of values a caller may compare
   *  against. Sourced from this app's own existing registries where one
   *  exists (LEAD_SOURCES), not re-typed here, so a new source becomes
   *  filterable automatically. */
  enumOptions?: ReadonlyArray<{ value: string; label: string }>;
  helperText?: string;
  /** For a "text" field a caller may also WRITE (`writable: true`) —
   *  the bound an Update action's own config form enforces. Meaningless
   *  for a condition-only entry, which never accepts free-typed text of
   *  its own to bound. */
  maxLength?: number;
  /**
   * True when an Update action may set this field. UNRELATED to whether
   * a condition may read it — this registry (and the shape it shares
   * with TASK_FIELD_REGISTRY/CONTACT_FIELD_REGISTRY) is reused for two
   * genuinely different jobs that must not be conflated: what a
   * condition may COMPARE ("is Source equal to X"), and what an Update
   * action may SET ("change Priority to X"). LEAD_FIELD_REGISTRY's own
   * entries are all condition-only today (Lead's Update action predates
   * this registry and still hand-lists its own fields) — `writable` is
   * only meaningful, and only ever `true`, on the Task/Contact
   * registries, which exist for exactly the opposite reason: they have
   * no trigger yet, so every entry in them is writable-only, never
   * condition-evaluable, until a Task/Contact trigger is built and
   * reads this registry for that separate purpose. Left `undefined`
   * here rather than `false` so "not applicable" and "explicitly not
   * writable" stay visually distinct in each file. */
  writable?: boolean;
};

export const LEAD_FIELD_REGISTRY: ReadonlyArray<FieldRegistryEntry> = [
  { key: "company", label: "Company", type: "text" },
  { key: "contact_name", label: "Contact name", type: "text" },
  { key: "email", label: "Email", type: "text" },
  { key: "phone", label: "Phone", type: "text" },
  { key: "next_step", label: "Next step", type: "text" },
  { key: "deal_value", label: "Deal value", type: "number" },
  {
    key: "source",
    label: "Source",
    type: "enum",
    enumOptions: LEAD_SOURCES.map((source) => ({ value: source, label: source })),
    // A lead entered by hand with nothing picked has source = null, not
    // a value on this list — see LEAD_SOURCES's own note on why there is
    // deliberately no "entered by hand" entry here to pick instead.
    helperText: 'To match a lead with no source at all, use "is empty" rather than picking a value.',
  },
  {
    key: "status",
    label: "Status",
    type: "enum",
    enumOptions: [
      { value: "Active", label: "Active" },
      { value: "Inactive", label: "Inactive" },
    ],
  },
  { key: "expected_close_date", label: "Expected close date", type: "date" },
  { key: "created_at", label: "Created on", type: "date" },
  { key: "updated_at", label: "Last updated", type: "date" },
  {
    key: "owner_id",
    label: "Owner",
    type: "reference",
    helperText: "Only whether an owner is set can be checked — not which person.",
  },
];

const BY_KEY = new Map(LEAD_FIELD_REGISTRY.map((field) => [field.key, field]));

export function getFieldDefinition(key: string): FieldRegistryEntry | undefined {
  return BY_KEY.get(key);
}

export function getOperatorsForField(key: string): ReadonlyArray<FieldOperator> {
  const field = getFieldDefinition(key);
  return field ? OPERATORS_BY_TYPE[field.type] : [];
}
