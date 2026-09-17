"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { MEETING_NOTES_PAGE_SIZE_OPTIONS } from "../constants";

type MeetingNotesPagerProps = {
  /** 0-based, already clamped by the page. */
  currentPage: number;
  pageCount: number;
  pageSize: number;
  totalCount: number;
};

/**
 * Pagination as a URL, not as client state.
 *
 * WHY THIS DIFFERS FROM CONTACTS/TASKS, deliberately: those hold page
 * and pageSize in useState and call a get*PageAction, which means the
 * whole list has to be a Client Component. Here the list is a Server
 * Component (the cards resolve fuzzy assignee matches with fuse.js
 * server-side, among other things), so the page number travels in the
 * query string instead and the server does the bounded query on
 * navigation. Same server-side LIMIT either way — .range() in
 * getMeetingNotesPage — just reached through the URL.
 *
 * The visible control is deliberately IDENTICAL to Contacts' and Tasks':
 * same "Rows Per Page" label, same 10/15/20 options, same Previous/Next
 * buttons with real `disabled` attributes, same placement below the
 * list. Only the mechanism underneath changed.
 *
 * Two things the URL buys that useState does not: a note list is
 * shareable and bookmarkable, and the browser Back button steps through
 * pages instead of leaving the app.
 *
 * scroll: false on every push — paging should replace the list in place,
 * not throw the reader back to the top of the page past the
 * paste/upload form.
 */
export function MeetingNotesPager({ currentPage, pageCount, pageSize, totalCount }: MeetingNotesPagerProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function pushParams(next: { page?: number; size?: number }) {
    const params = new URLSearchParams(searchParams.toString());

    if (next.size !== undefined) {
      params.set("size", String(next.size));
      // Changing the page size invalidates the current page number: page
      // 3 of 10-per-page does not exist at 20-per-page. Reset rather
      // than land the user on an empty page.
      params.delete("page");
    }
    if (next.page !== undefined) {
      // Page 1 is the default, so it is left out of the URL entirely —
      // "?page=0" is noise a user might see and wonder about.
      if (next.page <= 0) params.delete("page");
      else params.set("page", String(next.page));
    }

    const query = params.toString();
    router.push(query ? `/meeting-notes?${query}` : "/meeting-notes", { scroll: false });
  }

  return (
    <div className="flex flex-col items-center justify-between gap-2 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5 sm:flex-row sm:px-5">
      <div className="flex items-center gap-2 text-xs text-neutral-500">
        <label htmlFor="meeting-notes-rows-per-page">Rows Per Page</label>
        <select
          id="meeting-notes-rows-per-page"
          value={pageSize}
          onChange={(event) => pushParams({ size: Number(event.target.value) })}
          className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
        >
          {MEETING_NOTES_PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center gap-3">
        <p className="text-xs font-medium text-neutral-600">
          Page {currentPage + 1} of {pageCount} &middot; {totalCount} note{totalCount === 1 ? "" : "s"}
        </p>
        {/* Always rendered, never conditionally removed — the same
            reasoning ContactList's own pager carries: buttons that
            vanish read as "no way to paginate", whereas a real
            `disabled` attribute correctly makes the first/last page
            unreachable and lets keyboard and screen-reader users skip
            them. */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => pushParams({ page: currentPage - 1 })}
            disabled={currentPage === 0}
            aria-label="Previous page"
            className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => pushParams({ page: currentPage + 1 })}
            disabled={currentPage >= pageCount - 1}
            aria-label="Next page"
            className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
