import { currencyFormatter } from "@/utils/format";
import type { ForecastMonthRow, ForecastSummary } from "../lib/get-forecast";

type ForecastMonthlyChartProps = {
  months: ForecastMonthRow[];
  summary: ForecastSummary;
};

/** Minimum visible height for a non-zero bar, as a percentage of the
 *  plot area. Without it, a small month next to a very large one renders
 *  as a 1px sliver indistinguishable from an empty month — a bar that
 *  represents real money must always be visible as a bar. */
const MIN_BAR_PERCENT = 2;

/** A month label needs no year most of the time, but a 6-month window
 *  can cross a year boundary, where "Jan" alone is genuinely ambiguous.
 *  Year is added only when the window actually spans two of them. */
const monthLabelFormatter = new Intl.DateTimeFormat("en-IN", { month: "short" });
const monthYearLabelFormatter = new Intl.DateTimeFormat("en-IN", { month: "short", year: "2-digit" });

/** Parsed at UTC noon, not local midnight: monthStart is a plain
 *  yyyy-mm-dd from a Postgres date column, and new Date("2026-09-01") is
 *  parsed as UTC midnight — which in a negative-offset timezone renders
 *  as the PREVIOUS month. Noon has no such edge. */
function parseMonthStart(monthStart: string): Date {
  return new Date(`${monthStart}T12:00:00Z`);
}

/**
 * The weighted-forecast-by-month bar chart.
 *
 * NO CHARTING LIBRARY, deliberately: this project has none installed,
 * and the existing "Leads By Stage" bar is hand-rolled from divs for the
 * same reason. A single-series column chart does not justify a new
 * runtime dependency, and building it this way keeps the whole chart a
 * Server Component — zero client JS.
 *
 * COLORS come from this app's own primary thread (the blue -> violet
 * gradient already used for the sidebar's active nav item, the New Lead
 * button and every form submit), not the reference mockup's teal. The
 * one exception is the Overdue bucket, which is amber: it is not part of
 * the forward-looking series and reads as a warning because that is what
 * it is.
 *
 * THREE HONESTY RULES this layout enforces:
 *   1. Overdue gets its OWN leading bar, divider-separated. A slipped
 *      date is a different situation from a missing one, and the more
 *      actionable of the two, so it belongs on the chart rather than in
 *      a footnote.
 *   2. Undated open deals cannot be placed on a time axis at all, so
 *      they are reported in the caption below.
 *   3. Deals beyond the window are reported there too, so the bars
 *      ending never implies the pipeline does.
 */
export function ForecastMonthlyChart({ months, summary }: ForecastMonthlyChartProps) {
  const overdue = months.find((row) => row.bucket === "OVERDUE");
  const later = months.find((row) => row.bucket === "LATER");
  const monthRows = months.filter((row) => row.bucket === "MONTH");

  const showOverdue = Boolean(overdue && overdue.openDealCount > 0);

  // The scale includes Overdue so the two are directly comparable — a
  // per-bucket scale would make an overdue pile look the same size as a
  // modest month.
  const plottedRows = showOverdue && overdue ? [overdue, ...monthRows] : monthRows;
  const maxValue = Math.max(0, ...plottedRows.map((row) => row.weightedValue));

  const spansMultipleYears =
    new Set(
      monthRows
        .map((row) => (row.monthStart ? parseMonthStart(row.monthStart).getUTCFullYear() : null))
        .filter((year): year is number => year !== null),
    ).size > 1;

  function barHeightPercent(value: number): number {
    if (maxValue <= 0 || value <= 0) return 0;
    return Math.max(MIN_BAR_PERCENT, (value / maxValue) * 100);
  }

  const caveats: string[] = [];
  if (summary.undatedOpenCount > 0) {
    caveats.push(
      `${summary.undatedOpenCount} open deal${summary.undatedOpenCount === 1 ? " has" : "s have"} no expected close date`,
    );
  }
  if (later && later.openDealCount > 0) {
    caveats.push(
      `${later.openDealCount} deal${later.openDealCount === 1 ? "" : "s"} expected beyond this window (${currencyFormatter.format(later.weightedValue)} weighted)`,
    );
  }

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-neutral-900">Weighted Forecast By Expected Close Month</h2>
        <span className="text-xs font-medium text-neutral-500">
          Next {monthRows.length} month{monthRows.length === 1 ? "" : "s"}
        </span>
      </div>

      {plottedRows.length === 0 || maxValue <= 0 ? (
        <p className="mt-6 rounded-xl bg-neutral-50 px-4 py-8 text-center text-sm text-neutral-500 ring-1 ring-neutral-100">
          No open deals have an expected close date yet. Set one on a deal to see it forecast here.
        </p>
      ) : (
        /* overflow-x-auto so a 6-month window stays readable on a phone
           instead of crushing every column to a few pixels — the same
           pattern the Pipeline board already uses for its columns. */
        <div className="mt-6 overflow-x-auto">
          <div className="flex min-w-[520px] items-end gap-3">
            {showOverdue && overdue ? (
              <>
                <MonthBar
                  label="Overdue"
                  sublabel={`${overdue.openDealCount} deal${overdue.openDealCount === 1 ? "" : "s"}`}
                  value={overdue.weightedValue}
                  heightPercent={barHeightPercent(overdue.weightedValue)}
                  tone="overdue"
                />
                {/* Marks Overdue as sitting outside the forward-looking
                    series rather than merely being its first column. */}
                <div aria-hidden="true" className="mb-14 h-28 w-px shrink-0 bg-neutral-200" />
              </>
            ) : null}

            {monthRows.map((row) => {
              const date = row.monthStart ? parseMonthStart(row.monthStart) : null;
              return (
                <MonthBar
                  key={row.monthStart ?? "unknown"}
                  label={
                    date ? (spansMultipleYears ? monthYearLabelFormatter : monthLabelFormatter).format(date) : "—"
                  }
                  sublabel={`${row.openDealCount} deal${row.openDealCount === 1 ? "" : "s"}`}
                  value={row.weightedValue}
                  heightPercent={barHeightPercent(row.weightedValue)}
                  tone="month"
                />
              );
            })}
          </div>
        </div>
      )}

      {caveats.length > 0 ? (
        <p className="mt-5 border-t border-neutral-100 pt-4 text-xs leading-relaxed text-neutral-500">
          Not shown above: {caveats.join("; ")}. These are still counted in Weighted Forecast and Best Case.
        </p>
      ) : null}
    </div>
  );
}

type MonthBarProps = {
  label: string;
  sublabel: string;
  value: number;
  heightPercent: number;
  tone: "month" | "overdue";
};

function MonthBar({ label, sublabel, value, heightPercent, tone }: MonthBarProps) {
  const isEmpty = value <= 0;

  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-2">
      <span className={`text-xs font-semibold tabular-nums ${isEmpty ? "text-neutral-300" : "text-neutral-700"}`}>
        {isEmpty ? "—" : currencyFormatter.format(value)}
      </span>

      <div className="flex h-40 w-full items-end justify-center">
        <div
          aria-hidden="true"
          className={`w-full max-w-16 rounded-t-lg ${
            isEmpty
              ? "bg-neutral-100"
              : tone === "overdue"
                ? "bg-amber-500"
                : "bg-gradient-to-t from-blue-600 to-violet-500"
          }`}
          style={{ height: isEmpty ? "4px" : `${heightPercent}%` }}
        />
      </div>

      <div className="flex flex-col items-center text-center">
        <span className={`text-xs font-medium ${tone === "overdue" ? "text-amber-700" : "text-neutral-600"}`}>
          {label}
        </span>
        <span className="text-[11px] text-neutral-400">{sublabel}</span>
      </div>
    </div>
  );
}
