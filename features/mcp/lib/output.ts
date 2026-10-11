import { currencyFormatter } from "@/utils/format";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import { formatLeadLabel, type LeadLabel } from "@/features/leads/lib/get-lead-labels";
import {
  CONTACT_OUTPUT_FIELDS,
  FORBIDDEN_OUTPUT_KEYS,
  LEAD_OUTPUT_FIELDS,
  TASK_OUTPUT_FIELDS,
} from "../registry/fields";

/**
 * PROJECTIONS — every MCP response is built here, key by key, from the
 * allowlists in registry/fields.ts. Nothing spreads a database row into a
 * response, so a column added to a table later can never leak through MCP
 * by accident; it has to be added to an allowlist on purpose.
 */

type Row = Record<string, unknown>;

/** Money as a number plus an INR string, e.g. 18000 -> "₹18,000". */
export function money(value: unknown): { value: number | null; formatted: string | null } {
  if (value === null || value === undefined || value === "") return { value: null, formatted: null };
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return { value: null, formatted: null };
  return { value: parsed, formatted: currencyFormatter.format(parsed) };
}

function pick<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Record<K, unknown> {
  const out = {} as Record<K, unknown>;
  for (const key of keys) {
    out[key] = source[key] ?? null;
  }
  return out;
}

export type ProjectionLookups = {
  stagesById?: Map<string, CustomerLeadStage>;
  peopleById?: Map<string, TeamDirectoryEntry>;
  leadLabelsById?: Map<string, LeadLabel>;
};

function personName(lookups: ProjectionLookups, customerUserId: unknown): string | null {
  if (typeof customerUserId !== "string") return null;
  const person = lookups.peopleById?.get(customerUserId);
  return person ? (person.name ?? person.email) : null;
}

function leadLabel(lookups: ProjectionLookups, leadId: unknown): string | null {
  if (typeof leadId !== "string") return null;
  const label = lookups.leadLabelsById?.get(leadId);
  return label ? formatLeadLabel(label) : null;
}

export function projectLead(row: Row, lookups: ProjectionLookups) {
  const stage = typeof row.stage_id === "string" ? lookups.stagesById?.get(row.stage_id) : undefined;
  const deal = money(row.deal_value);
  return pick(
    {
      ...pick(row, ["id", "company", "contact_name", "email", "phone", "whatsapp_phone", "address", "stage_id", "owner_id", "source", "next_step", "status", "closed_at", "expected_close_date", "created_at", "updated_at"]),
      deal_value: deal.value,
      deal_value_formatted: deal.formatted,
      stage: stage?.stage ?? null,
      is_closed: row.closed_at !== null && row.closed_at !== undefined,
      is_won: stage?.is_won ?? false,
      owner_name: personName(lookups, row.owner_id),
    },
    LEAD_OUTPUT_FIELDS,
  );
}

export function projectTask(row: Row, lookups: ProjectionLookups) {
  return pick(
    {
      ...pick(row, ["id", "subject", "description", "priority", "due_date", "type", "status", "lead_id", "created_at", "updated_at"]),
      lead_label: leadLabel(lookups, row.lead_id),
      assignee_id: row.assigned_to ?? null,
      assignee_name: personName(lookups, row.assigned_to),
    },
    TASK_OUTPUT_FIELDS,
  );
}

export function projectContact(row: Row, lookups: ProjectionLookups) {
  return pick(
    {
      ...pick(row, ["id", "name", "company", "title", "email", "phone", "lead_id", "owner_id", "created_at", "updated_at"]),
      tags: Array.isArray(row.tags) ? row.tags : [],
      lead_label: leadLabel(lookups, row.lead_id),
      owner_name: personName(lookups, row.owner_id),
    },
    CONTACT_OUTPUT_FIELDS,
  );
}

/**
 * The runtime net under the projections, applied to every tool response:
 *   1. top-level keys not in the tool's outputFields are dropped;
 *   2. any FORBIDDEN_OUTPUT_KEYS key is removed at every depth.
 * Returns the cleaned value and whether anything had to be removed — a
 * removal means a projection bug, and the caller logs it.
 */
export function enforceOutputAllowlist(
  data: Record<string, unknown>,
  allowed: readonly string[],
): { data: Record<string, unknown>; stripped: string[] } {
  const stripped: string[] = [];

  const scrub = (value: unknown, path: string): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => scrub(item, `${path}[${index}]`));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_OUTPUT_KEYS.includes(key.toLowerCase())) {
          stripped.push(`${path}.${key}`);
          continue;
        }
        out[key] = scrub(inner, `${path}.${key}`);
      }
      return out;
    }
    return value;
  };

  const top: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!allowed.includes(key)) {
      stripped.push(key);
      continue;
    }
    top[key] = value;
  }

  return { data: scrub(top, "$") as Record<string, unknown>, stripped };
}
