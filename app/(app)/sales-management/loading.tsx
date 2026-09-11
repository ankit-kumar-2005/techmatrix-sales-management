import { Skeleton } from "@/components/shared/skeleton";
import { RouteLoadingIndicator } from "@/components/shared/navigation-progress";

/** SalesManagementPage builds exactly four KPI cards (Open Pipeline
 *  Value / Qualified & Proposal / Win Rate / Avg. Closed-Won). */
const KPI_COUNT = 4;
const TABLE_ROW_COUNT = 8;

/**
 * Mirrors the Pipeline page's shell: header → KPI row → "Leads by stage"
 * card → the List/Board view card. The KPI grid reproduces KpiCards' own
 * responsive shape (horizontal scroll on mobile, 2-up at md, 4-up at lg)
 * so the row doesn't reflow when the real cards arrive.
 */
export default function SalesManagementLoading() {
  return (
    <div className="flex flex-col gap-6">
      <RouteLoadingIndicator />

      <div className="animate-pulse motion-reduce:animate-none">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Skeleton className="h-8 w-52" />
            <Skeleton className="mt-2 h-1 w-10 rounded-full" />
            <Skeleton className="mt-3 h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-11 w-full rounded-full sm:w-36" />
        </div>

        <div className="mt-6 flex gap-4 overflow-hidden pb-1 md:grid md:grid-cols-2 md:overflow-visible md:pb-0 lg:grid-cols-4">
          {Array.from({ length: KPI_COUNT }).map((_, index) => (
            <div
              key={index}
              className="w-[85%] shrink-0 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 md:w-auto md:shrink"
            >
              <div className="flex items-start justify-between gap-3">
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-9 w-9 rounded-xl" />
              </div>
              <Skeleton className="mt-4 h-8 w-32 max-w-full" />
              <Skeleton className="mt-2 h-3 w-24" />
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
          <Skeleton className="h-4 w-32" />
          <div className="mt-4 flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="flex items-center gap-3">
                <Skeleton className="h-3 w-24 shrink-0" />
                <Skeleton className="h-2.5 flex-1 rounded-full" />
                <Skeleton className="h-3 w-8 shrink-0" />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          <div className="flex flex-col gap-3 border-b border-neutral-100 p-4 sm:flex-row sm:items-center sm:p-5">
            <Skeleton className="h-10 w-full rounded-lg sm:min-w-[12rem] sm:flex-1" />
            <Skeleton className="h-10 w-full rounded-lg sm:w-40" />
            <Skeleton className="h-10 w-full rounded-lg sm:w-40" />
          </div>
          <div className="flex flex-col gap-2.5 p-4 sm:p-5">
            {Array.from({ length: TABLE_ROW_COUNT }).map((_, index) => (
              <div key={index} className="flex items-center gap-3 rounded-xl bg-neutral-50 p-4">
                <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-44 max-w-full" />
                  <Skeleton className="h-3 w-32 max-w-full" />
                </div>
                <Skeleton className="hidden h-5 w-20 rounded-full sm:block" />
                <Skeleton className="hidden h-4 w-20 md:block" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
