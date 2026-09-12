import type { SupabaseClient } from "@supabase/supabase-js";

/** Just enough of a Lead to render "Company — Contact Name" wherever a
 *  row badge, a detail view, or a locked edit-mode field needs to show
 *  which Lead something is linked to — never the full 17-column Lead
 *  row for a purpose that only ever displays two of them. */
export type LeadLabel = {
  id: string;
  contact_name: string;
  company: string | null;
};

/** The one formatting rule for "how a Lead is displayed as a label" —
 *  previously duplicated verbatim in LeadSearchSelect, ContactList,
 *  EditContactDialog, EditTaskDialog, and TaskRow/TaskDetailModal. Takes
 *  a `Pick<LeadLabel, ...>` rather than `LeadLabel` itself so a full
 *  `Lead` (Pipeline's own richer type) satisfies it too without a cast. */
export function formatLeadLabel(lead: Pick<LeadLabel, "contact_name" | "company">): string {
  return lead.company ? `${lead.company} — ${lead.contact_name}` : lead.contact_name;
}

/**
 * Server-side only: resolves a BOUNDED set of Leads by id, projected down
 * to just the columns a label needs. Built for exactly one shape of
 * caller — "I already have a page of contacts/tasks (or one contact/task
 * being edited) and need to label the handful of Leads they reference" —
 * never a substitute for getLeadsForCustomer's own full-table fetch.
 *
 * `.eq("customer_id", customerId)` alongside `.in("id", ...)` is belt-
 * and-suspenders the same way getDuplicateCandidates's own explicit scope
 * is: RLS ("hierarchy-aware lead visibility") is still the real boundary
 * regardless — a foreign customer's id (or one outside the caller's own
 * visible hierarchy) simply won't be in the result, the same as any other
 * query in this app.
 */
export async function getLeadLabelsByIds(
  supabase: SupabaseClient,
  customerId: string,
  leadIds: string[],
): Promise<LeadLabel[]> {
  const uniqueIds = Array.from(new Set(leadIds));
  if (uniqueIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("leads")
    .select("id, contact_name, company")
    .eq("customer_id", customerId)
    .in("id", uniqueIds);

  if (error || !data) {
    return [];
  }

  return data as LeadLabel[];
}
