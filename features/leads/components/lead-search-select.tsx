"use client";

import { useEffect, useMemo, useRef, useState, useId } from "react";
import { CloseIcon, SearchIcon } from "@/features/sales-management/components/icons";
import type { Lead } from "@/types/lead";

const MAX_RESULTS = 50;

function leadLabel(lead: Lead): string {
  return lead.company ? `${lead.company} — ${lead.contact_name}` : lead.contact_name;
}

function matchesQuery(lead: Lead, normalizedQuery: string): boolean {
  const haystack = [lead.contact_name, lead.company, lead.email, lead.phone]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return haystack.includes(normalizedQuery);
}

type LeadSearchSelectProps = {
  /** Every Lead the caller can currently see (RLS-scoped already) — the
   *  same array both AddTaskDialog and NewContactDialog already fetch
   *  once and pass down. Filtered here IN MEMORY as the user types rather
   *  than via a new per-keystroke server round trip: this project's
   *  existing architecture already loads a customer's full Lead list
   *  once per page load (see getLeadsForCustomer), so searching within
   *  that already-resident array adds no new network requests and no new
   *  data-fetching surface — see this component's own file-level comment
   *  for the reasoning and its tradeoff. */
  leads: Lead[];
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
  /** Preselects a Lead (e.g. opened from a Lead's own "Add Task" action)
   *  — still changeable by the user afterward. Ignored in controlled
   *  mode (value/onChange own the selection there instead). */
  defaultLeadId?: string;
  placeholder?: string;
  /** CONTROLLED MODE — pass both together to drive the selection from
   *  outside instead of this component's own internal state/hidden form
   *  input. Added for ContactList's Lead filter (a live client-side
   *  filter has to observe the selection immediately; a hidden form
   *  input only surfaces on a <form> submit, which a filter never does).
   *  The two existing form-field consumers (Contact/Task create/edit
   *  dialogs) don't pass these and are completely unaffected — every
   *  branch below only activates when `onChange` is actually provided. */
  value?: string;
  onChange?: (leadId: string) => void;
};

/**
 * A searchable combobox for picking one Lead — searches contact name,
 * company, email, and phone as the user types. Shared between the Task
 * form and the Contact form (promoted here, in features/leads/, rather
 * than duplicated per-feature — CLAUDE.md Section M: a component used by
 * two or more features belongs to the domain it's about, promoted once a
 * second real consumer exists, exactly the case here).
 *
 * No async/loading state: filtering happens synchronously over the
 * already-provided `leads` array (no network request is made at all),
 * so there is nothing to show a loading indicator FOR — a fake spinner
 * here would misrepresent what's actually happening.
 */
export function LeadSearchSelect({
  leads,
  id,
  name,
  label,
  hideLabel,
  required,
  error,
  helperText,
  defaultLeadId,
  placeholder = "Search leads by name, company, email, or phone...",
  value,
  onChange,
}: LeadSearchSelectProps) {
  const isControlled = onChange !== undefined;
  const leadsById = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);
  const defaultLead = defaultLeadId ? leadsById.get(defaultLeadId) : undefined;

  const [internalSelectedLeadId, setInternalSelectedLeadId] = useState(defaultLeadId ?? "");
  const selectedLeadId = isControlled ? (value ?? "") : internalSelectedLeadId;
  const [query, setQuery] = useState(defaultLead ? leadLabel(defaultLead) : "");
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  // Controlled mode only: keeps the visible search text in sync when the
  // PARENT changes `value` from outside this component's own selection/
  // clear handlers (e.g. a page-level "Reset filters" control) — "adjust
  // state during render" (this component's own `query` state, kept in
  // sync with its own incoming `value` prop), the same safe pattern used
  // throughout this app instead of a useEffect for this exact case.
  const [syncedControlledValue, setSyncedControlledValue] = useState(value);
  if (isControlled && value !== syncedControlledValue) {
    setSyncedControlledValue(value);
    const matchedLead = value ? leadsById.get(value) : undefined;
    setQuery(matchedLead ? leadLabel(matchedLead) : "");
  }

  const containerRef = useRef<HTMLDivElement>(null);
  const generatedId = useId();
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;
  const listboxId = `${id}-listbox-${generatedId}`;

  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!normalizedQuery) return leads.slice(0, MAX_RESULTS);
    return leads.filter((lead) => matchesQuery(lead, normalizedQuery)).slice(0, MAX_RESULTS);
  }, [leads, normalizedQuery]);

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
  // changes (typing narrows/widens it) — "adjust state during render"
  // (this component's own state, kept in sync with its own derived
  // value), the same safe pattern used throughout this app instead of a
  // useEffect for this exact case.
  const [syncedResultsLength, setSyncedResultsLength] = useState(results.length);
  if (results.length !== syncedResultsLength) {
    setSyncedResultsLength(results.length);
    setHighlightedIndex(0);
  }

  function selectLead(lead: Lead) {
    if (isControlled) {
      onChange!(lead.id);
    } else {
      setInternalSelectedLeadId(lead.id);
    }
    setQuery(leadLabel(lead));
    setIsOpen(false);
  }

  function clearSelection() {
    if (isControlled) {
      onChange!("");
    } else {
      setInternalSelectedLeadId("");
    }
    setQuery("");
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
            setQuery(event.target.value);
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
            {results.length === 0 ? (
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
