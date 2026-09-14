"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatRoleLabel } from "@/features/customers/lib/role-labels";
import { getOwnerAvatarColor, getOwnerDisplayLabels, getOwnerInitials } from "@/features/leads/lib/owner-display";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "@/features/sales-management/components/icons";
import type { TeamDirectoryEntry } from "@/types/lead";

type ManagerSelectProps = {
  id: string;
  /** The form field this writes into — submitted as part of the Add User
   *  form, so the Server Action reads it from FormData like any other
   *  field. "" means no manager, which the invitation schema turns into
   *  a real NULL. */
  name: string;
  label: string;
  error?: string;
  helperText?: string;
  /** The caller's own hierarchy-visible teammates
   *  (getVisibleTeamDirectory) — already scoped to this customer and to
   *  Active members only by the RPC itself, so every option here is a
   *  valid manager by construction. Never the whole auth.users table. */
  options: TeamDirectoryEntry[];
  disabled?: boolean;
};

/**
 * A searchable manager picker. Filtering is CLIENT-SIDE on purpose: the
 * option list is one organization's active members, already fetched
 * server-side for this page, so a per-keystroke round trip would be
 * strictly worse than filtering a list that's already in memory. That's
 * the opposite call from LeadSearchSelect (which searches server-side
 * because a customer's Lead table is unbounded) — different data sizes,
 * different right answer. Same visual shell either way, so the two read
 * as one pattern.
 *
 * A hidden input carries the selected id, so this participates in the
 * ordinary <form> + Server Action submission the rest of this app uses
 * rather than needing its own controlled-state plumbing in the parent.
 *
 * Keyboard: the trigger and every option are real buttons in tab order,
 * Escape closes, and the listbox is labelled — no custom key handling
 * beyond Escape, matching the app's other lightweight dropdowns.
 */
export function ManagerSelect({
  id,
  name,
  label,
  error,
  helperText,
  options,
  disabled,
}: ManagerSelectProps) {
  const [selectedId, setSelectedId] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;

  const displayLabelById = useMemo(() => getOwnerDisplayLabels(options), [options]);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) => {
      const label = displayLabelById.get(option.customer_user_id) ?? option.email;
      return (
        label.toLowerCase().includes(term) ||
        option.email.toLowerCase().includes(term) ||
        formatRoleLabel(option.role_name).toLowerCase().includes(term)
      );
    });
  }, [options, query, displayLabelById]);

  const selected = options.find((option) => option.customer_user_id === selectedId);

  useEffect(() => {
    if (!isOpen) return;

    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function select(optionId: string) {
    setSelectedId(optionId);
    setIsOpen(false);
    setQuery("");
  }

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      <label htmlFor={id} className="text-sm font-medium text-neutral-700">
        {label}
      </label>

      <input type="hidden" name={name} value={selectedId} />

      <div className="relative">
        <button
          type="button"
          id={id}
          disabled={disabled}
          onClick={() => setIsOpen((open) => !open)}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={isOpen ? listboxId : undefined}
          /* No aria-invalid here: it isn't a supported attribute on the
             implicit `button` role (unlike a real form input), so the
             error is conveyed by aria-describedby pointing at the
             role="alert" message below, plus the red border. */
          aria-describedby={error ? errorId : helperText ? helperId : undefined}
          className={`flex w-full items-center rounded-lg border bg-neutral-100 py-2.5 pr-16 pl-3.5 text-left text-sm outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60 ${
            error ? "border-red-400" : "border-transparent"
          } ${selected ? "text-neutral-900" : "text-neutral-500"}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {selected ? (
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white ${getOwnerAvatarColor(selected.customer_user_id)}`}
              >
                {getOwnerInitials(selected)}
              </span>
            ) : null}
            <span className="truncate">
              {selected ? (displayLabelById.get(selected.customer_user_id) ?? selected.email) : "No manager"}
            </span>
          </span>
        </button>

        {/* Trailing controls are SIBLINGS of the trigger, overlaid on its
            right edge — never children of it. A focusable control nested
            inside a <button> is invalid HTML (interactive content cannot
            nest) and leaves keyboard and screen-reader behavior
            ambiguous: Enter/Space would belong to both at once. The
            wrapper is pointer-events-none so clicks pass through to the
            trigger underneath, and only the real Clear <button> opts back
            in. */}
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center gap-1">
          {selected ? (
            <button
              type="button"
              onClick={() => select("")}
              disabled={disabled}
              aria-label="Clear manager"
              className="pointer-events-auto rounded p-0.5 text-neutral-400 transition-colors hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
            >
              <CloseIcon className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <ChevronDownIcon className="h-4 w-4 text-neutral-500" aria-hidden="true" />
        </span>

        {isOpen ? (
          <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl bg-white shadow-lg ring-1 ring-black/5">
            <div className="relative border-b border-neutral-100 p-2">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-4 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
              <input
                type="text"
                value={query}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search by name, email, or role..."
                aria-label="Search team members"
                className="h-9 w-full rounded-lg border border-neutral-200 bg-white pl-8 text-sm text-neutral-700 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
              />
            </div>

            {/* The <li> wrappers are presentational on purpose: a
                role="listbox" may only own role="option" children, so
                leaving them as implicit listitems puts a layer between
                the listbox and its options that screen readers report as
                a malformed list. The buttons themselves carry the option
                role, exactly as before — this only removes the wrapper
                from the accessibility tree, and changes nothing visually
                or for the keyboard. */}
            <ul id={listboxId} role="listbox" aria-label={label} className="max-h-56 overflow-y-auto py-1">
              <li role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedId === ""}
                  onClick={() => select("")}
                  className="w-full px-3.5 py-2 text-left text-sm text-neutral-500 transition-colors hover:bg-neutral-50"
                >
                  No manager
                </button>
              </li>

              {filtered.length === 0 ? (
                <li role="presentation" className="px-3.5 py-2.5 text-sm text-neutral-400">
                  No team members match your search.
                </li>
              ) : (
                filtered.map((option) => (
                  <li key={option.customer_user_id} role="presentation">
                    <button
                      type="button"
                      role="option"
                      aria-selected={option.customer_user_id === selectedId}
                      onClick={() => select(option.customer_user_id)}
                      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-neutral-50 ${
                        option.customer_user_id === selectedId ? "bg-sky-50" : ""
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${getOwnerAvatarColor(option.customer_user_id)}`}
                      >
                        {getOwnerInitials(option)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-neutral-900">
                          {displayLabelById.get(option.customer_user_id) ?? option.email}
                        </span>
                        <span className="block truncate text-xs text-neutral-500">
                          {option.email} · {formatRoleLabel(option.role_name)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}
      </div>

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
