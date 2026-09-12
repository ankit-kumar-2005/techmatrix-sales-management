"use client";

import { useEffect, useRef, useState } from "react";
import { CatalogItemCard } from "./catalog-item-card";
import { NewCatalogItemDialog } from "./new-catalog-item-dialog";
import { ChevronDownIcon, SearchIcon } from "@/features/sales-management/components/icons";
import { getCatalogItemsPageAction } from "../actions";
import type { CatalogItemListItem } from "../lib/get-catalog-items";

const PAGE_SIZE_OPTIONS = [3, 6, 9] as const;
const SEARCH_DEBOUNCE_MS = 300;

const controlClass =
  "h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";
const selectControlClass = `${controlClass} w-full appearance-none pr-9`;

type CatalogItemsGridProps = {
  /** Page 1, unfiltered, at the default page size — fetched once by the
   *  Server Component (app/(app)/catalog/page.tsx) so first paint has
   *  no loading flash. Every subsequent search/filter/page-size/page
   *  change is fetched by this component itself, server-side, via
   *  getCatalogItemsPageAction — never a client-side slice of a fully
   *  loaded table (see that action's own comment on why this needed to
   *  become a real Supabase .range()/.count() query once a catalog can
   *  hold hundreds of items). */
  initialItems: CatalogItemListItem[];
  initialTotalCount: number;
  /** Every distinct category value this customer's catalog currently
   *  uses — fetched once server-side (category is free text, not a
   *  fixed enum, so this can't be a hardcoded option list). Not kept
   *  live-refreshed if someone types a brand-new category while
   *  creating/editing an item — a known, minor limitation, not a data
   *  problem: the new item itself is still fully visible either way. */
  categories: string[];
  canManage: boolean;
  /** Bumped by the page-level "+ Add item" dialog's onSuccess (owned by
   *  the shared client ancestor, CatalogPageClient, since that button
   *  now lives in the page HEADER — top-right, next to the heading —
   *  not inside this component's own toolbar) — forces a re-fetch of
   *  whatever this grid is currently showing, so a newly created item
   *  shows up without the user navigating away and back. Unlike the
   *  internal refreshToken below, this one never resets search/category/
   *  page — see CatalogPageClient's own comment on that tradeoff. */
  externalRefreshToken: number;
};

export function CatalogItemsGrid({
  initialItems,
  initialTotalCount,
  categories,
  canManage,
  externalRefreshToken,
}: CatalogItemsGridProps) {
  const [items, setItems] = useState(initialItems);
  const [totalCount, setTotalCount] = useState(initialTotalCount);
  const [isLoading, setIsLoading] = useState(false);

  const [searchInput, setSearchInput] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [pageSize, setPageSize] = useState<number>(6);
  const [page, setPage] = useState(0);
  // Bumped to force a re-fetch of the CURRENT query (e.g. after editing
  // or toggling an item's status) even when none of the query's own
  // parameters (search/category/page/pageSize) actually changed.
  const [refreshToken, setRefreshToken] = useState(0);

  const hasActiveFilters = Boolean(searchInput || category);

  // Debounce: only the committed value drives an actual fetch, so
  // typing doesn't hit the server on every keystroke. Resets to page 1
  // only when the debounced value actually changes (not on mount, where
  // both start equal).
  useEffect(() => {
    const timer = setTimeout(() => {
      setCommittedSearch((current) => {
        if (current === searchInput) return current;
        setPage(0);
        return searchInput;
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Skips the very first run — the server already fetched exactly
  // page 1 / no filters / the default page size, so re-fetching that
  // same query again on mount would be redundant.
  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    getCatalogItemsPageAction({ search: committedSearch, category, page, pageSize }).then((result) => {
      if (cancelled) return;
      setItems(result.items);
      setTotalCount(result.totalCount);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [committedSearch, category, page, pageSize, refreshToken, externalRefreshToken]);

  const pageCount = Math.max(Math.ceil(totalCount / pageSize), 1);
  const currentPage = Math.min(page, pageCount - 1);

  function handleCategoryChange(value: string) {
    setCategory(value);
    setPage(0);
  }

  function handlePageSizeChange(value: number) {
    setPageSize(value);
    setPage(0);
  }

  function handleReset() {
    setSearchInput("");
    setCommittedSearch("");
    setCategory("");
    setPage(0);
  }

  // A newly created item might not match the current search/category
  // filter at all, so creating one resets both to defaults (in addition
  // to jumping to page 1) — the same "reset filters and page" pattern
  // for both entry points (the header button and the grid's own ghost
  // card), since both render through this one callback.
  function handleItemCreated() {
    setSearchInput("");
    setCommittedSearch("");
    setCategory("");
    setPage(0);
    setRefreshToken((token) => token + 1);
  }

  // Editing or (de)activating an item never changes which page/filter
  // the user is looking at — just refreshes the current query in place.
  function handleItemChanged() {
    setRefreshToken((token) => token + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
        <div className="border-b border-neutral-100 p-4 sm:overflow-x-auto sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-nowrap sm:items-center sm:gap-3">
            <div className="group relative w-full sm:min-w-[10rem] sm:flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-sky-500" />
              <input
                type="text"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search catalog items..."
                className={`${controlClass} w-full pl-9`}
              />
            </div>

            <div className="relative w-full shrink-0 sm:w-44">
              <select
                value={category}
                onChange={(event) => handleCategoryChange(event.target.value)}
                className={`${selectControlClass} truncate`}
              >
                <option value="">All categories</option>
                {categories.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            </div>

            <button
              type="button"
              onClick={handleReset}
              disabled={!hasActiveFilters}
              className="h-10 w-full shrink-0 rounded-lg border border-neutral-300 px-4 text-sm font-semibold text-neutral-500 transition-colors hover:border-neutral-400 hover:bg-neutral-50 hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
            >
              Reset
            </button>
          </div>
        </div>

        <div className="relative p-4 sm:p-6">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <p className="text-sm font-semibold text-neutral-700">No catalog items match your search.</p>
              {canManage ? (
                <div className="w-full max-w-xs">
                  <NewCatalogItemDialog variant="ghostCard" onSuccess={handleItemCreated} />
                </div>
              ) : null}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((item) => (
                <CatalogItemCard key={item.id} item={item} canManage={canManage} onItemChanged={handleItemChanged} />
              ))}
              {canManage ? <NewCatalogItemDialog variant="ghostCard" onSuccess={handleItemCreated} /> : null}
            </div>
          )}

          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/70">
              <span
                aria-hidden="true"
                className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-200 border-t-teal-600"
              />
              <span className="sr-only">Loading catalog items…</span>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col items-center justify-between gap-3 sm:flex-row">
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <label htmlFor="catalog-cards-per-page">Cards per page</label>
          <select
            id="catalog-cards-per-page"
            value={pageSize}
            onChange={(event) => handlePageSizeChange(Number(event.target.value))}
            className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <p className="text-xs font-medium text-neutral-600">
            Page {currentPage + 1} of {pageCount}
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(current - 1, 0))}
              disabled={currentPage === 0}
              className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(current + 1, pageCount - 1))}
              disabled={currentPage >= pageCount - 1}
              className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
