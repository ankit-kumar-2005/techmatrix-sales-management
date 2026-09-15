import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side only. Thin, typed wrappers around the four forecast
 * aggregate RPCs (see the forecast_aggregates migration).
 *
 * WHAT IS DELIBERATELY NOT HERE: any summing, filtering, or grouping.
 * Every figure the Forecast page shows is produced by a SQL GROUP BY on
 * the database side and arrives already aggregated — at most one row per
 * stage, per rep, or per month. Nothing in this module fetches leads.
 * That matters beyond tidiness: the Pipeline page's equivalent numbers
 * come from an unbounded select of every lead followed by a reduce in
 * JavaScript, which grows with the tenant. Forecast does not repeat it.
 *
 * WHY NO customer_id PARAMETER on any of these: the RPCs are SECURITY
 * INVOKER, so "hierarchy-aware lead visibility" on public.leads is
 * evaluated inside them for the real caller. The tenant and the
 * role-based row scope are both decided by RLS — there is no argument
 * through which a caller could widen either, and no copy of that
 * visibility rule anywhere in this file.
 *
 * EVERY ONE FAILS CLOSED, to zeros/empties rather than throwing. A
 * forecast is a read-only dashboard: if a migration hasn't been applied
 * yet or a single rollup errors, the page should render the sections it
 * can with honest zeros rather than 500 the whole route. Nothing here
 * authorizes anything, so a failed read can never widen access.
 */

/** Postgres numeric and bigint both arrive from PostgREST as either a
 *  JSON number or a string depending on magnitude and driver version.
 *  Every value crossing this boundary goes through here so no downstream
 *  arithmetic or Intl formatting ever receives a string — the same
 *  defensive Number(...) the Pipeline page already applies to
 *  deal_value. */
function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------
// Summary — the four KPI cards, plus the two honesty counters
// ---------------------------------------------------------------------

export type ForecastSummary = {
  weightedForecast: number;
  bestCase: number;
  openDealCount: number;
  closedWonValue: number;
  closedWonCount: number;
  expectedThisMonthValue: number;
  expectedThisMonthCount: number;
  /** Open deals with no expected close date. They ARE in
   *  weightedForecast/bestCase but cannot appear on the month chart —
   *  which is exactly why this is surfaced rather than swallowed. */
  undatedOpenCount: number;
};

const EMPTY_SUMMARY: ForecastSummary = {
  weightedForecast: 0,
  bestCase: 0,
  openDealCount: 0,
  closedWonValue: 0,
  closedWonCount: 0,
  expectedThisMonthValue: 0,
  expectedThisMonthCount: 0,
  undatedOpenCount: 0,
};

export async function getForecastSummary(supabase: SupabaseClient): Promise<ForecastSummary> {
  const { data, error } = await supabase.rpc("get_forecast_summary");

  // A `returns table` function always comes back as an array, even for
  // a single row.
  if (error || !Array.isArray(data) || data.length === 0) {
    return EMPTY_SUMMARY;
  }

  const row = data[0] as Record<string, unknown>;

  return {
    weightedForecast: toNumber(row.weighted_forecast),
    bestCase: toNumber(row.best_case),
    openDealCount: toNumber(row.open_deal_count),
    closedWonValue: toNumber(row.closed_won_value),
    closedWonCount: toNumber(row.closed_won_count),
    expectedThisMonthValue: toNumber(row.expected_this_month_value),
    expectedThisMonthCount: toNumber(row.expected_this_month_count),
    undatedOpenCount: toNumber(row.undated_open_count),
  };
}

// ---------------------------------------------------------------------
// By stage
// ---------------------------------------------------------------------

/** Carries the stage identity columns the UI needs so it can reuse the
 *  existing stage color palette (which keys off display_order) and the
 *  existing badge (which reads is_closed/is_won) without a second
 *  lookup against the stages table. */
export type ForecastStageRow = {
  stageId: string;
  stage: string;
  displayOrder: number;
  status: string;
  isClosed: boolean;
  isWon: boolean;
  probability: number;
  openDealCount: number;
  totalValue: number;
  weightedValue: number;
};

export async function getForecastByStage(supabase: SupabaseClient): Promise<ForecastStageRow[]> {
  const { data, error } = await supabase.rpc("get_forecast_by_stage");

  if (error || !Array.isArray(data)) {
    return [];
  }

  return (data as Record<string, unknown>[]).map((row) => ({
    stageId: String(row.stage_id),
    stage: String(row.stage),
    displayOrder: toNumber(row.display_order),
    status: String(row.status),
    isClosed: row.is_closed === true,
    isWon: row.is_won === true,
    probability: toNumber(row.probability),
    openDealCount: toNumber(row.open_deal_count),
    totalValue: toNumber(row.total_value),
    weightedValue: toNumber(row.weighted_value),
  }));
}

// ---------------------------------------------------------------------
// By rep
// ---------------------------------------------------------------------

/** ownerId is null for unassigned deals. That row can only ever reach an
 *  ADMIN: "hierarchy-aware lead visibility" admits a lead with
 *  owner_id IS NULL through its is_customer_admin branch alone, so RLS —
 *  not this module and not the page — is what keeps unassigned deals out
 *  of a manager's or rep's rollup. */
export type ForecastRepRow = {
  ownerId: string | null;
  openDealCount: number;
  bestCase: number;
  weightedForecast: number;
};

export async function getForecastByRep(supabase: SupabaseClient): Promise<ForecastRepRow[]> {
  const { data, error } = await supabase.rpc("get_forecast_by_owner");

  if (error || !Array.isArray(data)) {
    return [];
  }

  return (data as Record<string, unknown>[]).map((row) => ({
    ownerId: row.owner_id === null || row.owner_id === undefined ? null : String(row.owner_id),
    openDealCount: toNumber(row.open_deal_count),
    bestCase: toNumber(row.best_case),
    weightedForecast: toNumber(row.weighted_forecast),
  }));
}

// ---------------------------------------------------------------------
// By month
// ---------------------------------------------------------------------

/** "OVERDUE" and "LATER" are single buckets with no monthStart; "MONTH"
 *  rows are one per generated month, current month first, including
 *  months with no deals (so the chart's bars never reflow because an
 *  empty month vanished). */
export type ForecastMonthBucket = "OVERDUE" | "MONTH" | "LATER";

export type ForecastMonthRow = {
  bucket: ForecastMonthBucket;
  /** ISO yyyy-mm-dd of the first day of the month; null for OVERDUE/LATER. */
  monthStart: string | null;
  weightedValue: number;
  openDealCount: number;
};

/** Months shown on the trend chart, including the current one. The RPC
 *  clamps whatever it receives to 1..24 regardless. */
export const FORECAST_MONTH_WINDOW = 6;

export async function getForecastByMonth(
  supabase: SupabaseClient,
  months: number = FORECAST_MONTH_WINDOW,
): Promise<ForecastMonthRow[]> {
  const { data, error } = await supabase.rpc("get_forecast_by_month", { p_months: months });

  if (error || !Array.isArray(data)) {
    return [];
  }

  return (data as Record<string, unknown>[]).map((row) => ({
    bucket: row.bucket as ForecastMonthBucket,
    monthStart: row.month_start === null || row.month_start === undefined ? null : String(row.month_start),
    weightedValue: toNumber(row.weighted_value),
    openDealCount: toNumber(row.open_deal_count),
  }));
}
