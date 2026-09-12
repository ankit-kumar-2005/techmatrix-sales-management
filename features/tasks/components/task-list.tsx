"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MessageBanner } from "@/components/shared/message-banner";
import { getOwnerAvatarColor, getOwnerDisplayLabels, getOwnerInitials, getOwnerTooltip } from "@/features/leads/lib/owner-display";
import { completeTaskAction, getTasksBucketPageAction } from "../actions";
import { TaskDetailModal } from "./task-detail-modal";
import { EditTaskDialog } from "./edit-task-dialog";
import { LeadSearchSelect } from "@/features/leads/components/lead-search-select";
import { formatLeadLabel, type LeadLabel } from "@/features/leads/lib/get-lead-labels";
import { ChevronDownIcon, LeadCaptureIcon, PencilIcon, SearchIcon } from "@/features/sales-management/components/icons";
import { dateFormatter } from "@/utils/format";
import { TASK_PRIORITIES, TASK_TYPES } from "@/types/task";
import type { TaskDueBucket, TasksBucketPage, TaskListItem } from "../lib/get-tasks";
import type { TaskPriority } from "@/types/task";
import type { TeamDirectoryEntry } from "@/types/lead";

// The Rows-per-page choices and their default — same three options and
// same default the Pipeline List View's own "Rows per page" selector
// already uses (pipeline-view.tsx), reused here as a literal, not a
// shared constant: Pipeline paginates a fully-client-side TanStack Table
// (page size only ever slices an array already in memory), while Tasks
// paginates server-side per due-date bucket (page size is a real query
// parameter) — the UI convention is what's shared, not the underlying
// mechanism, so there's no single constant that would honestly serve
// both without conflating two different architectures.
const PAGE_SIZE_OPTIONS = [10, 15, 20] as const;
const DEFAULT_PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

const controlClass =
  "h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";
const selectControlClass = `${controlClass} w-full appearance-none pr-9`;

const PRIORITY_BADGE_CLASSES: Record<TaskPriority, string> = {
  High: "bg-rose-50 text-rose-700 ring-1 ring-rose-100",
  Medium: "bg-amber-50 text-amber-700 ring-1 ring-amber-100",
  Low: "bg-neutral-100 text-neutral-600 ring-1 ring-neutral-200",
};

const BUCKET_TITLES: Record<TaskDueBucket, string> = {
  overdue: "Overdue",
  today: "Today",
  upcoming: "Upcoming",
};

const ALL_BUCKETS: TaskDueBucket[] = ["overdue", "today", "upcoming"];

// Status ("" / "Pending" / "Completed") and due date ("" / a specific
// bucket) are two INDEPENDENT filter dimensions — see get-tasks.ts's own
// comment on getTasksBucketPage. These two small helpers turn that pair
// into the section subtitle/empty-copy the business spec calls for (e.g.
// "Completed tasks due today", "No pending overdue tasks.") without
// hardcoding nine separate literal strings.
function statusPhrase(status: string): string {
  if (status === "Pending") return "Pending tasks";
  if (status === "Completed") return "Completed tasks";
  return "Pending + Completed tasks";
}

function bucketSubtitle(bucket: TaskDueBucket, status: string): string {
  const phrase = statusPhrase(status);
  if (bucket === "today") return `${phrase} due today`;
  if (bucket === "overdue") return `${phrase} overdue`;
  return `${phrase} upcoming`;
}

function bucketEmptyMessage(bucket: TaskDueBucket, status: string): string {
  const statusWord = status === "Pending" ? "pending " : status === "Completed" ? "completed " : "";
  if (bucket === "today") return `No ${statusWord}tasks due today.`;
  if (bucket === "overdue") return `No ${statusWord}overdue tasks.`;
  return `No ${statusWord}upcoming tasks.`;
}

function toDateOnlyString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// due_date is a plain "YYYY-MM-DD" — parsed into LOCAL date components
// explicitly (not `new Date(dateString)`, which PostgreSQL/JS parses as
// UTC midnight and can render as the *previous* day once formatted in a
// timezone west of UTC). Constructing a local Date from the same
// components sidesteps that entirely, matching "don't introduce
// unnecessary timezone complexity" — there's no conversion here to get
// wrong in the first place.
function parseDateOnly(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

type OwnerDisplay = { label: string; initials: string; tooltip: string };

type TaskListProps = {
  /** Page 1 of whichever bucket(s) are initially visible (all three, or
   *  just one if the URL's own "due" searchParam narrows to a single
   *  bucket), already filtered by initialSearch/initialOwnerId/
   *  initialType/initialStatus below — fetched once by the Server
   *  Component so first paint has no loading flash and already matches
   *  the URL's own filters. A bucket NOT present here (because Due Date
   *  narrowed it out at the time of the request) has no seed data; if the
   *  user later widens Due Date back to "All" client-side, that bucket's
   *  own TaskGroupSection mounts fresh and fetches for the first time
   *  then — see its own comment. */
  initialBuckets: Partial<Record<TaskDueBucket, TasksBucketPage>>;
  /** The SERVER's own "today" at the moment initialBuckets was fetched —
   *  compared against the browser's own computed "today" so each
   *  TaskGroupSection knows whether its seeded data is still current or
   *  needs an immediate one-time refresh (see its own comment). */
  initialTodayStr: string;
  /** The filter values the Server Component itself already used to
   *  produce initialBuckets, read from the URL's own searchParams — seeded
   *  into this component's filter state so the toolbar reflects the URL
   *  on first paint (a refresh with ?status=Completed&due=overdue lands
   *  showing Completed Overdue, already-correct data, not a reset to
   *  "All") and initialBuckets stays consistent with what's displayed. */
  initialSearch: string;
  initialOwnerId: string;
  initialType: string;
  /** Not part of the original Tasks filter set — added alongside the
   *  Lead filter since the business spec's own combined-filter examples
   *  ("Lead + Priority=High + Type=Call") depend on it, same shape as
   *  initialType immediately above. */
  initialPriority: string;
  initialStatus: string;
  /** "" (All — all three buckets render) or one specific bucket. */
  initialDueBucket: TaskDueBucket | "";
  /** "" (All leads) or a specific lead_id — the primary addition this
   *  round: lets a user find every Task tied to one Lead (tasks.lead_id),
   *  read from the URL's own searchParams the same way every other
   *  filter here already is. */
  initialLeadId: string;
  /** The caller's own hierarchy-visible teammates — used both for the
   *  Owner filter and for resolving each task's assignee display, same
   *  source AddTaskDialog's Assign picker uses. */
  assignableUsers: TeamDirectoryEntry[];
  /** Needed by EditTaskDialog's own Assign field default — the same
   *  value the page-level "+ Add task" dialog (TasksPageClient) already
   *  has and uses for its own create-mode default. */
  currentUserCustomerUserId: string;
  /** Bumped by the page-level "New task" dialog's onSuccess (owned by the
   *  shared client ancestor, TasksPageClient, since that button now lives
   *  in the page HEADER — top-right, next to the heading — not inside
   *  this component's own toolbar) — forces every visible bucket to
   *  re-fetch so a newly created task shows up without a browser refresh.
   *  Same relationship ContactList/ContactsPageClient already has. */
  refreshToken: number;
  onRefreshAll: () => void;
};

/**
 * Owns the Tasks page's toolbar (search + Owner/Type/Status/Due Date
 * filters) and everything shared ACROSS the visible due-date bucket
 * sections: the filter values themselves (the single source of truth —
 * the URL is kept in sync as a one-way mirror of this state, never fed
 * back into a query independently, see the sync effect below), the task
 * detail modal, the error toast, and a `refreshToken` that forces every
 * visible bucket to re-fetch together (completing a task changes its
 * status, which can change whether it matches the current Status filter
 * at all — the source bucket needs to settle on the database's own
 * current shape rather than trying to keep an optimistic array correct
 * by hand for every possible filter combination). Each bucket's own
 * paginated fetching lives in TaskGroupSection below.
 *
 * Status (All/Pending/Completed) and Due Date (All/Today/Overdue/
 * Upcoming) are independent dimensions that combine with every other
 * filter (owner/type/search) via AND, all the way down to the database
 * query in getTasksBucketPage — never mutually exclusive, and a Completed
 * task belongs to the same Today/Overdue/Upcoming buckets a Pending one
 * would, based purely on its own due_date.
 */
export function TaskList({
  initialBuckets,
  initialTodayStr,
  initialSearch,
  initialOwnerId,
  initialType,
  initialPriority,
  initialStatus,
  initialDueBucket,
  initialLeadId,
  assignableUsers,
  currentUserCustomerUserId,
  refreshToken,
  onRefreshAll,
}: TaskListProps) {
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [committedSearch, setCommittedSearch] = useState(initialSearch);
  const [ownerFilter, setOwnerFilter] = useState(initialOwnerId);
  const [typeFilter, setTypeFilter] = useState(initialType);
  const [priorityFilter, setPriorityFilter] = useState(initialPriority);
  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [dueBucketFilter, setDueBucketFilter] = useState<TaskDueBucket | "">(initialDueBucket);
  const [leadFilter, setLeadFilter] = useState(initialLeadId);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [detailTask, setDetailTask] = useState<TaskListItem | null>(null);
  const [editingTask, setEditingTask] = useState<TaskListItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // Debounce: only the committed value drives an actual fetch in each
  // bucket section, so typing doesn't hit the server on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setCommittedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Keeps the URL's own searchParams mirroring the current filters — a
  // genuine "synchronize with an external system" effect (the browser's
  // address bar), not state derived from props, so a plain useEffect is
  // the right tool here (unlike the render-time "adjust state" pattern
  // used elsewhere in this file for a component syncing its OWN state to
  // its OWN incoming props). Deliberately uses the History API directly
  // instead of next/navigation's router: router.replace would re-run the
  // TasksPage Server Component (and thus re-fetch every visible bucket
  // again) on every filter change, duplicating the fetch TaskGroupSection
  // is already making itself — this only needs the URL bar to reflect
  // the current filters so a later hard refresh (TasksPage reading its
  // own searchParams) lands on the same view, not a second network
  // request right now. This is also this app's single source of truth
  // for filter state: the URL is written FROM this state, never read
  // back into it after mount, so the two can never drift apart mid-
  // session — see the file-level comment.
  useEffect(() => {
    const params = new URLSearchParams();
    if (committedSearch) params.set("q", committedSearch);
    if (ownerFilter) params.set("owner", ownerFilter);
    if (typeFilter) params.set("type", typeFilter);
    if (priorityFilter) params.set("priority", priorityFilter);
    if (statusFilter) params.set("status", statusFilter);
    if (dueBucketFilter) params.set("due", dueBucketFilter);
    if (leadFilter) params.set("lead", leadFilter);
    const queryString = params.toString();
    const url = queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [committedSearch, ownerFilter, typeFilter, priorityFilter, statusFilter, dueBucketFilter, leadFilter]);

  const hasActiveFilters = Boolean(
    searchInput || ownerFilter || typeFilter || priorityFilter || statusFilter || dueBucketFilter || leadFilter,
  );

  // Each bucket resolves labels only for the Leads ITS OWN currently-
  // loaded tasks link to (bounded — see getTasksBucketPage's own
  // comment) and reports them up here via onLeadLabelsChange, since
  // TaskDetailModal/EditTaskDialog below can be opened for a task from
  // ANY bucket. Seeded from initialBuckets so both are already correct
  // before any bucket's own client-driven re-fetch ever runs.
  const [bucketLeadLabels, setBucketLeadLabels] = useState<Partial<Record<TaskDueBucket, LeadLabel[]>>>(() => {
    const seed: Partial<Record<TaskDueBucket, LeadLabel[]>> = {};
    for (const bucket of ALL_BUCKETS) {
      const page = initialBuckets[bucket];
      if (page) seed[bucket] = page.leadLabels;
    }
    return seed;
  });

  const leadLabelById = useMemo(() => {
    const map = new Map<string, LeadLabel>();
    for (const labels of Object.values(bucketLeadLabels)) {
      for (const lead of labels ?? []) map.set(lead.id, lead);
    }
    return map;
  }, [bucketLeadLabels]);

  function handleBucketLeadLabelsChange(bucket: TaskDueBucket, labels: LeadLabel[]) {
    setBucketLeadLabels((current) => ({ ...current, [bucket]: labels }));
  }

  const assigneeDisplayById = useMemo(() => {
    const labels = getOwnerDisplayLabels(assignableUsers);
    const map = new Map<string, OwnerDisplay>();
    for (const user of assignableUsers) {
      map.set(user.customer_user_id, {
        label: labels.get(user.customer_user_id) ?? user.email,
        initials: getOwnerInitials(user),
        tooltip: getOwnerTooltip(user),
      });
    }
    return map;
  }, [assignableUsers]);

  // Reset clears BOTH the UI (every control below re-renders from these
  // same state values) and the actual query state driving every visible
  // bucket's fetch — there is no separate "display" copy to fall out of
  // sync, since the controls themselves are directly bound to this state.
  function resetFilters() {
    setSearchInput("");
    setCommittedSearch("");
    setOwnerFilter("");
    setTypeFilter("");
    setPriorityFilter("");
    setStatusFilter("");
    setDueBucketFilter("");
    setLeadFilter("");
  }

  // The task detail modal isn't scoped to any one bucket's own local
  // page, so completing from it goes through a plain top-level call
  // (no per-row optimism to manage here — the modal closes immediately
  // either way, see TaskDetailModal's own onComplete) and just asks
  // every visible bucket to refresh once the database is done.
  async function handleCompleteFromModal(task: TaskListItem) {
    const result = await completeTaskAction(task.id);
    if (!result.success) {
      setActionError(result.error ?? "Unable to complete this task. Please try again.");
      return;
    }
    onRefreshAll();
  }

  // Due Date = All renders all three buckets; a specific Due Date value
  // renders exactly that one — never more, never fewer, matching "the
  // Due Date filter narrows the selected Status correctly" without a
  // separate code path per bucket.
  const visibleBuckets: TaskDueBucket[] = dueBucketFilter ? [dueBucketFilter] : ALL_BUCKETS;

  return (
    <>
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
        <div className="border-b border-neutral-100 p-4 sm:p-5">
          {/* Filters wrap onto additional lines instead of forcing every
              control onto one un-scrollable row — these controls don't
              reliably fit on a single line at normal desktop widths, and
              a previous sm:overflow-x-auto + sm:flex-nowrap combination
              turned that overflow into a horizontal scrollbar that pushed
              content off-screen instead of letting it wrap. "+ Add task"
              itself no longer lives here at all — it's in the page
              HEADER now (top-right, next to the heading, owned by
              TasksPageClient), matching where Contacts' "+ New contact"
              already lives. */}
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
            <div className="group relative w-full sm:min-w-[10rem] sm:flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-sky-500" />
              <input
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search tasks or leads..."
                className={`${controlClass} w-full pl-9`}
              />
            </div>

            {/* "Quickly find all Tasks associated with a Lead." Controlled
                mode (value/onChange, no `name`) + hideLabel, the exact
                same pattern ContactList's own Lead filter already
                established — LeadSearchSelect's own search is server-side
                and customer-scoped, so a cross-tenant Lead can never even
                be offered here. */}
            <div className="w-full shrink-0 sm:w-64">
              <LeadSearchSelect
                id="task-lead-filter"
                label="Lead"
                hideLabel
                value={leadFilter}
                onChange={setLeadFilter}
                placeholder="All leads — search by name, company, email, or phone..."
              />
            </div>

            <div className="relative w-full shrink-0 sm:w-40">
              <select
                value={ownerFilter}
                onChange={(event) => setOwnerFilter(event.target.value)}
                className={`${selectControlClass} truncate`}
              >
                <option value="">All owners</option>
                {assignableUsers.map((user) => (
                  <option key={user.customer_user_id} value={user.customer_user_id}>
                    {assigneeDisplayById.get(user.customer_user_id)?.label ?? user.email}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            </div>

            <div className="relative w-full shrink-0 sm:w-32">
              <select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                className={`${selectControlClass} truncate`}
              >
                <option value="">All types</option>
                {TASK_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            </div>

            <div className="relative w-full shrink-0 sm:w-32">
              <select
                value={priorityFilter}
                onChange={(event) => setPriorityFilter(event.target.value)}
                className={`${selectControlClass} truncate`}
              >
                <option value="">All priorities</option>
                {TASK_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            </div>

            <div className="relative w-full shrink-0 sm:w-32">
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                className={`${selectControlClass} truncate`}
              >
                <option value="">All statuses</option>
                <option value="Pending">Pending</option>
                <option value="Completed">Completed</option>
              </select>
              <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            </div>

            <div className="relative w-full shrink-0 sm:w-36">
              <select
                value={dueBucketFilter}
                onChange={(event) => setDueBucketFilter(event.target.value as TaskDueBucket | "")}
                className={`${selectControlClass} truncate`}
              >
                <option value="">All due dates</option>
                <option value="today">Today</option>
                <option value="overdue">Overdue</option>
                <option value="upcoming">Upcoming</option>
              </select>
              <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            </div>

            <button
              type="button"
              onClick={resetFilters}
              disabled={!hasActiveFilters}
              className="h-10 w-full shrink-0 rounded-lg border border-neutral-300 px-4 text-sm font-semibold text-neutral-500 transition-colors hover:border-neutral-400 hover:bg-neutral-50 hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="p-4 sm:p-6">
          {/* Every visible bucket is ALWAYS mounted here — never gated on
              an aggregated "does anything match" total. Each bucket
              fetches and settles independently and at its own pace; if
              mounting were conditioned on a sum of their (async,
              independently-arriving) totals, one bucket resolving to 0
              first could transiently zero the sum before a SLOWER bucket
              with real matching rows had reported in, unmounting every
              section — including the one still fetching — and silently
              discarding that in-flight result once it resolved after
              unmount (its own cancellation flag would suppress the state
              update). That was the actual cause of "Completed doesn't
              show until a refresh": a full page reload fetches every
              bucket together in one atomic server request with no such
              race, which is why it "fixed" it. Each section already
              renders its own accurate empty message when it has nothing
              — see bucketEmptyMessage — so no separate top-level empty
              state is needed here at all. */}
          <div className="flex flex-col gap-8">
            {visibleBuckets.map((bucket) => (
              <TaskGroupSection
                key={bucket}
                bucket={bucket}
                initialPage={initialBuckets[bucket]}
                initialTodayStr={initialTodayStr}
                search={committedSearch}
                ownerId={ownerFilter}
                type={typeFilter}
                priority={priorityFilter}
                status={statusFilter}
                dueBucketFilterKey={dueBucketFilter}
                leadId={leadFilter}
                pageSize={pageSize}
                refreshToken={refreshToken}
                assigneeDisplayById={assigneeDisplayById}
                onView={setDetailTask}
                onEdit={setEditingTask}
                onError={setActionError}
                onRefreshAll={onRefreshAll}
                onLeadLabelsChange={(labels) => handleBucketLeadLabelsChange(bucket, labels)}
              />
            ))}
          </div>
        </div>

        {/* BELOW the task list, on the LEFT — same "Rows per page"
            label/select markup and options (10/15/20) as the Pipeline
            List View's own selector (pipeline-view.tsx), just relocated
            here from the toolbar above. Each bucket still owns its own
            independent Previous/Next (Tasks paginates per due-date
            bucket, not as one flat list the way Pipeline does), so this
            is a single shared control for the one thing that IS shared
            across every bucket — page size — rather than an attempt to
            merge three independent paginated lists into Pipeline's
            single-footer shape, which would be a materially different
            (and unrequested) pagination architecture change. */}
        <div className="flex items-center gap-2 border-t border-neutral-100 px-4 py-3 text-xs text-neutral-500 sm:px-6">
          <label htmlFor="task-rows-per-page">Rows per page</label>
          <select
            id="task-rows-per-page"
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value))}
            className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      </div>

      {actionError ? (
        <div className="fixed right-6 bottom-6 z-[1100] w-full max-w-xs shadow-lg">
          <MessageBanner tone="error">{actionError}</MessageBanner>
        </div>
      ) : null}

      {detailTask ? (
        <TaskDetailModal
          task={detailTask}
          lead={leadLabelById.get(detailTask.lead_id)}
          assignee={assigneeDisplayById.get(detailTask.assigned_to)}
          onComplete={() => handleCompleteFromModal(detailTask)}
          onClose={() => setDetailTask(null)}
        />
      ) : null}

      {editingTask ? (
        <EditTaskDialog
          task={editingTask}
          lockedLeadLabel={
            leadLabelById.has(editingTask.lead_id) ? formatLeadLabel(leadLabelById.get(editingTask.lead_id)!) : ""
          }
          assignableUsers={assignableUsers}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onClose={() => {
            setEditingTask(null);
            onRefreshAll();
          }}
        />
      ) : null}
    </>
  );
}

type TaskGroupSectionProps = {
  bucket: TaskDueBucket;
  /** Real server-fetched seed data, present only when THIS bucket was
   *  part of the initial (searchParams-driven) fetch — undefined means
   *  this section just mounted because the user widened Due Date
   *  client-side, so it always fetches fresh rather than trying to reuse
   *  seed data from a different bucket set (see the fetch effect below). */
  initialPage: TasksBucketPage | undefined;
  initialTodayStr: string;
  search: string;
  ownerId: string;
  type: string;
  priority: string;
  status: string;
  /** The CURRENT Due Date filter value (not this section's own bucket,
   *  which never changes across this component's lifetime) — included
   *  purely so a Due Date change resets this bucket's own pagination back
   *  to page 1 even when the bucket itself stays visible across that
   *  change (e.g. Due Date going from "All" to "Today" while the Today
   *  section stays mounted) — see the synced-state block below. */
  dueBucketFilterKey: TaskDueBucket | "";
  leadId: string;
  /** Rows to fetch per page (10/15/20, shared across every bucket) —
   *  included in the synced-diff below for the same reason
   *  dueBucketFilterKey is: changing it must reset this bucket's own
   *  pagination back to page 1. */
  pageSize: number;
  refreshToken: number;
  assigneeDisplayById: Map<string, OwnerDisplay>;
  onView: (task: TaskListItem) => void;
  onEdit: (task: TaskListItem) => void;
  onError: (message: string) => void;
  /** Bumps the PARENT's refreshToken — used after this section's own
   *  row-level complete succeeds, since completing a task changes its
   *  status, which can move it in or out of what the current Status
   *  filter matches. */
  onRefreshAll: () => void;
  /** Reports this bucket's own current (bounded) lead labels up to
   *  TaskList, which merges every visible bucket's own set — needed for
   *  TaskDetailModal/EditTaskDialog, either of which can be opened for a
   *  task from ANY bucket, not just this one. Fired only when this
   *  section's OWN labels actually change (a fresh fetch); TaskList
   *  seeds its own initial merge from `initialBuckets` directly, so
   *  there's no need to also fire this once on mount. */
  onLeadLabelsChange: (labels: LeadLabel[]) => void;
};

/**
 * One independently-paginated due-date bucket. Fetches its own page from
 * getTasksBucketPageAction whenever its own `page` changes, or whenever
 * any of the shared search/owner/type/status filters or Due Date filter
 * (passed down as props from TaskList) or `refreshToken` change —
 * resetting its own `page` back to 0 whenever any of them changes, so a
 * user never lands on a now-out-of-range page after narrowing a filter.
 */
function TaskGroupSection({
  bucket,
  initialPage,
  initialTodayStr,
  search,
  ownerId,
  type,
  priority,
  status,
  dueBucketFilterKey,
  leadId,
  pageSize,
  refreshToken,
  assigneeDisplayById,
  onView,
  onEdit,
  onError,
  onRefreshAll,
  onLeadLabelsChange,
}: TaskGroupSectionProps) {
  const [tasks, setTasks] = useState(initialPage?.tasks ?? []);
  const [totalCount, setTotalCount] = useState(initialPage?.totalCount ?? 0);
  const [leadLabels, setLeadLabels] = useState(initialPage?.leadLabels ?? []);
  const [page, setPage] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  const leadsById = useMemo(() => new Map(leadLabels.map((lead) => [lead.id, lead])), [leadLabels]);

  // A fresh closure every TaskList render (it closes over `bucket`) — read
  // via a ref inside the fetch effect below rather than listed as a
  // dependency, the same "ref-to-latest-callback" pattern Modal's own
  // onCloseRef uses, so a parent re-render alone can never re-trigger
  // that effect.
  const onLeadLabelsChangeRef = useRef(onLeadLabelsChange);
  useEffect(() => {
    onLeadLabelsChangeRef.current = onLeadLabelsChange;
  }, [onLeadLabelsChange]);

  // Recomputed from the BROWSER's own clock on every render (a cheap
  // string comparison, not worth memoizing) — this is what makes bucket
  // membership follow the user's own local "today", not the server's,
  // for every fetch after the very first one.
  const todayStr = toDateOnlyString(new Date());

  // Resets to page 1 whenever any shared filter changes — "adjust state
  // during render" (React's own recommended pattern for "reset state
  // when a prop changes"), not a useEffect: `page` is this component's
  // own state, being kept in sync with its own props, the same safe case
  // used throughout this app for "reset pagination when a filter prop
  // changes" (not the unsafe case of nudging a PARENT's state during a
  // child's render). dueBucketFilterKey is included purely as a reset
  // trigger — this section's own `bucket` never changes, so it never
  // affects the query itself.
  const [syncedSearch, setSyncedSearch] = useState(search);
  const [syncedOwnerId, setSyncedOwnerId] = useState(ownerId);
  const [syncedType, setSyncedType] = useState(type);
  const [syncedPriority, setSyncedPriority] = useState(priority);
  const [syncedStatus, setSyncedStatus] = useState(status);
  const [syncedDueBucketFilterKey, setSyncedDueBucketFilterKey] = useState(dueBucketFilterKey);
  const [syncedLeadId, setSyncedLeadId] = useState(leadId);
  const [syncedPageSize, setSyncedPageSize] = useState(pageSize);
  if (
    search !== syncedSearch ||
    ownerId !== syncedOwnerId ||
    type !== syncedType ||
    priority !== syncedPriority ||
    status !== syncedStatus ||
    dueBucketFilterKey !== syncedDueBucketFilterKey ||
    leadId !== syncedLeadId ||
    pageSize !== syncedPageSize
  ) {
    setSyncedSearch(search);
    setSyncedOwnerId(ownerId);
    setSyncedType(type);
    setSyncedPriority(priority);
    setSyncedStatus(status);
    setSyncedDueBucketFilterKey(dueBucketFilterKey);
    setSyncedLeadId(leadId);
    setSyncedPageSize(pageSize);
    setPage(0);
  }

  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      // The server already fetched this exact bucket/page/filter
      // combination — skip re-fetching it again, UNLESS there's no real
      // seed data for this bucket (it just mounted because Due Date
      // widened client-side — see initialPage's own comment) or the
      // browser's own "today" has already moved on from what the server
      // used (e.g. the page sat open across midnight before this ever
      // mounted) — either case falls through and fetches once to
      // self-correct immediately.
      if (initialPage && todayStr === initialTodayStr) return;
    }

    let cancelled = false;
    setIsLoading(true);

    const requestParams = { bucket, todayStr, status, search, ownerId, type, priority, leadId, page, pageSize };
    if (process.env.NODE_ENV !== "production") {
      // TEMPORARY — remove once the Status filter is confirmed correct in
      // a live test. Proves what this specific fetch actually asked for.
      console.log("TASK FILTER QUERY", requestParams);
    }

    getTasksBucketPageAction(requestParams).then(
      (result) => {
        if (cancelled) return;

        if (process.env.NODE_ENV !== "production") {
          // TEMPORARY — remove alongside the request log above.
          console.log("TASK QUERY RESULT", {
            bucket,
            status,
            rows: result.tasks.length,
            totalCount: result.totalCount,
            statusesReturned: [...new Set(result.tasks.map((t) => t.status))],
          });
        }

        // A background refresh (refreshToken — e.g. completing this
        // bucket's own last remaining matching task on a later page) can
        // shrink totalCount out from under the page the user was already
        // on. Rather than commit an empty result for a now out-of-range
        // page, clamp to the new last valid page and let that trigger
        // one more (correct) fetch.
        const resultPageCount = Math.max(Math.ceil(result.totalCount / pageSize), 1);
        if (page > resultPageCount - 1) {
          setTotalCount(result.totalCount);
          setIsLoading(false);
          setPage(resultPageCount - 1);
          return;
        }

        setTasks(result.tasks);
        setTotalCount(result.totalCount);
        setLeadLabels(result.leadLabels);
        onLeadLabelsChangeRef.current(result.leadLabels);
        setIsLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- todayStr/initialTodayStr/initialPage are intentionally read via closure above rather than listed: they only matter for the very first run (guarded by isFirstRun), and re-including them here would re-run this effect on every render since todayStr is recomputed fresh each time; onLeadLabelsChange is read via a ref (see its own comment) rather than listed, for the same reason it's excluded everywhere else in this app (AddTaskDialog/NewContactDialog's identical onSuccess effects) — a fresh closure every parent render, and listing it would re-run this whole fetch effect for that alone.
  }, [bucket, search, ownerId, type, priority, status, leadId, page, pageSize, refreshToken]);

  const pageCount = Math.max(Math.ceil(totalCount / pageSize), 1);
  const currentPage = Math.min(page, pageCount - 1);

  async function handleComplete(task: TaskListItem) {
    // A "Pending only" filter means a task that just became Completed no
    // longer belongs in this list at all — remove it optimistically.
    // Under "All" or (impossible here, since the checkbox is disabled
    // for an already-Completed row) "Completed", the task stays in the
    // same due-date bucket and just flips to a struck-through row.
    const shouldRemoveOptimistically = status === "Pending";
    if (shouldRemoveOptimistically) {
      setTasks((current) => current.filter((t) => t.id !== task.id));
    } else {
      setTasks((current) => current.map((t) => (t.id === task.id ? { ...t, status: "Completed" } : t)));
    }

    const result = await completeTaskAction(task.id);
    if (!result.success) {
      onError(result.error ?? "Unable to complete this task. Please try again.");
      // Re-fetch rather than hand-rolling a rollback (reinserting a
      // removed row at the right sorted position/page is genuinely more
      // error-prone than just asking the server for the real state).
      onRefreshAll();
      return;
    }
    onRefreshAll();
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="flex items-center gap-2 text-xs font-semibold tracking-wider text-neutral-500 uppercase">
          {BUCKET_TITLES[bucket]}
          <span className="text-neutral-400">({totalCount})</span>
        </p>
        <p className="text-xs text-neutral-400">{bucketSubtitle(bucket, status)}</p>
      </div>

      <div className="relative flex flex-col gap-2.5">
        {tasks.length === 0 ? (
          <p className="rounded-xl bg-neutral-50 px-4 py-6 text-center text-sm text-neutral-400">
            {bucketEmptyMessage(bucket, status)}
          </p>
        ) : (
          tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              tone={bucket}
              lead={leadsById.get(task.lead_id)}
              assignee={assigneeDisplayById.get(task.assigned_to)}
              onComplete={() => handleComplete(task)}
              onView={() => onView(task)}
              onEdit={() => onEdit(task)}
            />
          ))
        )}

        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-white/70">
            <span
              aria-hidden="true"
              className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-200 border-t-sky-600"
            />
            <span className="sr-only">Loading tasks…</span>
          </div>
        ) : null}
      </div>

      {/* Always rendered, regardless of pageCount — previously gated on
          pageCount > 1, which meant these controls simply didn't exist in
          the DOM whenever this bucket's filtered result fit on one page
          (the common case for a narrow Lead/search filter), reading as
          "no way to paginate" rather than "disabled." The real `disabled`
          attribute (unchanged below) is what actually makes first/last
          page unreachable and lets screen readers/keyboard nav skip them
          — this only changes whether the buttons exist at all, matching
          the identical fix already applied to ContactList's own
          pagination footer. */}
      <div className="mt-3 flex flex-col items-center justify-end gap-2 sm:flex-row">
        <p className="text-xs font-medium text-neutral-600">
          Page {currentPage + 1} of {pageCount}
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(current - 1, 0))}
            disabled={currentPage === 0}
            aria-label="Previous page"
            className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => setPage((current) => Math.min(current + 1, pageCount - 1))}
            disabled={currentPage >= pageCount - 1}
            aria-label="Next page"
            className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

type TaskRowProps = {
  task: TaskListItem;
  tone: TaskDueBucket;
  lead?: LeadLabel;
  assignee?: OwnerDisplay;
  onComplete: () => void;
  onView: () => void;
  onEdit: () => void;
};

function TaskRow({ task, tone, lead, assignee, onComplete, onView, onEdit }: TaskRowProps) {
  const isCompleted = task.status === "Completed";
  const formattedDue = dateFormatter.format(parseDateOnly(task.due_date));
  const dueLabel =
    tone === "overdue" ? `Overdue · ${formattedDue}` : tone === "today" ? "Due today" : `Due ${formattedDue}`;

  return (
    <div className="group relative flex items-start gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          if (!isCompleted) onComplete();
        }}
        disabled={isCompleted}
        aria-label={isCompleted ? `${task.subject} is completed` : `Mark "${task.subject}" as complete`}
        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none ${
          isCompleted
            ? "cursor-default border-emerald-500 bg-emerald-500 text-white"
            : "cursor-pointer border-neutral-300 hover:border-sky-500"
        }`}
      >
        {isCompleted ? (
          <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3">
            <path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : null}
      </button>

      <button type="button" onClick={onView} className="min-w-0 flex-1 pr-9 text-left">
        <p className={`text-sm font-semibold ${isCompleted ? "text-neutral-400 line-through" : "text-neutral-900"}`}>
          {task.subject}
        </p>

        {/* The business requirement this satisfies: "which Lead does
            this Task belong to" must be answerable without opening the
            task — a colored badge on its own line (not blended into the
            other meta chips below, unlike Assignee/Due/Type) so it reads
            as a distinct, first-class piece of information. Same visual
            treatment ContactRow's own Lead badge already established,
            reused here for consistency rather than a third variant. */}
        {lead ? (
          <p className="mt-1">
            <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-700 ring-1 ring-sky-100">
              <LeadCaptureIcon className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">
                {formatLeadLabel(lead)}
              </span>
            </span>
          </p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase ${PRIORITY_BADGE_CLASSES[task.priority]}`}
          >
            {task.priority}
          </span>
          {isCompleted ? (
            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold tracking-wide text-emerald-700 uppercase ring-1 ring-emerald-100">
              Completed
            </span>
          ) : null}
          {assignee ? (
            <span className="flex items-center gap-1 text-neutral-600">
              <span
                className={`flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold text-white ${getOwnerAvatarColor(task.assigned_to)}`}
              >
                {assignee.initials}
              </span>
              {assignee.label}
            </span>
          ) : null}
          <span className={tone === "overdue" ? "font-semibold text-rose-600" : "text-neutral-500"}>{dueLabel}</span>
          <span className="text-neutral-400">{task.type}</span>
        </div>
      </button>

      {/* Edit is always authorized for any listed task — Tasks' SELECT
          and UPDATE RLS policies use the IDENTICAL predicate
          (is_customer_user_visible(assigned_to)), so if a task appears
          here at all, the caller is already authorized to update it; no
          client-side canEdit gate is needed. updateTaskAction/RLS remain
          the real boundary regardless — see EditTaskDialog's own
          comment. Hidden by default on desktop (revealed on hover/
          focus via the row's own group), always visible below the sm
          breakpoint since touch devices have no hover state to reveal it
          with — same pattern as ContactRow's identical pencil. */}
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onEdit();
        }}
        title="Edit task"
        aria-label={`Edit ${task.subject}`}
        className="absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 opacity-100 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
      >
        <PencilIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
