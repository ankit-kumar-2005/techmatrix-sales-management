"use client";

import { useRouter, useSearchParams } from "next/navigation";

type ListPagerProps = {
  /** 1-based, already clamped by the caller. */
  page: number;
  pageCount: number;
  totalCount: number;
  /** Route to push to, e.g. "/automations". */
  basePath: string;
  /** Singular noun for the count, e.g. "automation". Pluralised with a
   *  trailing "s", which is all the nouns this app pages over need. */
  itemLabel: string;
  /** The URL query parameter this pager reads and writes. Defaults to
   *  "page" — every existing caller keeps that unchanged. Overridden
   *  when a single page hosts more than one paginated list (the
   *  automations page's own list already owns "page"; its Execution
   *  History section uses "runsPage" instead, so paging one never
   *  resets the other). */
  paramName?: string;
};

/**
 * Pagination as a URL, not as client state.
 *
 * A NEW SHARED PRIMITIVE, AND HONESTLY NOT YET THE ONLY ONE. This app
 * currently has the same control copy-implemented in five places
 * (ContactList, InvitationList, PipelineView, MeetingNotesPager,
 * TaskList), each welded to its own route, its own page-size options and
 * its own state mechanism. This is the generic version, parameterised by
 * `basePath`, so the sixth feature does not add a sixth copy.
 *
 * It deliberately does NOT retrofit the existing five in this pass. Each
 * of them is working and verified, two of them keep page state in
 * useState and drive a get*PageAction rather than the URL, and
 * converting those is a behaviour change to shipped features rather
 * than a lift-and-shift. That is a separate change with its own
 * testing, not a side effect of building automations.
 *
 * Visually identical to those five on purpose: same Previous/Next
 * buttons with real `disabled` attributes, same placement, same "Page x
 * of y" summary.
 */
export function ListPager({ page, pageCount, totalCount, basePath, itemLabel, paramName = "page" }: ListPagerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function goTo(nextPage: number) {
    const params = new URLSearchParams(searchParams.toString());
    // Page 1 is the default, so it is left out of the URL entirely.
    if (nextPage <= 1) params.delete(paramName);
    else params.set(paramName, String(nextPage));

    const query = params.toString();
    // scroll: false — paging should replace the list in place rather
    // than throw the reader back past the header they were already
    // looking at.
    router.push(query ? `${basePath}?${query}` : basePath, { scroll: false });
  }

  return (
    <div className="flex flex-col items-center justify-between gap-2 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5 sm:flex-row sm:px-5">
      <p className="text-xs font-medium text-neutral-600">
        Page {page} of {pageCount} &middot; {totalCount} {itemLabel}
        {totalCount === 1 ? "" : "s"}
      </p>

      {/* Always rendered, never conditionally removed — buttons that
          vanish read as "there is no pagination", whereas a real
          `disabled` attribute correctly makes the first and last pages
          unreachable and lets keyboard and screen-reader users skip
          them. */}
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => goTo(page - 1)}
          disabled={page <= 1}
          aria-label="Previous page"
          className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={() => goTo(page + 1)}
          disabled={page >= pageCount}
          aria-label="Next page"
          className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
