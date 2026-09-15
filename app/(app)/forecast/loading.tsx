import { Skeleton } from "@/components/shared/skeleton";
import { RouteLoadingIndicator } from "@/components/shared/navigation-progress";

/** ForecastPage builds exactly four KPI cards (Weighted Forecast / Best
 *  Case / Closed-Won To Date / Expected To Close This Month). */
const KPI_COUNT = 4;
/** One class per bar, so the placeholder reads as a chart rather than a
 *  solid block. Its length is the month count — matching
 *  FORECAST_MONTH_WINDOW in features/forecast/lib/get-forecast.ts, the
 *  number of month columns the real chart renders. Literal Tailwind
 *  classes, not computed strings, so the class scanner can find them.
 *
 *  Overdue is deliberately not reserved for: that bar only appears when
 *  there are overdue deals, so holding space for it would introduce
 *  exactly the layout shift this file exists to avoid (same reasoning as
 *  Contacts' duplicate-panel note). */
const BAR_HEIGHTS = ["h-24", "h-36", "h-20", "h-28", "h-14", "h-10"];
/** The six seeded default stages — the shape of the by-stage table for a
 *  customer who hasn't added any of their own. */
const STAGE_ROW_COUNT = 6;
const REP_ROW_COUNT = 4;

/**
 * Mirrors ForecastPage's shell: header → KPI row → monthly chart card →
 * by-stage table card → by-rep table card. The KPI grid reproduces
 * KpiCards' own responsive shape (horizontal scroll on mobile, 2-up at
 * md, 4-up at lg) so the row doesn't reflow when the real cards arrive.
 */
export default function ForecastLoading() {
  return (
    <div className="flex flex-col gap-6">
      <RouteLoadingIndicator />

      <div className="animate-pulse motion-reduce:animate-none">
        <div>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="mt-2 h-1 w-10 rounded-full" />
          <Skeleton className="mt-2.5 h-4 w-80 max-w-full" />
        </div>

        <div className="mt-6 flex gap-4 overflow-hidden md:grid md:grid-cols-2 md:gap-4 lg:grid-cols-4">
          {Array.from({ length: KPI_COUNT }).map((_, index) => (
            <div
              key={index}
              className="w-[85%] shrink-0 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 md:w-auto md:shrink"
            >
              <div className="flex items-center justify-between">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-10 w-10 rounded-xl" />
              </div>
              <Skeleton className="mt-4 h-8 w-36" />
              <Skeleton className="mt-2 h-3 w-24" />
            </div>
          ))}
        </div>

        {/* Monthly chart: label above each bar, the bar, month label
            below — matching MonthBar's three stacked pieces. */}
        <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
          <div className="flex items-baseline justify-between gap-2">
            <Skeleton className="h-5 w-72 max-w-[70%]" />
            <Skeleton className="h-3 w-24" />
          </div>
          <div className="mt-6 flex items-end gap-3">
            {BAR_HEIGHTS.map((height, index) => (
              <div key={index} className="flex flex-1 flex-col items-center gap-2">
                <Skeleton className="h-3 w-16" />
                <div className="flex h-40 w-full items-end justify-center">
                  <Skeleton className={`w-full max-w-16 rounded-t-lg ${height}`} />
                </div>
                <Skeleton className="h-3 w-10" />
              </div>
            ))}
          </div>
        </div>

        <TableSkeleton rowCount={STAGE_ROW_COUNT} columnCount={5} titleWidth="w-44" />
        <TableSkeleton rowCount={REP_ROW_COUNT} columnCount={4} titleWidth="w-36" />
      </div>
    </div>
  );
}

function TableSkeleton({
  rowCount,
  columnCount,
  titleWidth,
}: {
  rowCount: number;
  columnCount: number;
  titleWidth: string;
}) {
  return (
    <div className="mt-6 rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      <div className="flex items-baseline justify-between gap-2 px-6 pt-6 pb-4">
        <Skeleton className={`h-5 ${titleWidth}`} />
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="border-y border-neutral-100 bg-neutral-50/70 px-6 py-3">
        <Skeleton className="h-3 w-full" />
      </div>
      <div className="flex flex-col">
        {Array.from({ length: rowCount }).map((_, rowIndex) => (
          <div
            key={rowIndex}
            className="flex items-center gap-6 border-b border-neutral-100 px-6 py-3.5 last:border-0"
          >
            <Skeleton className="h-6 w-24 rounded-full" />
            {Array.from({ length: columnCount - 1 }).map((__, columnIndex) => (
              <Skeleton key={columnIndex} className="ml-auto h-4 w-20" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
