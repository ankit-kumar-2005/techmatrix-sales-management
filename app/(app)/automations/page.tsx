import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { ListPager } from "@/components/shared/list-pager";
import { ListSearch } from "@/components/shared/list-search";
import { Disclosure } from "@/components/shared/disclosure";
import { PlusIcon } from "@/features/sales-management/components/icons";
import { AutomationList } from "@/features/automations/components/automation-list";
import { GuidelinesPanel } from "@/features/automations/components/guidelines-panel";
import { RunHistory } from "@/features/automations/components/run-history";
import {
  getAutomationsPage,
  getQueueSummary,
  getRecentRuns,
} from "@/features/automations/lib/get-automations";
import { drainAutomationQueue } from "@/features/automations/lib/drain";

/**
 * Automations — the list, the two creation paths, the run history and
 * the learning panel.
 *
 * FILLS THE SIDEBAR SLOT THAT ALREADY EXISTED. "Automations" has been in
 * NAV_ITEMS since the shell was built, with no href, rendering as a
 * disabled "Soon" row — the same state Lead Capture and Forecast were in
 * before each was built. A top-level (app) route for the same reason.
 *
 * ADMIN-ONLY, and the non-admin branch is a readable card rather than a
 * redirect, matching /lead-capture and /settings/add-user exactly. RLS
 * is the real boundary: all four automation tables are
 * is_customer_admin() even for SELECT, because an automation defines
 * privileged unattended behaviour and its history can name records
 * across the whole reporting hierarchy.
 */
export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; runsPage?: string }>;
}) {
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
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Automations</h1>
        <span
          aria-hidden="true"
          className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
        />
        <p className="mt-1.5 text-sm text-neutral-500">
          Rules that run on their own when something happens, so routine follow-up does not depend on anyone
          remembering.
        </p>
      </div>
      {membership.role === "ADMIN" ? (
        <Link
          href="/automations/new"
          className="flex min-h-11 items-center gap-1.5 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md"
        >
          <PlusIcon className="h-4 w-4" />
          New automation
        </Link>
      ) : null}
    </div>
  );

  if (membership.role !== "ADMIN") {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="max-w-xl rounded-2xl bg-white p-6 text-sm text-neutral-600 shadow-sm ring-1 ring-black/5">
          Only an administrator can manage automations.
        </div>
      </div>
    );
  }

  const params = await searchParams;
  const page = Number.parseInt(params.page ?? "1", 10);
  const runsPage = Number.parseInt(params.runsPage ?? "1", 10);
  const search = params.q ?? "";

  const [list, runs, queue] = await Promise.all([
    getAutomationsPage(supabase, membership.customer.id, {
      page: Number.isFinite(page) ? page : 1,
      search,
    }),
    getRecentRuns(supabase, membership.customer.id, { page: Number.isFinite(runsPage) ? runsPage : 1 }),
    getQueueSummary(supabase, membership.customer.id),
  ]);

  // Resolved ONCE and threaded into every component that formats a
  // relative time, so every "18 minutes ago" on the page agrees and no
  // client clock can contradict the server render.
  //
  // new Date().getTime(), not Date.now(): the React Compiler's purity
  // rule rejects Date.now() in a component body. Same construction
  // LeadCapturePage and MeetingNotesPage already use.
  const nowMs = new Date().getTime();

  // AN ADMIN LOOKING AT THIS PAGE IS ITSELF A NUDGE TO THE WORKER.
  // The cron backstop can only run as often as the hosting plan allows
  // (see app/api/cron/automations/route.ts), so anything stuck retrying
  // gets another attempt whenever somebody comes to check on it —
  // which is exactly when they would want it to. after(), so the page
  // is already rendered and this can neither slow it nor fail it.
  if (queue.pending > 0) {
    after(() => drainAutomationQueue("an admin opened the automations page"));
  }

  return (
    <div className="flex flex-col gap-6">
      {header}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Your automations</h2>
          <div className="w-full sm:max-w-xs">
            <ListSearch
              initialSearch={search}
              basePath="/automations"
              label="Search automations"
              placeholder="Search by name or description..."
            />
          </div>
        </div>

        <AutomationList items={list.items} nowMs={nowMs} filtered={Boolean(search.trim())} />

        {list.pageCount > 1 ? (
          <ListPager
            page={list.page}
            pageCount={list.pageCount}
            totalCount={list.total}
            basePath="/automations"
            itemLabel="automation"
          />
        ) : null}
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
        <section className="flex flex-col gap-3">
          <RunHistory
            title="Execution history"
            runs={runs.items}
            nowMs={nowMs}
            queue={queue}
            devMode={process.env.NODE_ENV !== "production"}
          />
          {runs.pageCount > 1 ? (
            <ListPager
              page={runs.page}
              pageCount={runs.pageCount}
              totalCount={runs.total}
              basePath="/automations"
              itemLabel="run"
              paramName="runsPage"
            />
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">What automations can do</h2>
          {/* COLLAPSED BY DEFAULT — reference content someone checks
              occasionally ("what does Skipped mean"), not something a
              returning admin needs open every visit. The builder's own
              "Learn" tab already covers deeper education; this is a
              quick reminder, one click away, not a second destination. */}
          <Disclosure
            title="What automations can do"
            teaser={<p>New here? Learn how automations run and what each status means.</p>}
          >
            <GuidelinesPanel />
          </Disclosure>
        </section>
      </div>
    </div>
  );
}
