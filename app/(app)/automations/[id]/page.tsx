import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { AutomationBuilder } from "@/features/automations/components/automation-builder";
import { RunHistory } from "@/features/automations/components/run-history";
import {
  getAutomationDetail,
  getEditableDefinition,
  getRecentRuns,
} from "@/features/automations/lib/get-automations";

/**
 * One automation — the builder, plus its own run history.
 *
 * The id in the URL is NOT trusted as an authorisation claim.
 * getAutomationDetail scopes its query by the customer_id resolved from
 * this session, and RLS refuses the row regardless, so another tenant's
 * id produces the same not-found as a made-up one.
 */
export default async function AutomationDetailPage({ params }: { params: Promise<{ id: string }> }) {
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

  const { id } = await params;

  if (membership.role !== "ADMIN") {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Automation</h1>
        <div className="max-w-xl rounded-2xl bg-white p-6 text-sm text-neutral-600 shadow-sm ring-1 ring-black/5">
          Only an administrator can manage automations.
        </div>
      </div>
    );
  }

  const detail = await getAutomationDetail(supabase, membership.customer.id, id);
  if (!detail) {
    notFound();
  }

  const [team, runs] = await Promise.all([
    getVisibleTeamDirectory(supabase),
    getRecentRuns(supabase, membership.customer.id, { automationId: id }),
  ]);

  const activeVersion =
    detail.versions.find((version) => version.id === detail.active_version_id)?.version ?? null;

  const nowMs = new Date().getTime();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/automations"
          className="text-xs font-semibold text-sky-600 underline-offset-2 transition-colors hover:underline"
        >
          &larr; All automations
        </Link>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">{detail.name}</h1>
        <span
          aria-hidden="true"
          className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
        />
      </div>

      <AutomationBuilder
        automationId={detail.id}
        initialName={detail.name}
        initialDescription={detail.description ?? ""}
        // The NEWEST version, not the active one — see
        // getEditableDefinition for why those are different questions.
        initialDefinition={getEditableDefinition(detail)}
        status={detail.status}
        origin={detail.origin}
        activeVersion={activeVersion}
        latestVersion={detail.versions[0]?.version ?? 0}
        team={team}
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">This automation&rsquo;s runs</h2>
        <RunHistory runs={runs} nowMs={nowMs} showAutomationName={false} />
      </section>
    </div>
  );
}
