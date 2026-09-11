import { Skeleton } from "@/components/shared/skeleton";
import { RouteLoadingIndicator } from "@/components/shared/navigation-progress";

/** Matches INITIAL_PAGE_SIZE in app/(app)/catalog/page.tsx — the number
 *  of cards the first real page actually renders. */
const CARD_COUNT = 6;

/**
 * Mirrors CatalogPageClient's shell: header (no gradient underline on
 * this page, unlike Contacts/Tasks/Pipeline) → filter toolbar card →
 * responsive card grid.
 */
export default function CatalogLoading() {
  return (
    <div className="flex flex-col gap-6">
      <RouteLoadingIndicator />

      <div className="animate-pulse motion-reduce:animate-none">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <Skeleton className="h-8 w-72 max-w-full" />
            <Skeleton className="mt-3 h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-11 w-full rounded-full sm:w-36" />
        </div>

        <div className="mt-6 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          <div className="border-b border-neutral-100 p-4 sm:p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Skeleton className="h-10 w-full rounded-lg sm:min-w-[10rem] sm:flex-1" />
              <Skeleton className="h-10 w-full rounded-lg sm:w-44" />
              <Skeleton className="h-10 w-full rounded-lg sm:w-20" />
            </div>
          </div>

          <div className="p-4 sm:p-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: CARD_COUNT }).map((_, index) => (
                <div
                  key={index}
                  className="flex h-full flex-col overflow-hidden rounded-2xl border-l-[3px] border-l-neutral-200 bg-white shadow-sm ring-1 ring-neutral-200"
                >
                  <div className="flex flex-1 flex-col p-6">
                    <div className="flex items-start justify-between gap-2">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="h-5 w-16 rounded-full" />
                    </div>
                    <Skeleton className="mt-3 h-5 w-40 max-w-full" />
                    <Skeleton className="mt-2 h-3 w-full" />
                    <Skeleton className="mt-1.5 h-3 w-3/4" />
                  </div>
                  <div className="mt-auto flex items-end justify-between gap-3 border-t border-neutral-100 bg-neutral-50/60 px-6 py-4">
                    <Skeleton className="h-7 w-28" />
                    <Skeleton className="h-3 w-16" />
                  </div>
                </div>
              ))}
            </div>
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
