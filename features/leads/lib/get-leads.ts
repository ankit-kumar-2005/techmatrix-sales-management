import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lead } from "@/types/lead";

/**
 * Server-side only: every lead belonging to one customer, most recently
 * updated first. RLS ("customer members can view their customer's
 * leads") is still the enforcing layer — this just adds the ordering
 * the Pipeline page wants.
 */
export async function getLeadsForCustomer(supabase: SupabaseClient, customerId: string): Promise<Lead[]> {
  const { data, error } = await supabase
    .from("leads")
    .select("*")
    .eq("customer_id", customerId)
    .order("updated_at", { ascending: false });

  if (error || !data) {
    return [];
  }

  return data as Lead[];
}
