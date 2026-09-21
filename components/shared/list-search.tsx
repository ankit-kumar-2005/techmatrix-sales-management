"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { SearchIcon } from "@/features/sales-management/components/icons";

type ListSearchProps = {
  /** The term currently in the URL, so a refresh or a shared link lands
   *  on the same filtered view with the box already filled in. */
  initialSearch: string;
  basePath: string;
  placeholder: string;
  label: string;
};

/** The same 300ms every other search box in this app already uses
 *  (ContactList, TaskList, MeetingNotesSearch). Reused rather than
 *  re-tuned so typing feels identical across the product — and because
 *  every keystroke here is a real server round trip. */
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Search as a URL parameter, debounced. The generic counterpart to
 * ListPager — see that file for why this is a new primitive rather than
 * a refactor of the existing per-feature copies.
 *
 * URL RATHER THAN useState because the list it filters is a Server
 * Component, so the filtering happens in the database and no row is
 * ever shipped to the browser to be filtered there.
 *
 * router.replace, not push: typing five characters should not put five
 * entries in the back stack.
 */
export function ListSearch({ initialSearch, basePath, placeholder, label }: ListSearchProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(initialSearch);

  /** The term already reflected in the URL. Compared against the
   *  debounced value so this never navigates to the URL it is already
   *  on — which would otherwise fire once on mount and again after
   *  every server re-render. */
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
      router.replace(query ? `${basePath}?${query}` : basePath, { scroll: false });
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [value, router, searchParams, basePath]);

  return (
    <div className="group relative w-full">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-sky-500" />
      <input
        type="search"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        aria-label={label}
        placeholder={placeholder}
        className="h-10 w-full rounded-lg border border-neutral-300 bg-white pl-10 text-sm text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
      />
    </div>
  );
}
