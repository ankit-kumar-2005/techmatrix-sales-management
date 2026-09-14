import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getTasksBucketPage, type TaskDueBucket, type TasksBucketPage } from "@/features/tasks/lib/get-tasks";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { TasksPageClient } from "@/features/tasks/components/tasks-page-client";
import { TASK_TYPES, TASK_STATUSES, TASK_PRIORITIES } from "@/types/task";

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
  searchParams: Promise<{
    q?: string;
    owner?: string;
    type?: string;
    priority?: string;
    status?: string;
    due?: string;
  }>;
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
 *
 * There is no separate Lead filter/picker any more — the single search
 * box already matches a task's own subject and its linked Lead's own
 * name/company at once (see getTasksBucketPage's own comment), so this
 * page never needed to fetch the customer's whole Lead list up front
 * for one either way. Each bucket's own getTasksBucketPage result still
 * carries `leadLabels` bounded to just that bucket page's tasks,
 * unaffected by the search change.
 */
export default async function TasksPage({ searchParams }: TasksPageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

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
  const initialPriority = parseEnumParam(params.priority, TASK_PRIORITIES);
  const initialStatus = parseEnumParam(params.status, TASK_STATUSES);
  const initialDueBucket = parseEnumParam(params.due, DUE_BUCKET_VALUES);

  const todayStr = toDateOnlyString(new Date());
  const baseParams = {
    todayStr,
    search: initialSearch,
    ownerId: initialOwnerId,
    type: initialType,
    priority: initialPriority,
    status: initialStatus,
    page: 0,
    pageSize: INITIAL_PAGE_SIZE,
  };

  const bucketsToFetch = initialDueBucket ? [initialDueBucket] : ALL_BUCKETS;

  const [bucketResults, assignableUsers] = await Promise.all([
    Promise.all(
      bucketsToFetch.map((bucket) => getTasksBucketPage(supabase, membership.customer.id, { ...baseParams, bucket })),
    ),
    getVisibleTeamDirectory(supabase),
  ]);

  const initialBuckets: Partial<Record<TaskDueBucket, TasksBucketPage>> = {};
  bucketsToFetch.forEach((bucket, index) => {
    initialBuckets[bucket] = bucketResults[index];
  });

  return (
    <TasksPageClient
      initialBuckets={initialBuckets}
      initialTodayStr={todayStr}
      initialSearch={initialSearch}
      initialOwnerId={initialOwnerId}
      initialType={initialType}
      initialPriority={initialPriority}
      initialStatus={initialStatus}
      initialDueBucket={initialDueBucket}
      assignableUsers={assignableUsers}
      currentUserCustomerUserId={membership.membership.id}
    />
  );
}
