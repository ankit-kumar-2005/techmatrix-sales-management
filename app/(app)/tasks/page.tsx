import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getTasksBucketPage, type TaskDueBucket, type TasksBucketPage } from "@/features/tasks/lib/get-tasks";
import { getLeadsForCustomer } from "@/features/leads/lib/get-leads";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { TaskList } from "@/features/tasks/components/task-list";
import { TasksIcon } from "@/features/sales-management/components/icons";
import { TASK_TYPES, TASK_STATUSES } from "@/types/task";

const INITIAL_PAGE_SIZE = 10;
const ALL_BUCKETS: TaskDueBucket[] = ["overdue", "today", "upcoming"];
const DUE_BUCKET_VALUES: TaskDueBucket[] = ["today", "overdue", "upcoming"];

function toDateOnlyString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// A raw searchParams value is untrusted input — only accepted back if it's
// actually one of the fixed values the filter itself offers; anything else
// (a stale/hand-edited URL) quietly falls back to "no filter" rather than
// being passed through to the query.
function parseEnumParam<T extends string>(value: string | undefined, allowed: readonly T[]): T | "" {
  return value && (allowed as readonly string[]).includes(value) ? (value as T) : "";
}

type TasksPageProps = {
  searchParams: Promise<{ q?: string; owner?: string; type?: string; status?: string; due?: string }>;
};

/**
 * Auth + customer membership are already guarded by
 * app/(app)/layout.tsx before this page ever renders (see
 * SalesManagementPage's own identical note) — this page only fetches
 * what it needs to display.
 *
 * Status (All/Pending/Completed) and Due Date (All/Today/Overdue/
 * Upcoming) are two INDEPENDENT filter dimensions — see get-tasks.ts's
 * own comment. "Due Date = All" means all three buckets render side by
 * side (the default); a specific due-date value means exactly one bucket
 * renders. This page fetches page 1 of only whichever bucket(s) will
 * actually be visible, already filtered by whatever search/owner/type/
 * status/due the URL's own searchParams carry — a real, parallel
 * .range()/.count() query per visible bucket, the same query shape
 * getTasksBucketPageAction uses for every later client-driven page/
 * filter change. This is also what makes a hard refresh (or a shared/
 * bookmarked link) land on the exact same filtered view instead of
 * resetting to "All": the filter values live in the URL, not only in
 * TaskList's client state. TaskList seeds its own filter state from
 * these same initial values so the toolbar reflects the URL on first
 * paint, then keeps the URL in sync as the user changes filters from
 * there (see its own comment).
 *
 * "today" is computed here from THIS SERVER's clock, only for the very
 * first render — TaskList recomputes it from the BROWSER's own clock for
 * every subsequent client-driven fetch (see its own comment), so a
 * server/browser timezone mismatch can only ever affect the very first
 * paint, self-correcting the moment the client takes over.
 */
export default async function TasksPage({ searchParams }: TasksPageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  const params = await searchParams;
  const initialSearch = params.q ?? "";
  const initialOwnerId = params.owner ?? "";
  const initialType = parseEnumParam(params.type, TASK_TYPES);
  const initialStatus = parseEnumParam(params.status, TASK_STATUSES);
  const initialDueBucket = parseEnumParam(params.due, DUE_BUCKET_VALUES);
  const hasInitialFilters = Boolean(
    initialSearch || initialOwnerId || initialType || initialStatus || initialDueBucket,
  );

  const todayStr = toDateOnlyString(new Date());
  const baseParams = {
    todayStr,
    search: initialSearch,
    ownerId: initialOwnerId,
    type: initialType,
    status: initialStatus,
    page: 0,
    pageSize: INITIAL_PAGE_SIZE,
  };

  const bucketsToFetch = initialDueBucket ? [initialDueBucket] : ALL_BUCKETS;

  const [bucketResults, leads, assignableUsers] = await Promise.all([
    Promise.all(
      bucketsToFetch.map((bucket) => getTasksBucketPage(supabase, membership.customer.id, { ...baseParams, bucket })),
    ),
    getLeadsForCustomer(supabase, membership.customer.id),
    getVisibleTeamDirectory(supabase),
  ]);

  const initialBuckets: Partial<Record<TaskDueBucket, TasksBucketPage>> = {};
  bucketsToFetch.forEach((bucket, index) => {
    initialBuckets[bucket] = bucketResults[index];
  });

  // With an active filter, a zero total means "nothing matches the
  // filter" (TaskList's own toolbar + reset button is the right UI for
  // that), not "this customer has no tasks at all" — only the unfiltered
  // case falls through to the page-level empty state below.
  const totalAcrossBuckets = bucketResults.reduce((sum, result) => sum + result.totalCount, 0);
  const hasAnyTasksAtAll = totalAcrossBuckets > 0 || hasInitialFilters;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Tasks &amp; reminders</h1>
        <span
          aria-hidden="true"
          className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
        />
        <p className="mt-1.5 text-sm text-neutral-500">
          Everything due across your leads, grouped by when it&rsquo;s due.
        </p>
      </div>

      {!hasAnyTasksAtAll ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-white py-14 text-center shadow-sm ring-1 ring-black/5">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-50 text-sky-600">
            <TasksIcon className="h-6 w-6" />
          </span>
          <div>
            <p className="text-sm font-semibold text-neutral-700">No tasks yet</p>
            <p className="mt-1 max-w-xs text-sm text-neutral-500">
              Create a task to stay on top of your lead follow-ups.
            </p>
          </div>
        </div>
      ) : (
        <TaskList
          initialBuckets={initialBuckets}
          initialTodayStr={todayStr}
          initialSearch={initialSearch}
          initialOwnerId={initialOwnerId}
          initialType={initialType}
          initialStatus={initialStatus}
          initialDueBucket={initialDueBucket}
          leads={leads}
          assignableUsers={assignableUsers}
          currentUserCustomerUserId={membership.membership.id}
        />
      )}
    </div>
  );
}
