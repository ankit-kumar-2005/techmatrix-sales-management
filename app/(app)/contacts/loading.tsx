import { Skeleton } from "@/components/shared/skeleton";
import { RouteLoadingIndicator } from "@/components/shared/navigation-progress";

const ROW_COUNT = 6;

/**
 * Route-level fallback for /contacts. Mirrors ContactsPageClient's own
 * shell (header → toolbar → list card) so the skeleton occupies the same
 * boxes the real content lands in.
 *
 * Deliberately NO placeholder for the "Possible duplicate contacts"
 * panel: DuplicateContactsSection returns null when there are no pairs
 * (see its own early return), which is the common case — reserving space
 * for it here would introduce exactly the layout shift this file exists
 * to avoid.
 */
export default function ContactsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <RouteLoadingIndicator />

      <div className="animate-pulse motion-reduce:animate-none">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Skeleton className="h-8 w-44" />
            <Skeleton className="mt-2 h-1 w-10 rounded-full" />
            <Skeleton className="mt-3 h-4 w-80 max-w-full" />
          </div>
          <Skeleton className="h-10 w-full rounded-lg sm:w-36" />
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-start">
          <Skeleton className="h-10 w-full rounded-lg sm:min-w-[12rem] sm:flex-1" />
          <Skeleton className="h-10 w-full rounded-lg sm:w-72" />
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          <div className="flex flex-col gap-2.5 p-4 sm:p-5">
            {Array.from({ length: ROW_COUNT }).map((_, index) => (
              <div key={index} className="flex items-center gap-3 rounded-xl bg-neutral-50 p-4">
                <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-40 max-w-full" />
                  <Skeleton className="h-3 w-56 max-w-full" />
                </div>
                <Skeleton className="hidden h-5 w-24 rounded-full sm:block" />
              </div>
            ))}
          </div>
        </div>

        <div className="mt-4 flex flex-col items-center justify-between gap-3 sm:flex-row">
          <Skeleton className="h-8 w-40" />
          <Skeleton className="h-8 w-48" />
        </div>
      </div>
    </div>
  );
}
