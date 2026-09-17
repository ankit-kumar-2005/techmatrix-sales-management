"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "@/features/sales-management/components/icons";

type MeetingNotesSearchProps = {
  /** The term currently in the URL, so a refresh or a shared link lands
   *  on the same filtered view with the box already filled in. */
  initialSearch: string;
};

/** Same 300ms as ContactList's and TaskList's own SEARCH_DEBOUNCE_MS.
 *  Reused rather than re-tuned so typing feels identical across the
 *  app — and because every keystroke here is a real server round trip. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Search as a URL parameter, debounced.
 *
 * WHY URL AND NOT useState: the Recent Notes list is a Server Component
 * and the search has to run in the database (title, summary AND attendee
 * names, the last of which needs the search_meeting_notes RPC). Putting
 * the term in the query string keeps the whole list server-rendered, so
 * no note data is ever fetched into the browser to be filtered there —
 * which is the specific mistake this project already paid for once.
 *
 * The input's styling and the search glyph are lifted from ContactList's
 * own search box: same height, same border and focus ring, same
 * absolutely-positioned icon that tints on focus-within. Only the
 * mechanism underneath differs.
 *
 * router.replace, not push: typing five characters should not put five
 * entries in the back stack. This mirrors the intent of the
 * history.replaceState that ContactList uses to mirror its own search
 * into the URL.
 *
 * scroll: false so the page does not jump to the top on every keystroke
 * — the results are below the fold the user is already looking at.
 */
export function MeetingNotesSearch({ initialSearch }: MeetingNotesSearchProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialSearch);

  /** The term already reflected in the URL. Compared against the
   *  debounced value so this never navigates to the URL it is already
   *  on — which would otherwise fire once on mount and again after every
   *  server re-render. */
  const appliedRef = useRef(initialSearch);

  useEffect(() => {
    const timer = setTimeout(() => {
      const next = value.trim();
      if (next === appliedRef.current.trim()) return;
      appliedRef.current = next;

      const params = new URLSearchParams(searchParams.toString());
      if (next) params.set("q", next);
      else params.delete("q");

      // CHANGING THE SEARCH RESETS TO PAGE 1. Page 4 of the unfiltered
      // list is meaningless once the result set changes under it, and
      // landing on an empty page would read as "no matches" when there
      // are plenty on page 1.
      params.delete("page");

      const query = params.toString();
      router.replace(query ? `/meeting-notes?${query}` : "/meeting-notes", { scroll: false });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [value, router, searchParams]);

  return (
    <div className="group relative w-full">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-sky-500" />
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label="Search meeting notes"
        placeholder="Search notes by title, summary, or attendee..."
        className="h-10 w-full rounded-lg border border-neutral-300 bg-white pl-10 text-sm text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
      />
    </div>
  );
}
