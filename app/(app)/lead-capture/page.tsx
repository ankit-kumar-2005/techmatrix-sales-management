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
import { SourceCard } from "@/features/integrations/components/source-card";
import { ConnectIndiamartButton } from "@/features/integrations/components/connect-indiamart-button";
import { WebhookUrlPanel } from "@/features/integrations/components/webhook-url-panel";
import { CaptureSettingsForm } from "@/features/integrations/components/capture-settings-form";
import { RecentlyCaptured } from "@/features/integrations/components/recently-captured";
import { getAppUrl } from "@/lib/app-url";

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

  const [overview, stages, owners] = await Promise.all([
    getLeadCaptureOverview(supabase, membership.customer.id, "IndiaMART"),
    getLeadStagesForCustomer(supabase, membership.customer.id),
    getVisibleTeamDirectory(supabase),
  ]);

  const { integration } = overview;

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
  const webhookUrl = integration
    ? `${getAppUrl()}/api/webhooks/leads/indiamart/${integration.webhook_token}`
    : null;

  return (
    <div className="flex flex-col gap-6">
      {header}

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Connected sources</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <SourceCard
            name="IndiaMART"
            description="Buyer enquiries pushed from your IndiaMART seller account."
            mark="IM"
            connected={Boolean(integration)}
            paused={integration?.status === "Inactive"}
            todayCount={overview.todayCount}
            weekCount={overview.weekCount}
            lastReceivedAt={overview.lastReceivedAt}
            nowMs={nowMs}
          />
        </div>
      </section>

      {integration && webhookUrl ? (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Connection</h2>
            <div className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-6">
              <WebhookUrlPanel integrationId={integration.id} webhookUrl={webhookUrl} />
            </div>
          </section>

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
        </>
      ) : (
        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Connection</h2>
          <div className="max-w-2xl rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
            <p className="text-sm font-semibold text-neutral-900">IndiaMART isn&rsquo;t connected yet</p>
            <p className="mt-1.5 text-sm leading-relaxed text-neutral-500">
              Connecting generates a private webhook URL to paste into IndiaMART&rsquo;s Push API page. Enquiries
              then arrive as leads automatically — no manual import, and nothing to sync.
            </p>
            <div className="mt-5">
              <ConnectIndiamartButton />
            </div>
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Recently captured</h2>
        <RecentlyCaptured leads={overview.recent} owners={owners} sourceName="IndiaMART" nowMs={nowMs} />
      </section>
    </div>
  );
}
