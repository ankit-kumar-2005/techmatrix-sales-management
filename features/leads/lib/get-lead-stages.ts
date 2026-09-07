import type { SupabaseClient } from "@supabase/supabase-js";
import type { CustomerLeadStage } from "@/types/lead";

/**
 * Server-side only: every stage (active and inactive) belonging to one
 * customer, ordered by display_order — the single source of truth for
 * stage order everywhere it's consumed (Create Lead dropdown, Pipeline
 * stage filter, Leads by Stage, Pipeline Board columns, and the stage
 * configuration UI itself). RLS ("customer members can view their
 * customer's lead stages") is still the enforcing layer; this just adds
 * the ordering every consumer wants.
 *
 * Deliberately returns inactive stages too (not just Active ones) — List/
 * Board/badges must still resolve a lead sitting in a stage that's since
 * been deactivated. Callers that only want selectable stages (the Create
 * Lead dropdown, the stage filter) filter to status === "Active"
 * themselves.
 */
export async function getLeadStagesForCustomer(
  supabase: SupabaseClient,
  customerId: string,
): Promise<CustomerLeadStage[]> {
  const { data, error } = await supabase
    .from("customer_lead_stages")
    .select("*")
    .eq("customer_id", customerId)
    .order("display_order", { ascending: true });

  if (error || !data) {
    return [];
  }

  return data as CustomerLeadStage[];
}
