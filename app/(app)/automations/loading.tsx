import { Skeleton } from "@/components/shared/skeleton";
import { RouteLoadingIndicator } from "@/components/shared/navigation-progress";

const LIST_ROW_COUNT = 5;
const RUN_ROW_COUNT = 4;

/**
 * Mirrors AutomationsPage's shell: header + primary action → search and
 * list → the two-column activity/guidelines row.
 */
export default function AutomationsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <RouteLoadingIndicator />

      <div className="animate-pulse motion-reduce:animate-none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Skeleton className="h-8 w-48" />
            <Skeleton className="mt-2 h-1 w-10 rounded-full" />
            <Skeleton className="mt-2.5 h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-11 w-40 rounded-full" />
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-10 w-full rounded-lg sm:w-72" />
        </div>

        <div className="mt-3 divide-y divide-neutral-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          {Array.from({ length: LIST_ROW_COUNT }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3.5">
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-56 max-w-full" />
                  <Skeleton className="h-4 w-16 rounded-full" />
                </div>
                <Skeleton className="mt-1.5 h-3 w-72 max-w-full" />
                <Skeleton className="mt-1.5 h-3 w-40" />
              </div>
              <Skeleton className="h-3 w-10" />
            </div>
          ))}
        </div>

        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_400px]">
          <div>
            <Skeleton className="h-3 w-32" />
            <div className="mt-3 divide-y divide-neutral-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
              {Array.from({ length: RUN_ROW_COUNT }).map((_, index) => (
                <div key={index} className="flex items-start gap-3 px-4 py-3">
                  <Skeleton className="mt-1.5 h-2 w-2 rounded-full" />
                  <div className="flex-1">
                    <Skeleton className="h-4 w-64 max-w-full" />
                    <Skeleton className="mt-1.5 h-3 w-80 max-w-full" />
                  </div>
                  <Skeleton className="h-3 w-16" />
                </div>
              ))}
            </div>
          </div>

          <div>
            <Skeleton className="h-3 w-44" />
            <div className="mt-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-6">
              <Skeleton className="h-3 w-40" />
              <Skeleton className="mt-2.5 h-4 w-full" />
              <Skeleton className="mt-1.5 h-4 w-11/12" />
              <Skeleton className="mt-1.5 h-4 w-10/12" />
              <Skeleton className="mt-5 h-3 w-36" />
              <Skeleton className="mt-2.5 h-20 w-full rounded-lg" />
              <Skeleton className="mt-2 h-20 w-full rounded-lg" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
