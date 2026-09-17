import { Skeleton } from "@/components/shared/skeleton";
import { RouteLoadingIndicator } from "@/components/shared/navigation-progress";

/** Two cards, not ten. The real page fetches up to PAGE_SIZE notes, but
 *  reserving ten card-heights on a first visit — which for most tenants
 *  will render the empty state instead — would leave a screen of grey
 *  boxes collapsing to nothing. Two is enough to read as "a list is
 *  loading" without overcommitting to a height the content may not have.
 *  Same judgement as the Contacts duplicate panel and the Forecast
 *  Overdue bar: reserve space only for what is probably there. */
/** Now that notes are COLLAPSED by default, a row is short — so
 *  reserving more of them costs little and matches what actually
 *  renders. The first is drawn expanded because the newest note on page
 *  1 auto-expands. */
const COLLAPSED_ROW_COUNT = 4;
const ITEMS_IN_EXPANDED_CARD = 3;

/**
 * Mirrors MeetingNotesPage's shell: header → the paste/upload card →
 * the notes list.
 *
 * NOTE THIS IS THE ROUTE-LEVEL fallback, shown while the page's own
 * queries run. It is NOT the extraction loading state — extraction
 * happens inside a Server Action after the page is already interactive,
 * and MeetingNotesForm's own pending hint covers that (a free-tier model
 * takes 10s+, measured). The two are different waits and neither
 * substitutes for the other.
 */
export default function MeetingNotesLoading() {
  return (
    <div className="flex flex-col gap-6">
      <RouteLoadingIndicator />

      <div className="animate-pulse motion-reduce:animate-none">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-1 w-10 rounded-full" />
          <Skeleton className="mt-2.5 h-4 w-72 max-w-full" />
        </div>

        {/* The paste/upload card: mode toggle, label, textarea, hint,
            button — matching MeetingNotesForm's own default (Text) shape. */}
        <div className="mt-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
          <Skeleton className="h-10 w-56 rounded-full" />
          <Skeleton className="mt-5 h-4 w-28" />
          <Skeleton className="mt-1.5 h-44 w-full rounded-lg" />
          <Skeleton className="mt-1.5 h-3 w-48" />
          <Skeleton className="mt-4 h-11 w-52 rounded-full" />
        </div>

        <div className="mt-6 flex items-baseline justify-between gap-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>

        <div className="mt-4 flex flex-col gap-4">
          {/* The first card, expanded — title row with pills, meta line,
              snippet, the tinted summary block, then the checklist. */}
          <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-56 max-w-[45%]" />
              <Skeleton className="h-4 w-20 rounded-full" />
              <Skeleton className="h-4 w-24 rounded-full" />
            </div>
            <Skeleton className="mt-1.5 h-3 w-72 max-w-full" />
            <Skeleton className="mt-4 h-20 w-full rounded-xl" />
            <div className="mt-4 flex flex-col gap-3">
              {Array.from({ length: ITEMS_IN_EXPANDED_CARD }).map((_, itemIndex) => (
                <div key={itemIndex} className="flex items-center gap-3">
                  <Skeleton className="h-4 w-4 shrink-0 rounded" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-16 shrink-0 rounded-full" />
                </div>
              ))}
            </div>
            <Skeleton className="mt-4 h-3 w-56" />
          </div>

          {/* The rest, collapsed: title row, meta line, one-line
              snippet. Nothing else is visible until expanded. */}
          {Array.from({ length: COLLAPSED_ROW_COUNT }).map((_, rowIndex) => (
            <div key={rowIndex} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-48 max-w-[40%]" />
                <Skeleton className="h-4 w-20 rounded-full" />
                <Skeleton className="h-4 w-24 rounded-full" />
              </div>
              <Skeleton className="mt-1.5 h-3 w-64 max-w-full" />
              <Skeleton className="mt-1.5 h-4 w-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
