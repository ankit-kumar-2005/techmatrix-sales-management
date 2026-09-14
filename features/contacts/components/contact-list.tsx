"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getContactsPageAction } from "../actions";
import { EditContactDialog } from "./edit-contact-dialog";
import { formatLeadLabel, type LeadLabel } from "@/features/leads/lib/get-lead-labels";
import {
  getOwnerAvatarColor,
  getOwnerDisplayLabels,
  getOwnerInitials,
  getOwnerTooltip,
} from "@/features/leads/lib/owner-display";
import {
  BuildingIcon,
  LeadCaptureIcon,
  MailIcon,
  PencilIcon,
  PhoneIcon,
  SearchIcon,
  TagIcon,
} from "@/features/sales-management/components/icons";
import type { ContactsPage, ContactListItem } from "../lib/get-contacts";
import type { TeamDirectoryEntry } from "@/types/lead";

// Same three choices and same default as the Pipeline List View's own
// "Rows per page" selector (pipeline-view.tsx) and Tasks' identical
// selector (task-list.tsx) — see task-list.tsx's own comment on why this
// is a literal, not a shared constant, across the three (differently
// architected) pagination implementations.
const PAGE_SIZE_OPTIONS = [10, 15, 20] as const;
const DEFAULT_PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

type OwnerDisplay = { label: string; initials: string; tooltip: string };

function resolveLeadLabel(lead: LeadLabel | undefined): string | undefined {
  return lead ? formatLeadLabel(lead) : undefined;
}

/** The contact card's own pill order — "Person Name — Company," the
 *  reverse of formatLeadLabel's shared "Company — Person Name." Kept
 *  local to this one call site rather than changing formatLeadLabel
 *  itself, which is a shared formatting rule used well beyond this
 *  pill — LeadSearchSelect's own dropdown/locked-value display, this
 *  same page's EditContactDialog locked-lead field, and Tasks'
 *  EditTaskDialog/TaskRow/TaskDetailModal. Flipping that shared
 *  function would have silently reversed the label in every one of
 *  those places too; only this pill was actually asked for. Still the
 *  linked LEAD's own contact_name/company (unchanged data source) —
 *  just reordered. */
function formatContactPillLeadLabel(lead: LeadLabel): string {
  return lead.company ? `${lead.contact_name} — ${lead.company}` : lead.contact_name;
}

function resolvePillLeadLabel(lead: LeadLabel | undefined): string | undefined {
  return lead ? formatContactPillLeadLabel(lead) : undefined;
}

type ContactListProps = {
  initialPage: ContactsPage;
  initialSearch: string;
  /** Bumped by the page-level "New contact" dialog's onSuccess (owned by
   *  the shared client ancestor, ContactsPageClient, since that button
   *  lives in the page header — top-right, next to the heading, matching
   *  the reference design — not inside this component) — forces a
   *  re-fetch so a newly created contact shows up without a browser
   *  refresh. */
  refreshToken: number;
  /** The caller's own hierarchy-visible teammates — resolves each listed
   *  contact's owner_id into a display label/initials/tooltip, the exact
   *  same source and pattern TaskList already uses for task assignees;
   *  also the Owner picker inside EditContactDialog. */
  assignableUsers: TeamDirectoryEntry[];
  currentUserCustomerUserId: string;
};

/**
 * Owns the Contacts directory's search and its own paginated fetching —
 * architecturally the same shape as Tasks' TaskGroupSection (debounced
 * search, page reset on filter change via the render-time "adjust state"
 * pattern, a `cancelled` guard in the fetch effect so a stale response
 * can never overwrite a newer one, and search state mirrored into the
 * URL via history.replaceState so a hard refresh lands on the same
 * filtered view) — just without Tasks' extra due-date-bucket dimension,
 * since Contacts only has one list.
 */
export function ContactList({
  initialPage,
  initialSearch,
  refreshToken,
  assignableUsers,
  currentUserCustomerUserId,
}: ContactListProps) {
  const [searchInput, setSearchInput] = useState(initialSearch);
  const [committedSearch, setCommittedSearch] = useState(initialSearch);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [contacts, setContacts] = useState(initialPage.contacts);
  const [totalCount, setTotalCount] = useState(initialPage.totalCount);
  const [leadLabels, setLeadLabels] = useState(initialPage.leadLabels);
  const [isLoading, setIsLoading] = useState(false);
  const [editingContact, setEditingContact] = useState<ContactListItem | null>(null);

  // Labels for exactly the Leads the CURRENT page of contacts links to
  // (bounded, arrives paired with each fetch — see getContactsPage's own
  // comment) — replaced wholesale on every fetch, never merged across
  // pages, since it only ever needs to cover contacts actually on screen
  // right now.
  const leadLabelById = useMemo(() => new Map(leadLabels.map((lead) => [lead.id, lead])), [leadLabels]);
  // A second, LOCAL refresh signal alongside the `refreshToken` prop —
  // that prop is owned by ContactsPageClient and only bumped by the
  // page-header "New contact" dialog (see its own comment); editing an
  // existing contact is handled entirely within this component (the
  // dialog is opened/closed via editingContact, local state), so its own
  // successful save needs its own way to trigger a re-fetch without
  // reaching back up into the parent for something this component can
  // already do itself.
  const [localRefreshToken, setLocalRefreshToken] = useState(0);

  const ownerDisplayById = useMemo(() => {
    const labels = getOwnerDisplayLabels(assignableUsers);
    const map = new Map<string, OwnerDisplay>();
    for (const user of assignableUsers) {
      map.set(user.customer_user_id, {
        label: labels.get(user.customer_user_id) ?? user.email,
        initials: getOwnerInitials(user),
        tooltip: getOwnerTooltip(user),
      });
    }
    return map;
  }, [assignableUsers]);

  useEffect(() => {
    const timer = setTimeout(() => setCommittedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Mirrors committedSearch into the URL's own searchParams — a hard
  // refresh (ContactsPage re-reading its own searchParams) lands on the
  // same filtered view, not a reset to "no filter" — same pattern and
  // same reasoning as TaskList's identical effect.
  useEffect(() => {
    const params = new URLSearchParams();
    if (committedSearch) params.set("q", committedSearch);
    const queryString = params.toString();
    const url = queryString ? `${window.location.pathname}?${queryString}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [committedSearch]);

  // Resets to page 1 whenever search OR page size changes — "adjust
  // state during render" (this component's own `page` state, kept in
  // sync with its own committedSearch/pageSize state), not a useEffect,
  // matching the pattern used throughout this app for this exact case.
  const [syncedSearch, setSyncedSearch] = useState(committedSearch);
  const [syncedPageSize, setSyncedPageSize] = useState(pageSize);
  if (committedSearch !== syncedSearch || pageSize !== syncedPageSize) {
    setSyncedSearch(committedSearch);
    setSyncedPageSize(pageSize);
    setPage(0);
  }

  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return; // the server already fetched this exact search/page — no need to re-fetch it immediately
    }

    let cancelled = false;
    setIsLoading(true);

    getContactsPageAction({ search: committedSearch, page, pageSize }).then((result) => {
      if (cancelled) return;
      setContacts(result.contacts);
      setTotalCount(result.totalCount);
      setLeadLabels(result.leadLabels);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [committedSearch, page, pageSize, refreshToken, localRefreshToken]);

  const pageCount = Math.max(Math.ceil(totalCount / pageSize), 1);
  const currentPage = Math.min(page, pageCount - 1);
  const hasSearch = Boolean(committedSearch);

  return (
    <div className="flex flex-col gap-4">
      {/* One merged search box (previously this plus a separate Lead
          picker/filter) — matches a single term against the contact's
          own name/company/email/phone/title AND the linked Lead's own
          name/company, all at once, server-side (see getContactsPage's
          own comment for how the Lead half is resolved). Two icons at
          the left (building, then the existing search glyph) rather than
          one, so the input still visually signals it searches
          organizational/company data too, not just people — the same
          pairing the previous two-box layout showed, just inside one
          input now instead of two. */}
      <div className="group relative w-full">
        <BuildingIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-sky-500" />
        <SearchIcon className="pointer-events-none absolute top-1/2 left-8 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-sky-500" />
        <input
          type="text"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search by name, lead, or company..."
          className="h-10 w-full rounded-lg border border-neutral-300 bg-white pl-14 text-sm text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
        />
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
        <div className="relative flex flex-col gap-2.5 p-4 sm:p-5">
          {contacts.length === 0 ? (
            <p className="rounded-xl bg-neutral-50 px-4 py-8 text-center text-sm text-neutral-400">
              {hasSearch
                ? "No contacts match this search."
                : "No contacts yet. Add your first contact to get started."}
            </p>
          ) : (
            contacts.map((contact) => (
              <ContactRow
                key={contact.id}
                contact={contact}
                owner={ownerDisplayById.get(contact.owner_id)}
                leadLabel={resolvePillLeadLabel(leadLabelById.get(contact.lead_id))}
                onEdit={() => setEditingContact(contact)}
              />
            ))
          )}

          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/70">
              <span
                aria-hidden="true"
                className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-200 border-t-sky-600"
              />
              <span className="sr-only">Loading contacts…</span>
            </div>
          ) : null}
        </div>

        {/* Always visible (not gated on pageCount > 1 the way the Page/
            Previous/Next block below still is) — otherwise the Rows per
            page control itself would vanish exactly when a user might
            want it most, e.g. to see if there ARE more contacts than fit
            on one page at the current size. Same "Rows per page"
            label/select markup and options (10/15/20) as the Pipeline
            List View's own selector and Tasks' identical one. */}
        <div className="flex flex-col items-center justify-between gap-2 border-t border-neutral-100 px-4 py-3 sm:flex-row sm:px-5">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <label htmlFor="contact-rows-per-page">Rows Per Page</label>
            <select
              id="contact-rows-per-page"
              value={pageSize}
              onChange={(event) => setPageSize(Number(event.target.value))}
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
              Page {currentPage + 1} of {pageCount} &middot; {totalCount} contact{totalCount === 1 ? "" : "s"}
            </p>
            {/* Always rendered now, regardless of pageCount — previously
                gated on pageCount > 1, which meant these controls simply
                didn't exist in the DOM whenever the current filtered
                result fit on one page (the common case for a narrow
                search/Lead filter), reading as "no way to paginate"
                rather than "disabled." The real `disabled` attribute
                (not just a dimmed style) is what actually makes
                first/last page correctly unreachable and lets screen
                readers/keyboard nav skip them, exactly as it already did
                — this only changes whether the buttons exist at all. */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(current - 1, 0))}
                disabled={currentPage === 0}
                aria-label="Previous page"
                className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(current + 1, pageCount - 1))}
                disabled={currentPage >= pageCount - 1}
                aria-label="Next page"
                className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>

      {editingContact ? (
        <EditContactDialog
          contact={editingContact}
          lockedLeadLabel={resolveLeadLabel(leadLabelById.get(editingContact.lead_id)) ?? ""}
          assignableUsers={assignableUsers}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onClose={() => {
            setEditingContact(null);
            setLocalRefreshToken((token) => token + 1);
          }}
        />
      ) : null}
    </div>
  );
}

function ContactRow({
  contact,
  owner,
  leadLabel,
  onEdit,
}: {
  contact: ContactListItem;
  owner?: OwnerDisplay;
  /** Resolved from ContactList's own bounded leadLabels for the current
   *  page (see its own comment) — undefined only in the edge case where
   *  the linked lead somehow isn't in that set, in which case the badge
   *  below simply doesn't render rather than showing a blank one. */
  leadLabel?: string;
  onEdit: () => void;
}) {
  const summary = [contact.company, contact.title].filter(Boolean).join(" · ");

  return (
    <div className="group relative flex flex-col gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:pr-12">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-neutral-900">{contact.name}</p>
          {summary ? <p className="truncate text-xs text-neutral-500">{summary}</p> : null}
        </div>

        {/* The business requirement this satisfies: "which Lead does
            this Contact belong to" must be answerable without opening
            Edit — a colored badge (not plain muted text, unlike Owner/
            email/phone below) so it reads as a distinct, first-class
            piece of information rather than ordinary secondary detail.
            Not a link: this app has no dedicated per-Lead route to
            navigate to (Leads live only inside the Pipeline board/list,
            no /leads/[id] page exists) — per the spec's own instruction,
            not inventing one just for this. */}
        {leadLabel ? (
          <div className="flex shrink-0 flex-col gap-1 sm:items-end sm:text-right">
            <span className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">Lead</span>
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-700 ring-1 ring-sky-100">
              <LeadCaptureIcon className="h-3 w-3 shrink-0" />
              <span className="truncate">{leadLabel}</span>
            </span>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500">
        {owner ? (
          <span className="flex items-center gap-1.5" title={owner.tooltip}>
            <span
              className={`flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-semibold text-white ${getOwnerAvatarColor(contact.owner_id)}`}
            >
              {owner.initials}
            </span>
            {owner.label}
          </span>
        ) : null}
        {contact.email ? (
          <span className="flex items-center gap-1.5">
            <MailIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            {contact.email}
          </span>
        ) : null}
        {contact.phone ? (
          <span className="flex items-center gap-1.5">
            <PhoneIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            {contact.phone}
          </span>
        ) : null}
        {contact.tags.length > 0 ? (
          <span className="flex items-center gap-1.5">
            <TagIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            {contact.tags.join(", ")}
          </span>
        ) : null}
      </div>

      {/* Edit is always authorized for any listed contact — Contacts'
          SELECT and UPDATE RLS policies use the IDENTICAL predicate
          (is_customer_user_visible(owner_id)), so if a contact appears
          here at all, the caller is already authorized to update it; no
          client-side canEdit gate is needed the way Leads' List View
          needs one (there, SELECT is broader than UPDATE). RLS in
          updateContactAction is still the real boundary regardless — see
          EditContactDialog's own comment.
          Hidden by default on desktop (opacity-0, revealed on hover/
          focus via the row's own group), but always visible below the
          sm breakpoint — touch devices have no hover state to reveal it
          with, so this is the "existing responsive/action pattern" this
          app already uses instead of a separate touch-only affordance. */}
      <button
        type="button"
        onClick={onEdit}
        title="Edit contact"
        aria-label={`Edit ${contact.name}`}
        className="absolute top-3 right-3 inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 opacity-100 transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
      >
        <PencilIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
