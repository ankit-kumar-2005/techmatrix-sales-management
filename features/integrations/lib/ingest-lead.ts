import { createWebhookClient } from "@/lib/supabase/webhook";
import type { NormalizedLead } from "./providers/provider.interface";

/**
 * The universal outcome of a lead-ingest attempt, for ANY source — not
 * an IndiaMART concept. The webhook controller maps every one of these
 * to an HTTP response the same way regardless of which source produced
 * it; see the route handler's own comment for the full status → HTTP
 * mapping and the 48-hour-deactivation reasoning behind it.
 */
export type IngestResult = "created" | "duplicate" | "unknown_token" | "no_active_stage" | "bad_payload" | "error";

/**
 * Calls the generic ingest_lead() RPC with an already-normalized lead.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE ROUTE HANDLER: the same
 * reasoning the old ingest-indiamart-lead.ts gave for its own
 * existence still holds after the split — CLAUDE.md Section I wants a
 * Route Handler thin and delegating, and this repo's actual convention
 * for that (services/ does not exist here) is a `features/<feature>/
 * lib/*` module. This one is source-agnostic: it takes `source` and a
 * NormalizedLead, never a vendor's own field names — those were already
 * resolved by that source's adapter before this function is ever
 * called (features/integrations/lib/providers/).
 */
export async function ingestLead(token: string, source: string, lead: NormalizedLead): Promise<IngestResult> {
  const supabase = createWebhookClient();

  const { data, error } = await supabase.rpc("ingest_lead", {
    p_token: token,
    p_source: source,
    p_external_id: lead.external_id,
    p_contact_name: lead.contact_name,
    p_company: lead.company,
    p_email: lead.email,
    p_phone: lead.phone,
    p_address: lead.address,
    p_notes: lead.notes,
  });

  if (error) {
    // Code only. The lead carries a real person's name, phone and
    // email, and the token is a bearer secret — neither belongs in a
    // log line (CLAUDE.md Section P).
    console.error(`[lead-capture:${source}] ingest failed (code: ${error.code ?? "unknown"}).`);
    return "error";
  }

  const result = (data as IngestResult | null) ?? "error";

  // EVERY NON-SUCCESS OUTCOME LEAVES A TRACE.
  //
  // The two 200-returning rejections below are the dangerous ones
  // precisely because they are 200s: nothing upstream will ever
  // complain about them, the source will not retry them, and there is
  // no UI for them yet. Unlogged, a tenant's feed could be silently
  // dropping every push with nobody able to say why. `created` and
  // `duplicate` are deliberately NOT logged — they are the normal
  // traffic of a working integration, and one line per lead would bury
  // the lines that matter.
  if (result === "no_active_stage") {
    // NOTE: this cannot name the tenant. Resolving customer_id is the
    // RPC's job and it returns only a status string — see the route
    // handler's own comment on why that trade is worth keeping.
    console.error(
      `[lead-capture:${source}] REJECTED no_active_stage — a push resolved to a real, active integration, ` +
        "but that customer has no Active lead stage, and leads.stage_id is NOT NULL. " +
        "Reactivate a stage in Pipeline settings; pushes are being dropped until then.",
    );
  }

  if (result === "unknown_token") {
    // The single most likely real-world failure: the URL was
    // regenerated and nobody pasted the new one into the source's own
    // dashboard — or a token for one source was pasted into a
    // DIFFERENT source's URL slot (the migration's design note 10).
    // Worth a log line even though the endpoint answers 404, because
    // the 404 goes to the source and nobody here ever sees it. The
    // token itself is a bearer secret and is not logged, not even
    // truncated.
    console.error(
      `[lead-capture:${source}] REJECTED unknown_token — a push arrived for a token that is unknown, ` +
        "belongs to a different source, or belongs to a paused integration. " +
        "If the webhook URL was recently regenerated, the new URL has not been installed at the source yet.",
    );
  }

  return result;
}
