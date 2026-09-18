"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { formatRoleLabel } from "@/features/customers/lib/role-labels";
import { getOwnerAvatarColor, getOwnerDisplayLabels, getOwnerInitials } from "@/features/leads/lib/owner-display";
import { ChevronDownIcon, CloseIcon, SearchIcon } from "@/features/sales-management/components/icons";
import type { TeamDirectoryEntry } from "@/types/lead";

/**
 * A searchable team-member picker, single- or multi-select.
 *
 * WAS features/invitations/components/manager-select.tsx. It was never
 * manager-specific — it renders a hierarchy-scoped TeamDirectoryEntry[]
 * with the shared owner-display labels, which is exactly what picking a
 * lead owner or a round-robin roster needs. Promoted to
 * components/shared per CLAUDE.md Section M now that a second feature
 * (Lead Capture) uses it, rather than leaving a genuinely shared
 * control filed under one feature with a name that describes only its
 * first caller.
 *
 * Filtering is CLIENT-SIDE on purpose: the option list is one
 * organization's active members, already fetched server-side for the
 * page, so a per-keystroke round trip would be strictly worse than
 * filtering a list that is already in memory. That is the opposite call
 * from LeadSearchSelect (which searches server-side because a
 * customer's Lead table is unbounded) — different data sizes, different
 * right answer. Same visual shell either way, so the two read as one
 * pattern.
 *
 * Hidden inputs carry the selection, so this participates in the
 * ordinary <form> + Server Action submission the rest of this app uses
 * rather than needing controlled-state plumbing in the parent. In
 * `multiple` mode there is ONE HIDDEN INPUT PER SELECTED PERSON, all
 * sharing `name` — which is what makes formData.getAll(name) return the
 * whole roster on the server.
 *
 * Keyboard: the trigger and every option are real buttons in tab order,
 * Escape closes, and the listbox is labelled — no custom key handling
 * beyond Escape, matching the app's other lightweight dropdowns.
 */
type TeamSelectProps = {
  id: string;
  /** The form field this writes into. */
  name: string;
  label: string;
  error?: string;
  helperText?: string;
  /** The caller's own hierarchy-visible teammates
   *  (getVisibleTeamDirectory) — already scoped to this customer and to
   *  Active members only by the RPC itself. Never the whole auth.users
   *  table. */
  options: TeamDirectoryEntry[];
  disabled?: boolean;
  /**
   * SINGLE-SELECT ONLY: the label for the explicit "nobody" option, e.g.
   * "No manager" or "Leave unassigned". Omit it to drop that option
   * entirely, for a field where a person is mandatory.
   *
   * Multi-select has no equivalent and does not need one: selecting
   * nobody is just an empty roster, which is a state you reach by
   * removing chips rather than by picking a sentinel option.
   */
  emptyOptionLabel?: string;
  /** One hidden input per selection, and options toggle instead of
   *  closing the menu. */
  multiple?: boolean;
  /** Initial selection. Uncontrolled after mount — this component owns
   *  its state, like every other form control in this app. */
  defaultSelectedIds?: string[];
};

export function TeamSelect({
  id,
  name,
  label,
  error,
  helperText,
  options,
  disabled,
  emptyOptionLabel,
  multiple = false,
  defaultSelectedIds,
}: TeamSelectProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>(() => defaultSelectedIds ?? []);
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const errorId = `${id}-error`;
  const helperId = `${id}-helper`;

  const displayLabelById = useMemo(() => getOwnerDisplayLabels(options), [options]);
  const optionById = useMemo(
    () => new Map(options.map((option) => [option.customer_user_id, option])),
    [options],
  );

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) => {
      const optionLabel = displayLabelById.get(option.customer_user_id) ?? option.email;
      return (
        optionLabel.toLowerCase().includes(term) ||
        option.email.toLowerCase().includes(term) ||
        formatRoleLabel(option.role_name).toLowerCase().includes(term)
      );
    });
  }, [options, query, displayLabelById]);

  const singleSelectedId = multiple ? "" : (selectedIds[0] ?? "");
  const singleSelected = singleSelectedId ? optionById.get(singleSelectedId) : undefined;

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

  function pick(optionId: string) {
    if (!multiple) {
      setSelectedIds(optionId ? [optionId] : []);
      setIsOpen(false);
      setQuery("");
      return;
    }
    // Multi: toggle, and KEEP THE MENU OPEN — adding three people to a
    // rotation should not mean reopening the menu three times. The
    // search term is kept too, so "add both Sharmas" is two clicks.
    setSelectedIds((current) =>
      current.includes(optionId) ? current.filter((value) => value !== optionId) : [...current, optionId],
    );
  }

  const isSelected = (optionId: string) => selectedIds.includes(optionId);

  const triggerText = multiple
    ? selectedIds.length === 0
      ? "Nobody selected"
      : `${selectedIds.length} selected`
    : singleSelected
      ? (displayLabelById.get(singleSelected.customer_user_id) ?? singleSelected.email)
      : (emptyOptionLabel ?? "Select a team member");

  return (
    <div className="flex flex-col gap-1.5" ref={containerRef}>
      <label htmlFor={id} className="text-sm font-medium text-neutral-700">
        {label}
      </label>

      {/* One input per selection in multiple mode; a single (possibly
          empty) input otherwise, so an intentionally cleared field still
          submits "" rather than being absent from FormData. */}
      {multiple ? (
        selectedIds.map((selectedId) => (
          <input key={selectedId} type="hidden" name={name} value={selectedId} />
        ))
      ) : (
        <input type="hidden" name={name} value={singleSelectedId} />
      )}

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
          } ${singleSelected || selectedIds.length > 0 ? "text-neutral-900" : "text-neutral-500"}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {singleSelected ? (
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white ${getOwnerAvatarColor(singleSelected.customer_user_id)}`}
              >
                {getOwnerInitials(singleSelected)}
              </span>
            ) : null}
            <span className="truncate">{triggerText}</span>
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
          {!multiple && singleSelected ? (
            <button
              type="button"
              onClick={() => pick("")}
              disabled={disabled}
              aria-label={`Clear ${label.toLowerCase()}`}
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
                role — this only removes the wrapper from the
                accessibility tree, and changes nothing visually or for
                the keyboard. */}
            <ul
              id={listboxId}
              role="listbox"
              aria-label={label}
              aria-multiselectable={multiple || undefined}
              className="max-h-56 overflow-y-auto py-1"
            >
              {!multiple && emptyOptionLabel ? (
                <li role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={singleSelectedId === ""}
                    onClick={() => pick("")}
                    className="w-full px-3.5 py-2 text-left text-sm text-neutral-500 transition-colors hover:bg-neutral-50"
                  >
                    {emptyOptionLabel}
                  </button>
                </li>
              ) : null}

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
                      aria-selected={isSelected(option.customer_user_id)}
                      onClick={() => pick(option.customer_user_id)}
                      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left transition-colors hover:bg-neutral-50 ${
                        isSelected(option.customer_user_id) ? "bg-sky-50" : ""
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white ${getOwnerAvatarColor(option.customer_user_id)}`}
                      >
                        {getOwnerInitials(option)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-neutral-900">
                          {displayLabelById.get(option.customer_user_id) ?? option.email}
                        </span>
                        <span className="block truncate text-xs text-neutral-500">
                          {option.email} · {formatRoleLabel(option.role_name)}
                        </span>
                      </span>
                      {/* A checkmark would need a new icon import for one
                          state; the existing selected-row tint plus this
                          dot reuses what the app already ships. */}
                      {multiple && isSelected(option.customer_user_id) ? (
                        <span
                          aria-hidden="true"
                          className="h-2 w-2 shrink-0 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
                        />
                      ) : null}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : null}
      </div>

      {/* CHIPS ARE THE MULTI-SELECT'S REAL AFFORDANCE. "3 selected" on
          the trigger says how many but not who, and rotation order
          matters here — so the roster is listed in the order it will be
          used, outside the menu, where it stays visible while the admin
          edits it. */}
      {multiple && selectedIds.length > 0 ? (
        <ul className="mt-1 flex flex-wrap gap-1.5">
          {selectedIds.map((selectedId, index) => {
            const option = optionById.get(selectedId);
            if (!option) return null;
            return (
              <li
                key={selectedId}
                className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 py-1 pr-1 pl-2 text-xs font-medium text-neutral-700"
              >
                <span className="text-[10px] font-bold text-neutral-400">{index + 1}</span>
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] font-semibold text-white ${getOwnerAvatarColor(selectedId)}`}
                >
                  {getOwnerInitials(option)}
                </span>
                <span className="max-w-40 truncate">
                  {displayLabelById.get(selectedId) ?? option.email}
                </span>
                <button
                  type="button"
                  onClick={() => pick(selectedId)}
                  disabled={disabled}
                  aria-label={`Remove ${displayLabelById.get(selectedId) ?? option.email}`}
                  className="rounded-full p-0.5 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
                >
                  <CloseIcon className="h-3 w-3" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}

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
