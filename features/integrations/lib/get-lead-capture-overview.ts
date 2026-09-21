import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CapturedLead,
  CustomerIntegration,
  IntegrationSource,
  LeadCaptureOverview,
} from "@/types/integration";

/** How many rows the "Recently Captured" feed shows. */
const RECENT_LIMIT = 8;

/**
 * Server-side only: everything the Lead Capture page needs for one
 * source, in four bounded queries.
 *
 * RLS IS THE SCOPING. customer_integrations and
 * customer_integration_participants are admin-only for SELECT (see the
 * migration's design note 3), so a non-admin gets nothing back here
 * even if they somehow reached this function — the page's own role
 * check is the readable error, not the boundary. The .eq("customer_id")
 * calls are belt and braces plus an index hint.
 *
 * COUNTS ARE SQL AGGREGATION, NOT FETCH-AND-COUNT. Both use
 * `head: true` with `count: "exact"`, so Postgres returns a number and
 * zero rows — the today/this-week figures never pull lead rows into
 * this process. Fetching every lead to length-check the array is the
 * unbounded-fetch mistake this project has already paid for once on
 * Pipeline.
 */
export async function getLeadCaptureOverview(
  supabase: SupabaseClient,
  customerId: string,
  source: IntegrationSource,
): Promise<LeadCaptureOverview> {
  const { data: integrationRow, error: integrationError } = await supabase
    .from("customer_integrations")
    .select(
      "id, customer_id, source, webhook_token, status, default_stage_id, assignment_mode, default_owner_id, last_assigned_owner_id, created_at, updated_at",
    )
    .eq("customer_id", customerId)
    .eq("source", source)
    .maybeSingle();

  if (integrationError) {
    console.error(`[lead-capture] could not load integration (code: ${integrationError.code}).`);
  }

  const integration = (integrationRow as CustomerIntegration | null) ?? null;

  // Counts and the feed are about LEADS, so they are worth showing even
  // before an integration row exists — a tenant that connected, got
  // leads, then deactivated the source should still see its history.
  const [todayCount, weekCount, recentResult, participantIds] = await Promise.all([
    countLeadsSince(supabase, customerId, source, startOfTodayIso()),
    countLeadsSince(supabase, customerId, source, startOfWeekIso()),
    supabase
      .from("leads")
      .select("id, company, contact_name, owner_id, created_at")
      .eq("customer_id", customerId)
      .eq("source", source)
      .order("created_at", { ascending: false })
      .limit(RECENT_LIMIT),
    integration ? getParticipantIds(supabase, integration.id) : Promise.resolve([]),
  ]);

  if (recentResult.error) {
    console.error(`[lead-capture] could not load recent leads (code: ${recentResult.error.code}).`);
  }

  const recent = (recentResult.data ?? []) as CapturedLead[];

  return {
    integration,
    participantIds,
    todayCount,
    weekCount,
    // The newest lead IS the first row of the feed — no separate query
    // for "last received", because the ordered feed already answers it.
    lastReceivedAt: recent[0]?.created_at ?? null,
    recent,
  };
}

/**
 * Participant ids in ROTATION ORDER — (created_at, id), matching
 * exactly what ingest_lead() rotates through for every source. The UI
 * lists them numbered in this order, so if these two ever disagreed the
 * numbering would be a lie.
 */
async function getParticipantIds(supabase: SupabaseClient, integrationId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("customer_integration_participants")
    .select("customer_user_id, created_at, id")
    .eq("integration_id", integrationId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true });

  if (error || !data) {
    if (error) console.error(`[lead-capture] could not load participants (code: ${error.code}).`);
    return [];
  }

  return (data as { customer_user_id: string }[]).map((row) => row.customer_user_id);
}

async function countLeadsSince(
  supabase: SupabaseClient,
  customerId: string,
  source: IntegrationSource,
  sinceIso: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", customerId)
    .eq("source", source)
    .gte("created_at", sinceIso);

  if (error) {
    console.error(`[lead-capture] could not count leads (code: ${error.code}).`);
    return 0;
  }
  return count ?? 0;
}

/**
 * BOUNDARIES ARE UTC, and that is a deliberate, known limitation.
 *
 * created_at is timestamptz, and "today" for a seller in IST is not
 * "today" in UTC — between 00:00 and 05:30 IST the UTC day has not
 * turned over yet, so a lead that arrived "this morning" can still be
 * counted under yesterday. The app has no per-customer timezone column
 * to do better with, and inventing one for two counters is a bigger
 * decision than this feature should make on its own. Same call, for
 * the same reason, as the Forecast month buckets.
 */
function startOfTodayIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

/** Rolling seven days, not "since Monday" — "this week" on a dashboard
 *  that a seller checks daily is more useful as a trailing window than
 *  as a figure that collapses to near-zero every Monday morning. */
function startOfWeekIso(): string {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - 6);
  return start.toISOString();
}
