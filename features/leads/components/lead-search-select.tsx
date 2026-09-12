"use client";

import { useEffect, useRef, useState } from "react";
import { CloseIcon, SearchIcon } from "@/features/sales-management/components/icons";
import { searchLeadsAction, getLeadLabelsAction } from "../actions";
import { formatLeadLabel } from "../lib/get-lead-labels";
import type { LeadSearchResult } from "../lib/search-leads";

const SEARCH_DEBOUNCE_MS = 300;

type LeadSearchSelectProps = {
  id: string;
  /** The <input type="hidden"> field name a surrounding <form action={...}>
   *  submits — this component is a drop-in replacement for a native
   *  <select name="lead_id">, not a controlled-React-state field, so it
   *  works with every existing useActionState/FormData Server Action in
   *  this app unchanged. Omit entirely in controlled mode (see
   *  value/onChange below) — a filter isn't submitted via FormData, so no
   *  hidden input is rendered at all when this is absent. */
  name?: string;
  label: string;
  /** Visually hides the label (kept in the DOM, still associated via
   *  htmlFor, so it stays available to assistive tech and preserves the
   *  accessible name) — for a toolbar/filter placement sitting flush
   *  next to a control with no visible label of its own (ContactList's
   *  search bar), where a visible label row would push this component's
   *  input out of alignment with its neighbor. The two form-field
   *  consumers (Contact/Task create/edit) don't pass this and keep their
   *  visible label exactly as before. */
  hideLabel?: boolean;
  required?: boolean;
  error?: string;
  helperText?: string;
  /** Preselects a Lead — e.g. opened from a Lead's own "Add Task" action
   *  — without needing the full customer Lead list: the caller already
   *  has the one Lead object this applies to (EditLeadDialog's own
   *  `lead`, PipelineView's own row), so it passes the id + an
   *  already-formatted label directly. Still changeable by the user
   *  afterward. Ignored in controlled mode (value/onChange own the
   *  selection there instead). */
  defaultLead?: { id: string; label: string };
  placeholder?: string;
  /** CONTROLLED MODE — pass both together to drive the selection from
   *  outside instead of this component's own internal state/hidden form
   *  input. Used by ContactList's/TaskList's Lead filter (a live
   *  client-side filter has to observe the selection immediately; a
   *  hidden form input only surfaces on a <form> submit, which a filter
   *  never does). The two form-field consumers (Contact/Task create
   *  dialogs) don't pass these and are completely unaffected — every
   *  branch below only activates when `onChange` is actually provided. */
  value?: string;
  onChange?: (leadId: string) => void;
};

/**
 * A searchable combobox for picking one Lead — searches contact name,
 * company, email, and phone as the user types, via a real (debounced,
 * bounded, customer-scoped) server query, not a full customer Lead list
 * filtered in memory. Shared between the Task form and the Contact form
 * (promoted here, in features/leads/, rather than duplicated per-feature
 * — CLAUDE.md Section M: a component used by two or more features
 * belongs to the domain it's about).
 *
 * SECOND ITERATION: this component previously received the caller's
 * entire (already-RLS-scoped) Lead array as a `leads` prop and filtered
 * it client-side — cheap in request count, but meant every page that
 * ever needed to pick a Lead (Contacts, Tasks) had to first fetch its
 * customer's WHOLE lead table, unbounded, on every page load, just to
 * feed this one dropdown. It now calls searchLeadsAction itself
 * (debounced, cancelled-response-guarded, the same fetch-effect shape
 * CatalogItemsGrid/ContactList/TaskList already use elsewhere in this
 * app) and resolves an externally-set `value`/`defaultLead` it doesn't
 * already know the label for via getLeadLabelsAction — the SAME bounded,
 * id-scoped lookup ContactList/TaskList use for their own row badges, so
 * there is exactly one way this app resolves a lead_id into a label, not
 * two.
 */
export function LeadSearchSelect({
  id,
  name,
  label,
  hideLabel,
  required,
  error,
  helperText,
  defaultLead,
  placeholder = "Search leads by name, company, email, or phone...",
  value,
  onChange,
}: LeadSearchSelectProps) {
  const isControlled = onChange !== undefined;

  const [internalSelectedLeadId, setInternalSelectedLeadId] = useState(defaultLead?.id ?? "");
  const selectedLeadId = isControlled ? (value ?? "") : internalSelectedLeadId;

  const [query, setQuery] = useState(defaultLead?.label ?? "");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [results, setResults] = useState<LeadSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Every label this component has resolved so far — from search
  // results, from `defaultLead`, or from an id-scoped resolve fetch
  // below — so re-selecting (or re-syncing to) an id it's already seen
  // never needs a second round trip. Real state, not a ref: the
  // render-time sync block below reads it to decide `query` synchronously
  // in the same render its own selection changes, and reading a ref's
  // `.current` during render is exactly the hazard React's own rules
  // (and this project's lint config) flag — a ref can be mutated between
  // renders without React ever re-rendering to reflect it, so a value
  // read from one during render is not guaranteed to be the value that
  // render actually commits with.
  const [labelCache, setLabelCache] = useState<Map<string, string>>(
    () => new Map(defaultLead ? [[defaultLead.id, defaultLead.label]] : []),
  );

  function cacheLabel(leadId: string, resolvedLabel: string) {
    setLabelCache((current) => {
      if (current.get(leadId) === resolvedLabel) return current;
      return new Map(current).set(leadId, resolvedLabel);
    });
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;
  const listboxId = `${id}-listbox`;

  // Keeps `query` in sync with `selectedLeadId` whenever the id itself
  // changes for a reason OTHER than the user actively typing (an
  // external controlled `value` change, a defaultLead, selectLead()/
  // clearSelection() below) — "adjust state during render," the same
  // safe pattern used throughout this app for "sync my own state to my
  // own derived value." The typing handler further down pre-empts this
  // by updating `syncedSelectedLeadId` itself in the SAME event, so a
  // keystroke that also clears the current selection can never have its
  // own just-typed text overwritten by this block reacting to that same
  // clear one render later.
  const [syncedSelectedLeadId, setSyncedSelectedLeadId] = useState(selectedLeadId);
  if (selectedLeadId !== syncedSelectedLeadId) {
    setSyncedSelectedLeadId(selectedLeadId);
    setQuery(selectedLeadId ? (labelCache.get(selectedLeadId) ?? query) : "");
  }

  // Async fallback for the case the block above can't resolve
  // synchronously: `selectedLeadId` points at a lead whose label isn't
  // in the local cache yet — a controlled `value` seeded from a URL
  // param on mount is the real case this exists for (ContactList/
  // TaskList's own Lead filter, restored from a bookmarked/shared link).
  // Resolves via the SAME bounded, id-scoped lookup row badges use, never
  // the full customer Lead list. A no-op whenever the block above already
  // found a cache hit (the `has` guard below) — including on ITS OWN next
  // run once this effect's own resolve populates the cache, since that's
  // a normal, intentional re-run of an effect keyed on the state it just
  // updated, not a loop (nothing here re-fires unless `selectedLeadId`
  // itself changes again).
  useEffect(() => {
    if (!selectedLeadId || labelCache.has(selectedLeadId)) return;

    let cancelled = false;
    getLeadLabelsAction([selectedLeadId]).then((labels) => {
      if (cancelled) return;
      const match = labels[0];
      if (!match) return;
      const resolvedLabel = formatLeadLabel(match);
      cacheLabel(selectedLeadId, resolvedLabel);
      setQuery(resolvedLabel);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedLeadId, labelCache]);

  // Debounce: only the settled value drives an actual search request, so
  // typing doesn't hit the server on every keystroke — same
  // SEARCH_DEBOUNCE_MS/pattern CatalogItemsGrid/ContactList/TaskList
  // already use for their own search inputs.
  const [debouncedQuery, setDebouncedQuery] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Only searches while the dropdown is actually open — an empty query
  // still searches (returns the most recently updated leads, the "show
  // something on focus before typing" case), it just never fires for a
  // closed, unfocused input sitting on a previously-selected lead's
  // label.
  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the start of the async search this same effect kicks off below, immediately, guarded by `cancelled` and cleaned up on every re-run/unmount — the identical shape ContactList's/TaskGroupSection's/CatalogItemsGrid's own fetch-effect setIsLoading(true) already uses elsewhere in this app, not a new pattern
    setIsSearching(true);

    searchLeadsAction(debouncedQuery).then((leads) => {
      if (cancelled) return;
      setLabelCache((current) => {
        const next = new Map(current);
        for (const lead of leads) {
          next.set(lead.id, formatLeadLabel(lead));
        }
        return next;
      });
      setResults(leads);
      setIsSearching(false);
    });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, isOpen]);

  // Closes the dropdown on an outside click — the standard pattern for a
  // combobox that isn't rendered as a native <select> (which gets this
  // for free from the browser).
  useEffect(() => {
    if (!isOpen) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  // Keeps the highlighted row in range whenever the result set itself
  // changes (a new search response narrows/widens it) — "adjust state
  // during render," the same safe pattern used throughout this app.
  const [syncedResultsLength, setSyncedResultsLength] = useState(results.length);
  if (results.length !== syncedResultsLength) {
    setSyncedResultsLength(results.length);
    setHighlightedIndex(0);
  }

  function selectLead(lead: LeadSearchResult) {
    cacheLabel(lead.id, formatLeadLabel(lead));
    if (isControlled) {
      onChange!(lead.id);
    } else {
      setInternalSelectedLeadId(lead.id);
    }
    setIsOpen(false);
    // `query` itself is updated by the render-time sync block above,
    // once `selectedLeadId` reflects this new id — the cache write just
    // above is what makes that a synchronous cache hit, not a fetch.
  }

  function clearSelection() {
    if (isControlled) {
      onChange!("");
    } else {
      setInternalSelectedLeadId("");
    }
    setIsOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setIsOpen(false);
      return;
    }
    if (!isOpen && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      setIsOpen(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.min(current + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      if (isOpen && results[highlightedIndex]) {
        event.preventDefault();
        selectLead(results[highlightedIndex]);
      }
    }
  }

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : "text-sm font-medium text-neutral-700"}>
        {label}
        {required ? (
          <span className="text-red-500" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </label>

      <div className="relative">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : helperText ? helperId : undefined}
          aria-required={required}
          autoComplete="off"
          value={query}
          placeholder={placeholder}
          onFocus={() => setIsOpen(true)}
          onChange={(event) => {
            const text = event.target.value;
            setQuery(text);
            // Pre-empts the render-time sync block above from reacting
            // to the selection clear on the line below and overwriting
            // `text` with "" one render later — see that block's own
            // comment.
            setSyncedSelectedLeadId("");
            if (isControlled) {
              onChange!("");
            } else {
              setInternalSelectedLeadId("");
            }
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          className={`w-full rounded-lg border border-transparent bg-neutral-100 py-2.5 pr-9 pl-10 text-sm text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 ${
            error ? "ring-2 ring-red-300" : ""
          }`}
        />
        {query ? (
          <button
            type="button"
            onClick={clearSelection}
            aria-label="Clear selected lead"
            className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-md p-1 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-600"
          >
            <CloseIcon className="h-3.5 w-3.5" />
          </button>
        ) : null}

        {isOpen ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Matching leads"
            className="absolute z-20 mt-1.5 max-h-64 w-full overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1.5 shadow-lg"
          >
            {isSearching && results.length === 0 ? (
              <li className="px-3.5 py-2.5 text-sm text-neutral-400">Searching…</li>
            ) : results.length === 0 ? (
              <li className="px-3.5 py-2.5 text-sm text-neutral-400">No leads match your search.</li>
            ) : (
              results.map((lead, index) => (
                <li key={lead.id} role="option" aria-selected={lead.id === selectedLeadId}>
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectLead(lead)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3.5 py-2 text-left text-sm transition-colors ${
                      index === highlightedIndex ? "bg-sky-50" : "hover:bg-neutral-50"
                    }`}
                  >
                    <span className="font-medium text-neutral-900">{lead.contact_name}</span>
                    <span className="text-xs text-neutral-500">
                      {[lead.company, lead.email, lead.phone].filter(Boolean).join(" · ") || "No additional details"}
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>

      {/* Native form submission (this app's Server Actions all read
          FormData, not controlled React state) reads this hidden field —
          the visible text input above is purely the search/display UI.
          Omitted entirely in controlled mode (no `name`) — a filter isn't
          submitted via FormData, so there's nothing for a hidden input to
          do there. */}
      {name ? <input type="hidden" name={name} value={selectedLeadId} /> : null}

      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : helperText ? (
        <p id={helperId} className="text-xs text-neutral-400">
          {helperText}
        </p>
      ) : null}
    </div>
  );
}
