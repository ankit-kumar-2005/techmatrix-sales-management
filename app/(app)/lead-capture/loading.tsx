import { Skeleton } from "@/components/shared/skeleton";
import { RouteLoadingIndicator } from "@/components/shared/navigation-progress";

/** One source this phase — the grid reserves a single card so the row
 *  doesn't reflow when the real one arrives. */
const SOURCE_COUNT = 1;
const RECENT_ROW_COUNT = 5;

/**
 * Mirrors LeadCapturePage's shell: header → connected-sources grid →
 * connection panel → capture-rules panel → recently-captured list.
 *
 * The connected state is what is skeletoned, since that is what a
 * configured tenant sees on every visit. A tenant who has not connected
 * yet sees a shorter page, which settles upward — the less disruptive
 * direction, and only once.
 */
export default function LeadCaptureLoading() {
  return (
    <div className="flex flex-col gap-6">
      <RouteLoadingIndicator />

      <div className="animate-pulse motion-reduce:animate-none">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-1 w-10 rounded-full" />
          <Skeleton className="mt-2.5 h-4 w-96 max-w-full" />
        </div>

        <Skeleton className="mt-6 h-3 w-36" />
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: SOURCE_COUNT }).map((_, index) => (
            <div key={index} className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5">
              <div className="flex items-start gap-3">
                <Skeleton className="h-10 w-10 rounded-xl" />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-5 w-24" />
                    <Skeleton className="h-4 w-20 rounded-full" />
                  </div>
                  <Skeleton className="mt-2 h-4 w-full" />
                </div>
              </div>
              <div className="mt-4 flex gap-6">
                <div>
                  <Skeleton className="h-7 w-8" />
                  <Skeleton className="mt-1 h-3 w-10" />
                </div>
                <div>
                  <Skeleton className="h-7 w-8" />
                  <Skeleton className="mt-1 h-3 w-16" />
                </div>
              </div>
              <Skeleton className="mt-4 h-3 w-44" />
            </div>
          ))}
        </div>

        {/* Connection: URL row + copy button, then the boxed setup steps. */}
        <Skeleton className="mt-6 h-3 w-24" />
        <div className="mt-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-6">
          <Skeleton className="h-4 w-40" />
          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
            <Skeleton className="h-10 flex-1 rounded-lg" />
            <Skeleton className="h-10 w-44 rounded-full" />
          </div>
          <Skeleton className="mt-1.5 h-3 w-80 max-w-full" />
          <div className="mt-4 rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
            <Skeleton className="h-3 w-44" />
            <Skeleton className="mt-2.5 h-4 w-full" />
            <Skeleton className="mt-1.5 h-4 w-11/12" />
            <Skeleton className="mt-1.5 h-4 w-10/12" />
          </div>
          <div className="mt-4 flex gap-2">
            <Skeleton className="h-10 w-36 rounded-full" />
            <Skeleton className="h-10 w-40 rounded-full" />
          </div>
        </div>

        {/* Capture rules: two FormSections, then the save button. */}
        <Skeleton className="mt-6 h-3 w-28" />
        <div className="mt-3 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-6">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="mt-3 h-4 w-28" />
          <Skeleton className="mt-1.5 h-11 w-full rounded-lg" />
          <Skeleton className="mt-6 h-3 w-32" />
          <Skeleton className="mt-3 h-4 w-24" />
          <Skeleton className="mt-1.5 h-11 w-full rounded-lg" />
          <Skeleton className="mt-4 h-4 w-32" />
          <Skeleton className="mt-1.5 h-11 w-full rounded-lg" />
          <div className="mt-5 flex justify-end">
            <Skeleton className="h-11 w-44 rounded-full" />
          </div>
        </div>

        <Skeleton className="mt-6 h-3 w-36" />
        <div className="mt-3 divide-y divide-neutral-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          {Array.from({ length: RECENT_ROW_COUNT }).map((_, index) => (
            <div key={index} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-2 w-2 rounded-full" />
              <div className="flex-1">
                <Skeleton className="h-4 w-64 max-w-full" />
                <Skeleton className="mt-1.5 h-3 w-48 max-w-full" />
              </div>
              <Skeleton className="h-3 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
