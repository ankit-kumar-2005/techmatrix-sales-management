import { Skeleton } from "@/components/shared/skeleton";
import { RouteLoadingIndicator } from "@/components/shared/navigation-progress";

/** Overdue / Today / Upcoming — the three buckets TasksPage renders when
 *  no specific due-date filter is active, which is the default and so the
 *  right shape to reserve space for. */
const BUCKET_COUNT = 3;
const ROWS_PER_BUCKET = 3;

/** Mirrors TasksPageClient's shell: header → filter toolbar → one card
 *  per visible due-date bucket. */
export default function TasksLoading() {
  return (
    <div className="flex flex-col gap-6">
      <RouteLoadingIndicator />

      <div className="animate-pulse motion-reduce:animate-none">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Skeleton className="h-8 w-56" />
            <Skeleton className="mt-2 h-1 w-10 rounded-full" />
            <Skeleton className="mt-3 h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-10 w-full rounded-lg sm:w-32" />
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Skeleton className="h-10 w-full rounded-lg sm:min-w-[12rem] sm:flex-1" />
          <Skeleton className="h-10 w-full rounded-lg sm:w-44" />
          <Skeleton className="h-10 w-full rounded-lg sm:w-36" />
          <Skeleton className="h-10 w-full rounded-lg sm:w-36" />
        </div>

        <div className="mt-6 flex flex-col gap-6">
          {Array.from({ length: BUCKET_COUNT }).map((_, bucketIndex) => (
            <div
              key={bucketIndex}
              className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5"
            >
              <div className="flex items-center justify-between gap-3 border-b border-neutral-100 p-4 sm:p-5">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-5 w-10 rounded-full" />
              </div>
              <div className="flex flex-col gap-2.5 p-4 sm:p-5">
                {Array.from({ length: ROWS_PER_BUCKET }).map((_, rowIndex) => (
                  <div key={rowIndex} className="flex items-center gap-3 rounded-xl bg-neutral-50 p-4">
                    <Skeleton className="h-4 w-4 shrink-0 rounded" />
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                      <Skeleton className="h-4 w-52 max-w-full" />
                      <Skeleton className="h-3 w-36 max-w-full" />
                    </div>
                    <Skeleton className="hidden h-5 w-16 rounded-full sm:block" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
