import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AutomationDetail,
  AutomationListItem,
  AutomationRunListItem,
  AutomationRunStatus,
  AutomationStatus,
  AutomationVersionRow,
  WorkflowDefinition,
} from "@/types/automation";

/**
 * Read paths for the automations feature.
 *
 * EVERY QUERY IS SCOPED BY customer_id EXPLICITLY, even though RLS
 * already restricts all four tables to is_customer_admin(customer_id).
 * Belt and braces, the same way every other loader in this app is
 * written: RLS is the boundary that holds if this code is wrong, and
 * this is the filter that holds if a policy is ever misconfigured. The
 * customer id itself is always passed in by a caller that resolved it
 * from the session — it is never read from a query string, a form
 * field, or a request body.
 */

export const AUTOMATIONS_PER_PAGE = 10;

export type AutomationListPage = {
  items: AutomationListItem[];
  total: number;
  page: number;
  pageCount: number;
};

export async function getAutomationsPage(
  supabase: SupabaseClient,
  customerId: string,
  options: { page: number; search: string },
): Promise<AutomationListPage> {
  const page = Math.max(1, Math.floor(options.page) || 1);
  const from = (page - 1) * AUTOMATIONS_PER_PAGE;
  const to = from + AUTOMATIONS_PER_PAGE - 1;

  let query = supabase
    .from("customer_automations")
    .select("id, name, description, status, origin, active_version_id, created_at, updated_at", { count: "exact" })
    .eq("customer_id", customerId);

  const search = options.search.trim();
  if (search) {
    // ilike with the term escaped for PostgREST's own or() grammar —
    // commas and parentheses would otherwise be read as filter syntax
    // rather than as characters someone typed into a search box.
    const safe = search.replace(/[,()*]/g, " ").trim();
    if (safe) {
      query = query.or(`name.ilike.%${safe}%,description.ilike.%${safe}%`);
    }
  }

  const { data, error, count } = await query.order("updated_at", { ascending: false }).range(from, to);

  if (error || !data) {
    return { items: [], total: 0, page, pageCount: 1 };
  }

  const rows = data as Array<{
    id: string;
    name: string;
    description: string | null;
    status: AutomationStatus;
    origin: "Manual" | "AI";
    active_version_id: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const ids = rows.map((row) => row.id);
  const [versions, runs] = await Promise.all([
    ids.length > 0
      ? supabase
          .from("customer_automation_versions")
          .select("automation_id, version")
          .eq("customer_id", customerId)
          .in("automation_id", ids)
      : Promise.resolve({ data: [] as Array<{ automation_id: string; version: number }>, error: null }),
    ids.length > 0
      ? supabase
          .from("customer_automation_runs")
          .select("automation_id, status, started_at")
          .eq("customer_id", customerId)
          .in("automation_id", ids)
          .order("started_at", { ascending: false })
      : Promise.resolve({
          data: [] as Array<{ automation_id: string; status: AutomationRunStatus; started_at: string }>,
          error: null,
        }),
  ]);

  const latestVersion = new Map<string, number>();
  for (const row of (versions.data ?? []) as Array<{ automation_id: string; version: number }>) {
    latestVersion.set(row.automation_id, Math.max(latestVersion.get(row.automation_id) ?? 0, row.version));
  }

  // Ordered newest-first by the query, so the FIRST row seen for an
  // automation is its most recent run.
  const lastRun = new Map<string, { status: AutomationRunStatus; started_at: string }>();
  for (const row of (runs.data ?? []) as Array<{
    automation_id: string;
    status: AutomationRunStatus;
    started_at: string;
  }>) {
    if (!lastRun.has(row.automation_id)) {
      lastRun.set(row.automation_id, { status: row.status, started_at: row.started_at });
    }
  }

  const total = count ?? rows.length;

  return {
    items: rows.map((row) => ({
      ...row,
      latest_version: latestVersion.get(row.id) ?? 0,
      last_run_at: lastRun.get(row.id)?.started_at ?? null,
      last_run_status: lastRun.get(row.id)?.status ?? null,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / AUTOMATIONS_PER_PAGE)),
  };
}

export async function getAutomationDetail(
  supabase: SupabaseClient,
  customerId: string,
  automationId: string,
): Promise<AutomationDetail | null> {
  const { data, error } = await supabase
    .from("customer_automations")
    .select("id, name, description, status, origin, active_version_id, created_at, updated_at")
    .eq("customer_id", customerId)
    .eq("id", automationId)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  const { data: versionRows } = await supabase
    .from("customer_automation_versions")
    .select("id, automation_id, version, trigger_type, definition, created_at")
    .eq("customer_id", customerId)
    .eq("automation_id", automationId)
    .order("version", { ascending: false });

  return {
    ...(data as Omit<AutomationDetail, "versions">),
    versions: (versionRows ?? []) as AutomationVersionRow[],
  };
}

/**
 * The definition the builder should open.
 *
 * The NEWEST version, not the active one — an admin who saved a draft
 * over an Active automation is editing that draft, and reopening the
 * builder must show them what they last wrote rather than silently
 * reverting to whatever is currently running. Which version is running
 * is shown separately on the page; the two are deliberately different
 * questions.
 */
export function getEditableDefinition(detail: AutomationDetail): WorkflowDefinition | null {
  return detail.versions[0]?.definition ?? null;
}

export const RUNS_PER_PAGE = 20;

export async function getRecentRuns(
  supabase: SupabaseClient,
  customerId: string,
  options: { automationId?: string; limit?: number } = {},
): Promise<AutomationRunListItem[]> {
  let query = supabase
    .from("customer_automation_runs")
    .select(
      "id, automation_id, version_id, status, stop_reason, error_detail, actions_executed, started_at, finished_at",
    )
    .eq("customer_id", customerId);

  if (options.automationId) {
    query = query.eq("automation_id", options.automationId);
  }

  const { data, error } = await query
    .order("started_at", { ascending: false })
    .limit(options.limit ?? RUNS_PER_PAGE);

  if (error || !data) {
    return [];
  }

  const rows = data as Array<{
    id: string;
    automation_id: string;
    version_id: string;
    status: AutomationRunStatus;
    stop_reason: string | null;
    error_detail: string | null;
    actions_executed: number;
    started_at: string;
    finished_at: string | null;
  }>;

  if (rows.length === 0) {
    return [];
  }

  // Names and version numbers resolved in two small lookups rather than
  // through a PostgREST embed: this project has no generated Database
  // types, so an embed comes back loosely typed and has to be cast
  // anyway (see get-current-membership.ts's own note on that), and these
  // two reads are bounded by the page size.
  const [automations, versions] = await Promise.all([
    supabase
      .from("customer_automations")
      .select("id, name")
      .eq("customer_id", customerId)
      .in("id", [...new Set(rows.map((row) => row.automation_id))]),
    supabase
      .from("customer_automation_versions")
      .select("id, version")
      .eq("customer_id", customerId)
      .in("id", [...new Set(rows.map((row) => row.version_id))]),
  ]);

  const nameById = new Map(
    ((automations.data ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]),
  );
  const versionById = new Map(
    ((versions.data ?? []) as Array<{ id: string; version: number }>).map((row) => [row.id, row.version]),
  );

  return rows.map((row) => ({
    id: row.id,
    automation_id: row.automation_id,
    automation_name: nameById.get(row.automation_id) ?? "Removed automation",
    version: versionById.get(row.version_id) ?? 0,
    status: row.status,
    stop_reason: row.stop_reason,
    error_detail: row.error_detail,
    actions_executed: row.actions_executed,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }));
}

/** Queue health for the automations page — how much is waiting and how
 *  much has given up. Read as counts only; no event content reaches the
 *  page. */
export async function getQueueSummary(
  supabase: SupabaseClient,
  customerId: string,
): Promise<{ pending: number; dead: number }> {
  const [pending, dead] = await Promise.all([
    supabase
      .from("automation_events")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId)
      .in("status", ["pending", "processing"]),
    supabase
      .from("automation_events")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId)
      .eq("status", "dead"),
  ]);

  return { pending: pending.count ?? 0, dead: dead.count ?? 0 };
}
