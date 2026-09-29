import { currencyFormatter } from "@/utils/format";
import type { PipelineLead } from "@/features/leads/lib/get-leads";
import type { RelatedContact, RelatedTask } from "./fetch-records";
import type { ContactListItem } from "@/features/contacts/lib/get-contacts";
import type { Task } from "@/types/task";

/**
 * Deterministic, code-built summaries — LABELED FIELDS ON THEIR OWN
 * LINES, never an LLM-authored run-on paragraph. This is the direct
 * fix for two real bugs found in the previous, LLM-prose approach:
 *
 *   BUG 1 (missing stage): the old path handed the model a Lead's raw
 *   JSON, which never included a stage NAME at all (only `stage_id`,
 *   an opaque uuid with no meaning to a reader) — there was nothing
 *   for the model to report even if it tried. Fixed by resolving the
 *   real name here (fetch-records.ts's own fetchStageName, reusing
 *   the exact lookup Pipeline/stage-colors.ts already use) and simply
 *   including it as a field, the same as any other.
 *
 *   BUG 2 (wrong currency, "$99,999.88" instead of ₹): the old path
 *   handed the model a bare, unlabeled number and let IT decide how to
 *   write it as money — and a model's own training-derived default for
 *   unlabeled currency is USD. Fixed by never asking a model to format
 *   money at all: `formatMoney` below calls this app's own real
 *   currencyFormatter (utils/format.ts, en-IN/INR, the identical
 *   instance every KPI card and the Forecast page already use) —
 *   there is no LLM in this code path any more for a single-record
 *   detail view, so there is nothing left to invent a currency symbol.
 *
 * WHY deal_value IS COERCED WITH Number(...) HERE: Postgres NUMERIC
 * columns (deal_value is `numeric(12,2)`) round-trip through
 * PostgREST/supabase-js as JSON STRINGS, not JS numbers, to avoid
 * float precision loss on the wire — a well-known, standard behavior,
 * not data corruption. Every existing consumer (KPI cards, Pipeline's
 * own Value column) never notices, because `Intl.NumberFormat.format()`
 * coerces its argument with ToNumber regardless of whether it receives
 * a string or a number — this file does the same coercion explicitly,
 * for the same reason, so this is correct whichever shape the real
 * value arrives in.
 */

function formatMoney(value: number | string | null): string {
  if (value === null) return "—";
  const numeric = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return "—";
  return currencyFormatter.format(numeric);
}

function line(label: string, value: string | null | undefined): string {
  return `${label}: ${value && value.trim() ? value : "—"}`;
}

function formatContactLine(contact: RelatedContact): string {
  const roleOrCompany = [contact.title, contact.company].filter(Boolean).join(", ");
  const contactMethod = contact.phone ?? contact.email;
  const details = [roleOrCompany, contactMethod].filter(Boolean).join(" — ");
  return `- ${contact.name}${details ? ` (${details})` : ""}`;
}

function formatTaskLine(task: RelatedTask): string {
  const due = task.due_date ? `due ${task.due_date}` : "no due date";
  return `- ${task.subject} (${due}, ${task.status}, ${task.priority} priority)`;
}

/**
 * The lead's own labeled fields, plus its related Contacts and Tasks
 * (features/assistant/lib/fetch-records.ts's fetchRelatedRecordsForLead
 * — the same RLS-respecting query path the real Contacts/Tasks pages
 * use, never a parallel one). Every field named in the feature spec:
 * Company, Stage, Deal Value, Email, Phone, Next Step, Status.
 */
export function formatLeadSummary(
  lead: PipelineLead,
  stageName: string | null,
  related: { contacts: RelatedContact[]; tasks: RelatedTask[] },
): string {
  const header = lead.company ? `${lead.contact_name} — ${lead.company}` : lead.contact_name;

  const fields = [
    line("Company", lead.company),
    line("Stage", stageName),
    line("Deal Value", formatMoney(lead.deal_value)),
    line("Email", lead.email),
    line("Phone", lead.phone),
    line("Next Step", lead.next_step),
    line("Status", lead.status),
  ].join("\n");

  if (related.contacts.length === 0 && related.tasks.length === 0) {
    return `${header}\n${fields}\n\nNo related contacts or tasks yet.`;
  }

  const contactsSection =
    related.contacts.length > 0
      ? `Related Contacts:\n${related.contacts.map(formatContactLine).join("\n")}`
      : "Related Contacts: none yet";

  const tasksSection =
    related.tasks.length > 0 ? `Related Tasks:\n${related.tasks.map(formatTaskLine).join("\n")}` : "Related Tasks: none yet";

  return `${header}\n${fields}\n\n${contactsSection}\n\n${tasksSection}`;
}

export function formatContactSummary(contact: ContactListItem, leadLabel: string | null): string {
  const header = contact.company ? `${contact.name} — ${contact.company}` : contact.name;

  const fields = [
    line("Title", contact.title),
    line("Company", contact.company),
    line("Email", contact.email),
    line("Phone", contact.phone),
    line("Linked Lead", leadLabel),
  ].join("\n");

  return `${header}\n${fields}`;
}

export function formatTaskSummary(task: Task, leadLabel: string | null): string {
  return [
    task.subject,
    line("Type", task.type),
    line("Priority", task.priority),
    line("Due Date", task.due_date),
    line("Status", task.status),
    line("Description", task.description),
    line("Linked Lead", leadLabel),
  ].join("\n");
}
