import { z } from "zod";
import { isRealIsoDate } from "@/utils/iso-date";
import {
  MCP_MAX_FILTER_CONDITIONS,
  MCP_MAX_FILTER_TEXT_LENGTH,
  MCP_MAX_IN_VALUES,
  MCP_MAX_RESULTS_PER_CALL,
} from "../config/limits";
import { invalidInput } from "../lib/errors";

/**
 * THE STRUCTURED FILTER SPEC — how a search tool narrows results.
 *
 * NO QUERY TEXT EVER CROSSES THIS BOUNDARY. A caller sends
 * { field, operator, value } triples. `field` must be a key of the
 * object's FilterSpec (an allowlist written in registry/fields.ts, never
 * a column name taken from the request), `operator` must be one of the
 * seven below AND valid for that field's type, and `value` is checked
 * against that type. What reaches PostgREST is a supabase-js builder call
 * (.eq/.gt/.ilike/...) with the column from the allowlist and the value
 * as a bound parameter — there is no string concatenation into a filter
 * expression anywhere in this module, and no .or()/raw filter strings.
 *
 * RLS still decides which rows exist for the caller; filters can only
 * narrow that set, never widen it.
 */

export const FILTER_OPERATORS = [
  "equals",
  "not_equals",
  "greater_than",
  "less_than",
  "contains",
  "is_empty",
  "in",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterFieldType = "text" | "number" | "date" | "enum" | "uuid" | "boolean";

export const OPERATORS_BY_TYPE: Record<FilterFieldType, readonly FilterOperator[]> = {
  text: ["equals", "not_equals", "contains", "is_empty", "in"],
  number: ["equals", "not_equals", "greater_than", "less_than", "is_empty"],
  date: ["equals", "greater_than", "less_than", "is_empty"],
  enum: ["equals", "not_equals", "in"],
  uuid: ["equals", "in"],
  boolean: ["equals"],
};

export type FilterField = {
  column: string;
  type: FilterFieldType;
  description: string;
  options?: readonly string[];
  /** Needs a lookup before it can become a column filter:
   *    stage_name   a stage NAME the caller's company uses -> stage_id
   *    closed_flag  true/false -> closed_at is / is not null */
  special?: "stage_name" | "closed_flag";
};

export type FilterSpec = {
  fields: Record<string, FilterField>;
  /** Sortable field name -> column. */
  sortable: Record<string, string>;
  defaultSort: { column: string; ascending: boolean };
};

export type ValidatedCondition = {
  field: string;
  column: string;
  operator: FilterOperator;
  value: string | number | boolean | string[] | null;
  special?: FilterField["special"];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Characters PostgREST's `in.(...)` list syntax gives meaning to even
 *  inside quotes. Refused rather than escaped: no legitimate CRM value in
 *  an equality list needs them. */
const IN_LIST_FORBIDDEN = /["\\]/;

function textValue(field: string, value: unknown): string {
  if (typeof value !== "string") throw invalidInput(`Filter on "${field}" needs a text value.`);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MCP_MAX_FILTER_TEXT_LENGTH) {
    throw invalidInput(`Filter on "${field}" needs 1–${MCP_MAX_FILTER_TEXT_LENGTH} characters.`);
  }
  return trimmed;
}

function scalarValue(name: string, field: FilterField, value: unknown): string | number | boolean {
  switch (field.type) {
    case "text":
      return textValue(name, value);
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw invalidInput(`Filter on "${name}" needs a number.`);
      return value;
    case "date":
      if (typeof value !== "string" || !isRealIsoDate(value)) {
        throw invalidInput(`Filter on "${name}" needs a date in YYYY-MM-DD format.`);
      }
      return value;
    case "uuid":
      if (typeof value !== "string" || !UUID_PATTERN.test(value)) throw invalidInput(`Filter on "${name}" needs a record id.`);
      return value.toLowerCase();
    case "boolean":
      if (typeof value !== "boolean") throw invalidInput(`Filter on "${name}" needs true or false.`);
      return value;
    case "enum": {
      const text = typeof value === "string" ? value.trim() : "";
      // Stage names are tenant data resolved later; the rest have a fixed list.
      if (field.special === "stage_name") return textValue(name, text);
      const match = field.options?.find((option) => option.toLowerCase() === text.toLowerCase());
      if (!match) throw invalidInput(`Filter on "${name}" must be one of: ${(field.options ?? []).join(", ")}.`);
      return match;
    }
  }
}

/** Validates raw filter triples against one object's spec. Throws an
 *  invalid_input McpToolError naming the first problem; never echoes a
 *  submitted VALUE back, only the field/operator names it was given. */
export function validateFilters(
  spec: FilterSpec,
  raw: ReadonlyArray<{ field: string; operator: string; value?: unknown }>,
): ValidatedCondition[] {
  if (raw.length > MCP_MAX_FILTER_CONDITIONS) {
    throw invalidInput(`At most ${MCP_MAX_FILTER_CONDITIONS} filters are allowed.`);
  }

  return raw.map(({ field: name, operator, value }) => {
    const field = Object.prototype.hasOwnProperty.call(spec.fields, name) ? spec.fields[name] : undefined;
    if (!field) {
      throw invalidInput(`"${String(name).slice(0, 64)}" is not a field you can filter on.`);
    }
    if (!(FILTER_OPERATORS as readonly string[]).includes(operator)) {
      throw invalidInput(`"${String(operator).slice(0, 32)}" is not a supported operator.`);
    }
    const op = operator as FilterOperator;
    if (!OPERATORS_BY_TYPE[field.type].includes(op)) {
      throw invalidInput(`"${op}" cannot be used on "${name}". Use one of: ${OPERATORS_BY_TYPE[field.type].join(", ")}.`);
    }

    if (op === "is_empty") {
      return { field: name, column: field.column, operator: op, value: null, special: field.special };
    }

    if (op === "in") {
      if (!Array.isArray(value) || value.length === 0 || value.length > MCP_MAX_IN_VALUES) {
        throw invalidInput(`"in" on "${name}" needs a list of 1–${MCP_MAX_IN_VALUES} values.`);
      }
      const values = value.map((item) => String(scalarValue(name, field, item)));
      if (values.some((item) => IN_LIST_FORBIDDEN.test(item))) {
        throw invalidInput(`Values for "in" on "${name}" cannot contain quotes or backslashes.`);
      }
      return { field: name, column: field.column, operator: op, value: values, special: field.special };
    }

    return { field: name, column: field.column, operator: op, value: scalarValue(name, field, value), special: field.special };
  });
}

/** `contains` becomes ILIKE %value%. LIKE metacharacters in the value are
 *  escaped so they match literally; `*` is removed because PostgREST
 *  rewrites it to a wildcard before Postgres sees it. */
export function toContainsPattern(value: string): string {
  const escaped = value.replace(/[\\%_]/g, (character) => `\\${character}`).replace(/\*/g, "");
  return `%${escaped}%`;
}

/** The subset of the PostgREST filter builder this module calls. Typed
 *  structurally because this project has no generated Database types,
 *  which leaves supabase-js's own builder generics unhelpful here. */
export type FilterableQuery = {
  eq(column: string, value: unknown): FilterableQuery;
  neq(column: string, value: unknown): FilterableQuery;
  gt(column: string, value: unknown): FilterableQuery;
  lt(column: string, value: unknown): FilterableQuery;
  ilike(column: string, pattern: string): FilterableQuery;
  is(column: string, value: null): FilterableQuery;
  in(column: string, values: readonly unknown[]): FilterableQuery;
  not(column: string, operator: string, value: unknown): FilterableQuery;
  order(column: string, options: { ascending: boolean; nullsFirst?: boolean }): FilterableQuery;
  limit(count: number): FilterableQuery;
};

export type FilterResolvers = {
  /** Stage name (case-insensitive) -> stage id, or null when unknown. */
  stageIdByName?: (name: string) => string | null;
  stageNames?: () => string[];
};

function resolveStage(resolvers: FilterResolvers, name: string): string {
  const id = resolvers.stageIdByName?.(name) ?? null;
  if (!id) {
    const names = resolvers.stageNames?.() ?? [];
    throw invalidInput(`Unknown stage. Your stages are: ${names.join(", ")}.`);
  }
  return id;
}

export function applyConditions(
  query: FilterableQuery,
  conditions: readonly ValidatedCondition[],
  resolvers: FilterResolvers = {},
): FilterableQuery {
  let q = query;
  for (const condition of conditions) {
    const { column, operator } = condition;
    let value = condition.value;

    if (condition.special === "closed_flag") {
      q = value === true ? q.not(column, "is", null) : q.is(column, null);
      continue;
    }
    if (condition.special === "stage_name" && value !== null) {
      value = Array.isArray(value) ? value.map((name) => resolveStage(resolvers, name)) : resolveStage(resolvers, String(value));
    }

    switch (operator) {
      case "equals":
        q = q.eq(column, value);
        break;
      case "not_equals":
        q = q.neq(column, value);
        break;
      case "greater_than":
        q = q.gt(column, value);
        break;
      case "less_than":
        q = q.lt(column, value);
        break;
      case "contains":
        q = q.ilike(column, toContainsPattern(String(value)));
        break;
      case "is_empty":
        q = q.is(column, null);
        break;
      case "in":
        q = q.in(column, value as string[]);
        break;
    }
  }
  return q;
}

export function applySortAndLimit(
  query: FilterableQuery,
  spec: FilterSpec,
  sort: { field: string; direction?: "asc" | "desc" } | undefined,
  limit: number,
): FilterableQuery {
  const column = sort ? spec.sortable[sort.field] : undefined;
  if (sort && !column) throw invalidInput(`"${String(sort.field).slice(0, 64)}" is not a field you can sort by.`);
  const ordered = column
    ? query.order(column, { ascending: sort?.direction === "asc", nullsFirst: false })
    : query.order(spec.defaultSort.column, { ascending: spec.defaultSort.ascending, nullsFirst: false });
  // A stable tiebreak so equal sort keys page deterministically. One row
  // beyond the limit is fetched to report has_more without a COUNT.
  return ordered.order("id", { ascending: true }).limit(limit + 1);
}

function describeFields(spec: FilterSpec): string {
  return Object.entries(spec.fields)
    .map(([name, field]) => {
      const options = field.options ? ` (${field.options.join(" | ")})` : "";
      return `${name}: ${field.type}${options} — ${field.description}; operators: ${OPERATORS_BY_TYPE[field.type].join(", ")}`;
    })
    .join("\n");
}

/** The search input every search_* tool accepts. Unknown top-level keys
 *  (customer_id, owner_id, role, ...) are stripped by Zod and never
 *  reach the handler. */
export function searchInputSchema<Extra extends z.ZodRawShape>(spec: FilterSpec, extra: Extra) {
  const fieldNames = Object.keys(spec.fields) as [string, ...string[]];
  const sortNames = Object.keys(spec.sortable) as [string, ...string[]];

  return z.object({
    filters: z
      .array(
        z.object({
          field: z.enum(fieldNames),
          operator: z.enum(FILTER_OPERATORS),
          value: z
            .unknown()
            .optional()
            .describe("A single value, or a list of values for the `in` operator. Omit for `is_empty`."),
        }),
      )
      .max(MCP_MAX_FILTER_CONDITIONS)
      .optional()
      .describe(`Conditions, all of which must match. Fields:\n${describeFields(spec)}`),
    sort: z
      .object({ field: z.enum(sortNames), direction: z.enum(["asc", "desc"]).optional() })
      .optional()
      .describe("Sort order. Defaults to most recently updated first."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MCP_MAX_RESULTS_PER_CALL)
      .optional()
      .describe(`How many results to return (1–${MCP_MAX_RESULTS_PER_CALL}).`),
    ...extra,
  });
}
