import type { SupabaseClient } from "@supabase/supabase-js";
import { getLeadsForCustomer, type PipelineLead } from "@/features/leads/lib/get-leads";
import { getLeadStagesForCustomer } from "@/features/leads/lib/get-lead-stages";
import { getTasksForCustomer, getTasksForLead } from "@/features/tasks/lib/get-tasks";
import { getContactsForLead, getContactsPage, type ContactListItem } from "@/features/contacts/lib/get-contacts";
import { formatLeadLabel, getLeadLabelsByIds } from "@/features/leads/lib/get-lead-labels";
import type { Task } from "@/types/task";

/**
 * WHERE THIS ASSISTANT'S RECORDS COME FROM, AND WHY NOT
 * get_automation_records() — read this before changing anything here.
 *
 * The Automation engine's "Get Records" action was the mechanism this
 * feature was asked to reuse for summarization. It was NOT reused, for
 * a concrete, tested reason: get_automation_records() is a SECURITY
 * DEFINER function authorized by a shared WORKER TOKEN
 * (verify_automation_worker), not by the caller's own session — once
 * that token checks out, it returns EVERY row for whatever
 * `p_customer_id` it's given, with no owner/role filtering at all (see
 * supabase/migrations/20260925120000_get_automation_records.sql,
 * design note 1: "p_customer_id is never supplied by the workflow
 * definition" — true for the automation WORKER's own call path, but
 * nothing about the function itself enforces that for a different
 * caller). That is correct and necessary for an automation acting on
 * an EVENT on behalf of the whole tenant. It is NOT correct for "what
 * should this ONE logged-in user see" — a plain SALES_REP asking
 * "summarize my tasks" must see only their own tasks (or their
 * reports'), exactly what the real Tasks page shows them, never the
 * whole company's.
 *
 * getTasksForCustomer/getLeadsForCustomer/getContactsPage below are
 * the ACTUAL tenant-AND-role-scoped mechanism: they run through the
 * caller's own normal (RLS-respecting) Supabase client, the same one
 * every real page already uses, so "hierarchy-aware task/lead/contact
 * visibility" (the real RLS policies) enforces who may see which rows —
 * never re-implemented here, never re-decided by this feature. This is
 * what makes "confirm by comparing against the normal Tasks page" (the
 * feature's own validation requirement) trivially true: it's the exact
 * same query path, not a parallel one that could quietly drift from it.
 *
 * BOUNDED, same reasoning and same limit as the automation engine's own
 * MAX_RECORDS_PER_QUERY — this is context handed to an LLM and read by
 * disambiguation matching, not a paginated list a person scrolls, so a
 * hard cap matters even more here, not less.
 */
export const ASSISTANT_MAX_RECORDS = 200;

export type SummarizableLead = Pick<
  PipelineLead,
  | "id"
  | "contact_name"
  | "company"
  | "email"
  | "phone"
  | "deal_value"
  | "stage_id"
  | "source"
  | "next_step"
  | "status"
  | "closed_at"
  | "expected_close_date"
>;

export async function fetchVisibleLeads(supabase: SupabaseClient, customerId: string): Promise<SummarizableLead[]> {
  const leads = await getLeadsForCustomer(supabase, customerId);
  return leads.slice(0, ASSISTANT_MAX_RECORDS);
}

export type SummarizableTask = Pick<
  Task,
  "id" | "subject" | "description" | "priority" | "due_date" | "type" | "status" | "lead_id"
> & {
  /** The linked lead's own label ("Company — Contact"), resolved here
   *  so a chat reference like "the task for Priya Sharma" can match a
   *  task even though the task's own row has no name field of its
   *  own — matching against `subject` alone would miss this common
   *  phrasing. Bounded to this same bounded task set's own distinct
   *  lead ids (getLeadLabelsByIds' own established "never the whole
   *  Lead table" pattern), never a second unbounded query. */
  leadLabel: string;
};

/** getTasksForCustomer returns every RLS-visible column; narrowed here
 *  to what's actually handed to the model or shown to the user — the
 *  same "don't send more than what's needed" discipline the rest of
 *  this app's list queries already apply at the query layer. */
export async function fetchVisibleTasks(supabase: SupabaseClient, customerId: string): Promise<SummarizableTask[]> {
  const tasks = await getTasksForCustomer(supabase, customerId);
  const bounded = tasks.slice(0, ASSISTANT_MAX_RECORDS);
  const labels = await getLeadLabelsByIds(supabase, customerId, bounded.map((task) => task.lead_id));
  const labelById = new Map(labels.map((label) => [label.id, formatLeadLabel(label)]));

  return bounded.map((task) => ({
    id: task.id,
    subject: task.subject,
    description: task.description,
    priority: task.priority,
    due_date: task.due_date,
    type: task.type,
    status: task.status,
    lead_id: task.lead_id,
    leadLabel: labelById.get(task.lead_id) ?? "",
  }));
}

export type SummarizableContact = Pick<ContactListItem, "id" | "name" | "company" | "title" | "email" | "phone"> & {
  /** Same reasoning as SummarizableTask's own leadLabel — a contact
   *  reference like "the contact for the Northwind lead" needs to
   *  match on the linked lead's label, not just the contact's own
   *  name/company. */
  leadLabel: string;
  lead_id: string;
};

export async function fetchVisibleContacts(supabase: SupabaseClient, customerId: string): Promise<SummarizableContact[]> {
  const page = await getContactsPage(supabase, customerId, { search: "", page: 0, pageSize: ASSISTANT_MAX_RECORDS });
  const labels = await getLeadLabelsByIds(supabase, customerId, page.contacts.map((contact) => contact.lead_id));
  const labelById = new Map(labels.map((label) => [label.id, formatLeadLabel(label)]));

  return page.contacts.map((contact) => ({
    id: contact.id,
    name: contact.name,
    company: contact.company,
    title: contact.title,
    email: contact.email,
    phone: contact.phone,
    lead_id: contact.lead_id,
    leadLabel: labelById.get(contact.lead_id) ?? "",
  }));
}

// The three functions below each fetch ONE record fresh (never reused
// from the summarize fetch above) in exactly the shape
// EditLeadDialog/EditTaskDialog/EditContactDialog already require, so
// an edit always opens against the record's current, real values.

export async function fetchLeadForEdit(supabase: SupabaseClient, customerId: string, leadId: string): Promise<PipelineLead | null> {
  const leads = await getLeadsForCustomer(supabase, customerId);
  return leads.find((lead) => lead.id === leadId) ?? null;
}

export async function fetchTaskForEdit(
  supabase: SupabaseClient,
  customerId: string,
  taskId: string,
): Promise<{ task: Task; lockedLeadLabel: string } | null> {
  const tasks = await getTasksForCustomer(supabase, customerId);
  const task = tasks.find((row) => row.id === taskId);
  if (!task) return null;

  const labels = await getLeadLabelsByIds(supabase, customerId, [task.lead_id]);
  const matchedLabel = labels.find((label) => label.id === task.lead_id);
  const lockedLeadLabel = matchedLabel ? formatLeadLabel(matchedLabel) : "";
  return { task, lockedLeadLabel };
}

export async function fetchContactForEdit(
  supabase: SupabaseClient,
  customerId: string,
  contactId: string,
): Promise<{ contact: ContactListItem; lockedLeadLabel: string } | null> {
  // A single-page, unbounded-search fetch is enough here — the same
  // ASSISTANT_MAX_RECORDS cap search-less summarization already uses,
  // since resolve-reference.ts has already matched this exact id out
  // of that same authorized set before this is ever called.
  const page = await getContactsPage(supabase, customerId, { search: "", page: 0, pageSize: ASSISTANT_MAX_RECORDS });
  const contact = page.contacts.find((row) => row.id === contactId);
  if (!contact) return null;

  const labels = await getLeadLabelsByIds(supabase, customerId, [contact.lead_id]);
  const matchedLabel = labels.find((label) => label.id === contact.lead_id);
  const lockedLeadLabel = matchedLabel ? formatLeadLabel(matchedLabel) : "";
  return { contact, lockedLeadLabel };
}

/**
 * The real stage NAME for one lead — reuses the exact lookup Pipeline
 * and the stage color system already use (features/leads/lib/
 * stage-colors.ts's own callers): fetch this customer's real
 * customer_lead_stages rows (getLeadStagesForCustomer, the same RPC
 * every stage picker already calls) and read `.stage` off the matching
 * one. Never a second, separately-maintained name mapping.
 */
export async function fetchStageName(supabase: SupabaseClient, customerId: string, stageId: string): Promise<string | null> {
  const stages = await getLeadStagesForCustomer(supabase, customerId);
  return stages.find((stage) => stage.id === stageId)?.stage ?? null;
}

export type RelatedContact = Pick<ContactListItem, "id" | "name" | "company" | "title" | "email" | "phone">;
export type RelatedTask = Pick<Task, "id" | "subject" | "due_date" | "status" | "priority" | "type">;

/**
 * Every Contact and Task linked to one lead — through
 * getContactsForLead/getTasksForLead, the SAME RLS-respecting
 * `supabase` client every other fetch in this module already uses (see
 * this file's own header for why that's the mechanism this feature is
 * built on). Run in parallel: two independent, already-scoped queries,
 * neither depending on the other's result.
 */
export async function fetchRelatedRecordsForLead(
  supabase: SupabaseClient,
  customerId: string,
  leadId: string,
): Promise<{ contacts: RelatedContact[]; tasks: RelatedTask[] }> {
  const [contacts, tasks] = await Promise.all([
    getContactsForLead(supabase, customerId, leadId),
    getTasksForLead(supabase, customerId, leadId),
  ]);
  return { contacts, tasks };
}
