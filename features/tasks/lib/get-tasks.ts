import type { SupabaseClient } from "@supabase/supabase-js";
import { getLeadLabelsByIds, type LeadLabel } from "@/features/leads/lib/get-lead-labels";
import type { Task } from "@/types/task";

/**
 * Server-side only: every task the caller is authorized to see for this
 * customer, soonest due date first. RLS ("hierarchy-aware task
 * visibility") is the actual enforcing layer — ADMIN gets every task in
 * the customer, everyone else gets tasks assigned to themselves or a
 * recursive manager_id descendant of themselves; this just adds the
 * ordering the Tasks page wants.
 *
 * Superseded as the Tasks page's main data source by getTasksBucketPage
 * below (genuinely paginated, filtered independently by status and due
 * date) — kept in place since nothing else currently calls it.
 */
export async function getTasksForCustomer(supabase: SupabaseClient, customerId: string): Promise<Task[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("*")
    .eq("customer_id", customerId)
    .order("due_date", { ascending: true });

  if (error || !data) {
    return [];
  }

  return data as Task[];
}

/**
 * A due-date BUCKET only — no longer conflated with status. Status
 * (All/Pending/Completed) and due date (All/Today/Overdue/Upcoming) are
 * two INDEPENDENT filter dimensions: a Completed task due yesterday is
 * "overdue" here exactly the same as a Pending one, matching the
 * business requirement that Completed tasks still sort into Today/
 * Overdue/Upcoming by their own due_date. "All" due dates isn't a bucket
 * of its own — it's the Tasks page rendering all three buckets side by
 * side (see TaskList).
 */
export type TaskDueBucket = "today" | "overdue" | "upcoming";

export type TasksBucketPageParams = {
  bucket: TaskDueBucket;
  /** The CALLER's own local "today" ("YYYY-MM-DD") — passed in rather
   *  than computed on the server, so a task's bucket membership keeps
   *  being based on the user's own local date, not the server's
   *  clock/timezone. */
  todayStr: string;
  /** Exact match against status — "" means both Pending and Completed
   *  (the "All" status option). Applied independently of `bucket`: a
   *  Completed task due today still belongs to the "today" bucket when
   *  status is "" or "Completed". */
  status: string;
  /** Matches against subject OR the linked lead's company/contact_name —
   *  "" means no search filter. */
  search: string;
  /** Exact match against assigned_to — "" means every assignee. */
  ownerId: string;
  /** Exact match against type — "" means every type. */
  type: string;
  /** Exact match against priority — "" means every priority. Not part of
   *  the original Tasks filter set; added alongside the Lead filter
   *  since the business spec's own combined-filter examples ("Lead +
   *  Priority=High + Type=Call") depend on it — same shape as the
   *  existing `type` filter immediately below, not a new pattern. */
  priority: string;
  page: number;
  pageSize: number;
};

/** What TaskRow/TaskDetailModal/EditTaskDialog actually read off a
 *  listed task — traced consumer by consumer (Phase 3 column
 *  projection): the row itself (subject, priority, due_date,
 *  assigned_to, type, status), the detail modal's own extra "Created
 *  At" line (created_at), the Lead badge (lead_id), and `id` for all of
 *  the above. customer_id (filtered on, never displayed), created_by,
 *  and updated_at are confirmed unused by any consumer and dropped from
 *  the query's own select list below. */
export type TaskListItem = Pick<
  Task,
  "id" | "lead_id" | "subject" | "description" | "priority" | "due_date" | "assigned_to" | "type" | "status" | "created_at"
>;

export type TasksBucketPage = {
  tasks: TaskListItem[];
  /** Total rows matching this bucket + the current status/search/owner/
   *  type filter (not just this page) — from the same
   *  `{ count: "exact" }` request as the row fetch, what each bucket's
   *  header count and Previous/Next disabled states are computed from. */
  totalCount: number;
  /** Labels for exactly the Leads THIS bucket page's tasks link to
   *  (never the customer's whole Lead table) — what TaskRow's badge,
   *  TaskDetailModal, and EditTaskDialog's locked-lead field resolve
   *  `lead_id` into. Bounded to at most `pageSize` distinct ids. */
  leadLabels: LeadLabel[];
};

// PostgREST's `.or(...)` takes a small filter-expression DSL as a plain
// string; `,` and `(`/`)` are that DSL's own delimiters, so a search
// term containing them is stripped down to spaces first — otherwise a
// user's search text could reshape the logical filter structure PostgREST
// parses (not a SQL-injection risk — the client still parameterizes the
// final query — but a real "search behaves unexpectedly for uncommon
// input" risk worth closing off here rather than passing user text into
// this DSL unexamined.
function toSafeOrSearchTerm(value: string): string {
  return value.replace(/[,()]/g, " ").trim();
}

/**
 * Server-side only: exactly one page of one due-date bucket (Today/
 * Overdue/Upcoming) for one customer, matching the given status/search/
 * owner/type filter — a real `.range(from, to)` request against Postgres,
 * never the full table sliced in JS. RLS ("hierarchy-aware task
 * visibility") is still the enforcing layer for who may see which tasks
 * at all; this adds the bucketing/filtering/pagination the Tasks page's
 * toolbar and per-bucket Previous/Next need.
 *
 * Status and due-date bucket are applied as two INDEPENDENT `.eq`/`.lt`/
 * `.gt` conditions that combine with AND — never mutually exclusive the
 * way the previous "group" model made Completed tasks. Only applies the
 * status condition when `status` is non-empty (the "All" option), per
 * "don't add a filter condition for a dimension currently set to All."
 *
 * Shared by the page's own initial (server-rendered) fetch of each
 * visible bucket and getTasksBucketPageAction's subsequent client-driven
 * re-fetches, so the two can never drift into two different query shapes.
 */
export async function getTasksBucketPage(
  supabase: SupabaseClient,
  customerId: string,
  params: TasksBucketPageParams,
): Promise<TasksBucketPage> {
  const { bucket, todayStr, status, search, ownerId, type, priority, page, pageSize } = params;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("tasks")
    .select("id, lead_id, subject, description, priority, due_date, assigned_to, type, status, created_at", {
      count: "exact",
    })
    .eq("customer_id", customerId);

  if (bucket === "overdue") {
    query = query.lt("due_date", todayStr);
  } else if (bucket === "today") {
    query = query.eq("due_date", todayStr);
  } else {
    query = query.gt("due_date", todayStr);
  }

  if (status) {
    query = query.eq("status", status);
  }
  if (ownerId) {
    query = query.eq("assigned_to", ownerId);
  }
  if (type) {
    query = query.eq("type", type);
  }
  if (priority) {
    query = query.eq("priority", priority);
  }

  const safeSearch = toSafeOrSearchTerm(search);
  if (safeSearch) {
    // Subject lives on tasks itself; company/contact_name live on the
    // linked lead — resolved as a small separate lookup (lead ids whose
    // company/contact_name match), then OR'd against a subject match on
    // the main query, since PostgREST's query builder has no first-class
    // "OR across a join" operator to reach for instead.
    const { data: matchingLeads } = await supabase
      .from("leads")
      .select("id")
      .eq("customer_id", customerId)
      .or(`company.ilike.%${safeSearch}%,contact_name.ilike.%${safeSearch}%`);

    const matchingLeadIds = (matchingLeads ?? []).map((row) => row.id as string);
    const orParts = [`subject.ilike.%${safeSearch}%`];
    if (matchingLeadIds.length > 0) {
      orParts.push(`lead_id.in.(${matchingLeadIds.join(",")})`);
    }
    query = query.or(orParts.join(","));
  }

  const { data, error, count } = await query.order("due_date", { ascending: true }).range(from, to);

  if (process.env.NODE_ENV !== "production") {
    // TEMPORARY — remove once the Status filter is confirmed correct in a
    // live test. This runs SERVER-SIDE (visible in the terminal running
    // `next dev`/`next start`, not the browser console) right after
    // Postgres/RLS have already been applied — proving whether a missing
    // Completed result is a query/RLS problem or purely a client-side
    // rendering problem.
    console.log("TASK QUERY RESULT (server)", {
      customerId,
      bucket,
      status: status || "(All)",
      count,
      rowsReturned: data?.length ?? 0,
      statusesReturned: data ? [...new Set(data.map((row) => row.status))] : [],
      error: error?.message ?? null,
    });
  }

  if (error || !data) {
    return { tasks: [], totalCount: 0, leadLabels: [] };
  }

  const tasks = data as TaskListItem[];
  // Bounded to THIS bucket page's own tasks (≤ pageSize distinct ids) —
  // never the customer's whole Lead table. Depends on `tasks` above, so
  // it's necessarily sequential after the main query — each bucket
  // already runs as its own independent call (see this function's own
  // callers), so this doesn't serialize anything that would otherwise
  // have run in parallel.
  const leadLabels = await getLeadLabelsByIds(supabase, customerId, tasks.map((task) => task.lead_id));

  return { tasks, totalCount: count ?? 0, leadLabels };
}
