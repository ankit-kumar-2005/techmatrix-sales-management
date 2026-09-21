import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lead } from "@/types/lead";

/**
 * Exactly what the Pipeline page (app/(app)/sales-management/page.tsx),
 * PipelineView, and everything it renders (List view's 7 sortable
 * columns, the Kanban board's cards/columns/drag-and-drop, "Leads by
 * stage", the KPI math, and EditLeadDialog's form defaults) actually
 * read off a fetched Lead — traced against every real consumer of
 * getLeadsForCustomer's return value (Phase 3b), not guessed. Nothing
 * in that whole chain reads `customer_id` (it's only ever used server-
 * side, as the query's own `.eq()` filter — never needs to be selected
 * for that) or `created_at` (Pipeline sorts/displays `updated_at`
 * only), so both are dropped. A Pick<Lead, ...> rather than a
 * hand-written duplicate shape, so this can never silently drift from
 * the real `leads` table columns — same convention as ContactListItem/
 * TaskListItem/CatalogItemListItem from Phase 3.
 */
export type PipelineLead = Pick<
  Lead,
  | "id"
  | "company"
  | "contact_name"
  | "email"
  | "phone"
  | "whatsapp_phone"
  | "address"
  | "deal_value"
  | "stage_id"
  | "owner_id"
  | "source"
  | "next_step"
  | "status"
  | "closed_at"
  | "expected_close_date"
  | "updated_at"
>;

/**
 * Server-side only: every lead belonging to one customer, most recently
 * updated first. RLS ("hierarchy-aware lead visibility" — ADMIN sees
 * the whole customer, everyone else self + recursive manager_id
 * descendants) is still the enforcing layer — this just adds the
 * ordering the Pipeline page wants and the column projection above.
 */
export async function getLeadsForCustomer(supabase: SupabaseClient, customerId: string): Promise<PipelineLead[]> {
  const { data, error } = await supabase
    .from("leads")
    .select(
      "id, company, contact_name, email, phone, whatsapp_phone, address, deal_value, stage_id, owner_id, source, next_step, status, closed_at, expected_close_date, updated_at",
    )
    .eq("customer_id", customerId)
    .order("updated_at", { ascending: false });

  if (error || !data) {
    return [];
  }

  return data as PipelineLead[];
}
