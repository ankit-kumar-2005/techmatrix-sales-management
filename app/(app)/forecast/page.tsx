import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { KpiCards, type KpiCardData } from "@/features/leads/components/kpi-cards";
import {
  getForecastByMonth,
  getForecastByRep,
  getForecastByStage,
  getForecastSummary,
} from "@/features/forecast/lib/get-forecast";
import { ForecastMonthlyChart } from "@/features/forecast/components/forecast-monthly-chart";
import { ForecastByStageTable } from "@/features/forecast/components/forecast-by-stage-table";
import { ForecastByRepTable } from "@/features/forecast/components/forecast-by-rep-table";
import { ForecastIcon, PipelineIcon, TargetIcon, TrendingUpIcon } from "@/features/sales-management/components/icons";

/**
 * Settings-free, read-only revenue forecast.
 *
 * Auth + customer membership + the Inactive-membership gate are already
 * enforced by app/(app)/layout.tsx before this page renders — it does
 * not repeat the guard, the same as every other page in this route
 * group.
 *
 * NO LEAD IS FETCHED HERE. All five figures come from four SQL GROUP BY
 * rollups (see the forecast_aggregates migration), each returning a
 * handful of rows: one per stage, one per rep, one per month. That is a
 * deliberate departure from the Pipeline page, which still selects every
 * lead and reduces in JavaScript — a read that grows with the tenant.
 *
 * ROLE SCOPING IS ENTIRELY RLS. Those RPCs are SECURITY INVOKER, so
 * "hierarchy-aware lead visibility" runs inside them for the real
 * caller: an ADMIN aggregates the whole customer (including unassigned
 * deals), a MANAGER/SENIOR_SALES_REP their own branch of the org tree, a
 * SALES_REP just their own deals. There is not one role check on this
 * page, and none is wanted — see ForecastByRepTable's own note for why
 * the by-rep section is rendered for every role rather than hidden for
 * one.
 *
 * getVisibleTeamDirectory() is the single non-aggregate read, and it is
 * not used to decide which rows exist — only to put a display name on an
 * owner_id the by-rep rollup already returned.
 */
export default async function ForecastPage() {
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

  const [summary, stageRows, repRows, monthRows, owners] = await Promise.all([
    getForecastSummary(supabase),
    getForecastByStage(supabase),
    getForecastByRep(supabase),
    getForecastByMonth(supabase),
    getVisibleTeamDirectory(supabase),
  ]);

  // Same four accents, in the same order, as the Pipeline page's KPI row
  // (blue anchor -> violet -> emerald -> amber), and the same KpiCards
  // component — so the two pages read as one product rather than two.
  // Icons are rendered here, not passed as component references, because
  // KpiCards is a Client Component receiving these as props from a
  // Server Component.
  //
  // value is a raw number, never a pre-formatted string: KpiCards owns
  // the ₹/Indian-digit-grouping formatting (via the shared
  // currencyFormatter) so its count-up animation can interpolate the
  // underlying number and reformat each frame.
  const statCards: KpiCardData[] = [
    {
      label: "Weighted Forecast",
      value: summary.weightedForecast,
      format: "currency",
      caption: `${summary.openDealCount} open deal${summary.openDealCount === 1 ? "" : "s"}, probability-adjusted`,
      icon: <ForecastIcon className="h-4.5 w-4.5" />,
      accent: {
        gradient: "from-white to-blue-50",
        gradientHover: "hover:to-blue-100",
        iconBg: "bg-blue-50 group-hover:bg-blue-100",
        iconText: "text-blue-600",
        iconRing: "ring-blue-100",
        iconGlow: "shadow-md shadow-blue-200/70",
      },
    },
    {
      label: "Best Case",
      value: summary.bestCase,
      format: "currency",
      caption: "If every open deal closes",
      icon: <PipelineIcon className="h-4.5 w-4.5" />,
      accent: {
        gradient: "from-white to-violet-50",
        gradientHover: "hover:to-violet-100",
        iconBg: "bg-violet-50 group-hover:bg-violet-100",
        iconText: "text-violet-600",
        iconRing: "ring-violet-100",
        iconGlow: "shadow-md shadow-violet-200/70",
      },
    },
    {
      label: "Closed-Won To Date",
      value: summary.closedWonValue,
      format: "currency",
      caption: `${summary.closedWonCount} deal${summary.closedWonCount === 1 ? "" : "s"} won`,
      icon: <TargetIcon className="h-4.5 w-4.5" />,
      accent: {
        gradient: "from-white to-emerald-50",
        gradientHover: "hover:to-emerald-100",
        iconBg: "bg-emerald-50 group-hover:bg-emerald-100",
        iconText: "text-emerald-600",
        iconRing: "ring-emerald-100",
        iconGlow: "shadow-md shadow-emerald-200/70",
      },
    },
    {
      label: "Expected To Close This Month",
      value: summary.expectedThisMonthValue,
      format: "currency",
      caption: `${summary.expectedThisMonthCount} deal${summary.expectedThisMonthCount === 1 ? "" : "s"}, weighted`,
      icon: <TrendingUpIcon className="h-4.5 w-4.5" />,
      accent: {
        gradient: "from-white to-amber-50",
        gradientHover: "hover:to-amber-100",
        iconBg: "bg-amber-50 group-hover:bg-amber-100",
        iconText: "text-amber-600",
        iconRing: "ring-amber-100",
        iconGlow: "shadow-md shadow-amber-200/70",
      },
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Forecast</h1>
        <span
          aria-hidden="true"
          className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
        />
        <p className="mt-1.5 text-sm text-neutral-500">
          Weighted pipeline projections by stage and expected close month for{" "}
          {membership.customer.company_name ?? "your organization"}.
        </p>
      </div>

      <KpiCards cards={statCards} />

      <ForecastMonthlyChart months={monthRows} summary={summary} />

      <ForecastByStageTable rows={stageRows} />

      <ForecastByRepTable rows={repRows} owners={owners} />
    </div>
  );
}
