import type { SupabaseClient } from "@supabase/supabase-js";
import type { ComingSoonSource } from "./providers/coming-soon-sources";

/**
 * Creates a real `customer_integrations` row for a "Soon" source if
 * this tenant doesn't already have one — idempotent, safe to call on
 * every Lead Capture page load.
 *
 * THE EXACT SAME INSERT connectIndiamartAction ALREADY DOES (see
 * features/integrations/actions.ts) — same table, same two columns
 * (`customer_id`, `source`), same reliance on the column's own SQL
 * DEFAULT to generate `webhook_token` (never computed in application
 * code), same `(customer_id, source)` uniqueness making a duplicate
 * insert a harmless no-op (23505, swallowed exactly like
 * connectIndiamartAction already swallows it). Only the source string
 * varies, and it is typed against the closed `ComingSoonSource` union
 * — never an arbitrary caller-supplied string — so this can never be
 * used to create a row for a source name nobody asked for.
 *
 * WHY THIS RUNS ON PAGE LOAD, NOT BEHIND A "CONNECT" BUTTON: unlike a
 * real source, there is no decision for an admin to make here — the
 * row's only purpose is to hold a real, stable webhook URL/token ahead
 * of the adapter that will eventually read it, so there is nothing to
 * "connect" yet, only something to have ready. Automating the one
 * insert this button would otherwise perform is the smaller, safer
 * change than adding a second connect button whose only purpose is
 * clicking itself once.
 */
export async function ensureComingSoonIntegrationExists(
  supabase: SupabaseClient,
  customerId: string,
  source: ComingSoonSource,
): Promise<void> {
  const { error } = await supabase.from("customer_integrations").insert({
    customer_id: customerId,
    source,
  });

  if (error && error.code !== "23505") {
    console.error(`[lead-capture] could not provision the "${source}" placeholder row (code: ${error.code}).`);
  }
}
