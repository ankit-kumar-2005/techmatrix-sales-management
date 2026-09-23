import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getLeadStagesForCustomer } from "@/features/leads/lib/get-lead-stages";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { getLeadCaptureOverview } from "@/features/integrations/lib/get-lead-capture-overview";
import { ensureComingSoonIntegrationExists } from "@/features/integrations/lib/ensure-coming-soon-integration";
import { getSourceMetadata } from "@/features/integrations/lib/providers/source-metadata";
import { SourceCard } from "@/features/integrations/components/source-card";
import { ComingSoonSourceCard } from "@/features/integrations/components/coming-soon-source-card";
import { COMING_SOON_SOURCES } from "@/features/integrations/lib/providers/coming-soon-sources";
import { CaptureSettingsForm } from "@/features/integrations/components/capture-settings-form";
import { RecentlyCaptured } from "@/features/integrations/components/recently-captured";
import { getAppUrl } from "@/lib/app-url";
import type { IntegrationSource } from "@/types/integration";

/** The only source this page renders today — same "one literal, used
 *  everywhere by reference" pattern actions.ts uses (see CURRENT_SOURCE
 *  there). Every display string below reads through
 *  getSourceMetadata(SOURCE) rather than repeating "IndiaMART" as an
 *  independent string literal. */
const SOURCE: IntegrationSource = "IndiaMART";

/**
 * Lead Capture — inbound lead sources.
 *
 * FILLS THE SIDEBAR SLOT THAT ALREADY EXISTED. "Lead Capture" has been
 * in NAV_ITEMS since the shell was built, with no href, rendering as a
 * disabled "Soon" row. This is a top-level (app) route rather than
 * /settings/lead-capture for that reason — same path Forecast took out
 * of the same state.
 *
 * ADMIN-ONLY, and the non-admin branch is a readable card rather than a
 * redirect, matching /settings/add-user exactly. RLS is the real
 * boundary: customer_integrations is is_customer_admin() even for
 * SELECT, because the row holds a bearer token (see the migration's
 * design note 3). The nav item is NOT hidden for non-admins — doing
 * that would mean threading `role` through AppShell into Sidebar, which
 * is a wider change than this feature should make, and every other
 * admin-only page in this app is visible-but-refused too.
 */
export default async function LeadCapturePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const header = (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Lead capture</h1>
      <span
        aria-hidden="true"
        className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
      />
      <p className="mt-1.5 text-sm text-neutral-500">
        Connect lead sources so new enquiries flow into the pipeline automatically, already staged and assigned.
      </p>
    </div>
  );

  if (membership.role !== "ADMIN") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="max-w-xl rounded-2xl bg-white p-6 text-sm text-neutral-600 shadow-sm ring-1 ring-black/5">
          Only an administrator can configure lead capture.
        </div>
      </div>
    );
  }

  // PROVISION THE THREE "SOON" ROWS FIRST, before anything reads them —
  // idempotent (see ensureComingSoonIntegrationExists's own note: a
  // duplicate insert is a harmless no-op), so this is safe to run on
  // every single page load, not just the first. This is what makes the
  // webhook URL each "Soon" card shows genuinely real rather than
  // illustrative: the row exists, with a real stored token, the moment
  // any admin ever sees the card — there is no separate "Connect" click
  // for these three, because there is no decision to make, only
  // something to have ready ahead of the adapter that will eventually
  // read it.
  await Promise.all(
    COMING_SOON_SOURCES.map((source) => ensureComingSoonIntegrationExists(supabase, membership.customer.id, source.source)),
  );

  const [overview, stages, owners, ...comingSoonOverviews] = await Promise.all([
    getLeadCaptureOverview(supabase, membership.customer.id, SOURCE),
    getLeadStagesForCustomer(supabase, membership.customer.id),
    getVisibleTeamDirectory(supabase),
    ...COMING_SOON_SOURCES.map((source) => getLeadCaptureOverview(supabase, membership.customer.id, source.source)),
  ]);

  const { integration } = overview;
  const metadata = getSourceMetadata(SOURCE);

  // Resolved ONCE and threaded into every component that formats a
  // relative time, so every "18 minutes ago" on the page agrees and no
  // client clock can contradict the server render.
  //
  // new Date().getTime(), not Date.now(): the React Compiler's purity
  // rule rejects Date.now() in a component body. Same construction
  // MeetingNotesPage already uses for its own server-resolved date.
  const nowMs = new Date().getTime();

  // Built from APP_URL, not from the request's own host: this is the URL
  // pasted into a third party's dashboard, so it has to be the stable
  // public origin. lib/app-url.ts carries the full reasoning (it is the
  // same resolution the invitation emails use, and the same
  // misconfiguration risk).
  const appOrigin = getAppUrl();

  // The :source segment is integration.source ITSELF — the exact string
  // stored on the row, e.g. "IndiaMART" — not a separate URL slug. Every
  // layer (this URL, the webhook route's registry lookup, the source
  // column, ingest_lead()'s p_source check) uses that one identical
  // string, so there is no slug-to-source mapping anywhere to fall out
  // of sync. This is copy-only — an admin never hand-types it — so the
  // mixed-case segment costs nothing in practice.
  const webhookUrl = integration
    ? `${appOrigin}/api/webhooks/leads/${integration.source}/${integration.webhook_token}`
    : null;

  // Paired back up with their own metadata, and defensively dropped
  // (rather than crashing the page) on the one-in-never case the
  // provisioning insert above failed for a reason other than "already
  // exists" — see ensureComingSoonIntegrationExists's own error log for
  // that case.
  const comingSoonCards = COMING_SOON_SOURCES.map((source, index) => ({
    source,
    integration: comingSoonOverviews[index].integration,
  })).filter(
    (entry): entry is typeof entry & { integration: NonNullable<(typeof entry)["integration"]> } =>
      entry.integration !== null,
  );

  return (
    <div className="flex flex-col gap-6">
      {header}

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Connected sources</h2>
        {/* A 2-UP GRID — horizontal rather than one long stacked column,
            while keeping each card wide enough that its connection panel
            (masked URL, Copy, Test, Setup guide, Regenerate) stays just
            as readable as it was at full width; a 4-across grid made
            that panel uncomfortably cramped. Each card still expands IN
            PLACE inside its own boundary. `items-start` is the reason
            this doesn't break when one card is taller than its
            row-mate: without it, CSS Grid's default is to STRETCH every
            cell in a row to match the tallest one, which would inflate
            the shorter card's own box into a tall, mostly-empty shell.
            With items-start, each card keeps its own natural height — a
            shorter neighbor just leaves quiet space beside it, never a
            stretched or misshapen card — and nothing ever changes
            position: a taller card only pushes the *next grid row* down,
            exactly like a paragraph pushing the next one down the
            page. */}
        <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
          <SourceCard
            name={metadata.displayName}
            description={metadata.description}
            mark={metadata.initials}
            connected={Boolean(integration)}
            paused={integration?.status === "Inactive"}
            todayCount={overview.todayCount}
            weekCount={overview.weekCount}
            lastReceivedAt={overview.lastReceivedAt}
            nowMs={nowMs}
            integrationId={integration?.id ?? null}
            webhookUrl={webhookUrl}
          />
          {/* Three "Soon" cards — JustDial, Website, Meta. Each one now
              has a REAL customer_integrations row and a real webhook
              token (provisioned above) — a real URL exists for each,
              even though no adapter or registry entry exists for any
              of them; see coming-soon-sources.ts's own header for why
              that's what stays deliberately kept out of the real
              IntegrationSource type. */}
          {comingSoonCards.map(({ source, integration: comingSoonIntegration }) => (
            <ComingSoonSourceCard
              key={source.source}
              source={source}
              integrationId={comingSoonIntegration.id}
              webhookUrl={`${appOrigin}/api/webhooks/leads/${comingSoonIntegration.source}/${comingSoonIntegration.webhook_token}`}
            />
          ))}
        </div>
      </section>

      {/* THE SEPARATE "CONNECTION" SECTION IS GONE — it used to be the
          one and only place IndiaMART's webhook panel rendered,
          disconnected from the card that triggered it (there was only
          ever one card to trigger it from). Every source's own
          connection details now live inside its own card above.
          "Capture rules" is unrelated to any single card — it is a
          page-level setting (which pipeline stage/owner a captured
          lead lands on) — so it keeps its own section, gated on
          `integration` existing exactly as before. */}
      {integration ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Capture rules</h2>
          <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-6">
            <CaptureSettingsForm
              integrationId={integration.id}
              stages={stages}
              assignableUsers={owners}
              defaultStageId={integration.default_stage_id}
              assignmentMode={integration.assignment_mode}
              defaultOwnerId={integration.default_owner_id}
              participantIds={overview.participantIds}
            />
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Recently captured</h2>
        <RecentlyCaptured leads={overview.recent} owners={owners} source={SOURCE} nowMs={nowMs} />
      </section>
    </div>
  );
}
