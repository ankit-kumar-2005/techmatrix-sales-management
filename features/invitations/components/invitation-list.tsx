"use client";

import { useEffect, useRef, useState } from "react";
import { formatRoleLabel } from "@/features/customers/lib/role-labels";
import { getOwnerAvatarColor } from "@/features/leads/lib/owner-display";
import { ChevronDownIcon, MailIcon, SearchIcon } from "@/features/sales-management/components/icons";
import { getInvitationsPageAction } from "../actions";
import { InvitationActionsMenu } from "./invitation-actions-menu";
import type { InvitationListItem, InvitationsPage } from "../lib/get-invitations";
import type { InvitationMembershipStatus, InvitationStatus } from "@/types/invitation";

// Same three choices and same default as every other paginated list in
// this app (Pipeline's List View, Contacts, Tasks, Catalog) — a literal
// per list, matching the convention those already established.
const PAGE_SIZE_OPTIONS = [10, 15, 20] as const;
const DEFAULT_PAGE_SIZE = 10;
const SEARCH_DEBOUNCE_MS = 300;

const controlClass =
  "h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";

/** Muted, business-like status treatment — the same ring-1 pill shape
 *  the Catalog status badge and Tasks priority/status badges already
 *  use, deliberately not a brighter palette. */
const INVITATION_STATUS_BADGE: Record<InvitationStatus, { label: string; className: string }> = {
  PENDING: { label: "Pending", className: "bg-amber-50 text-amber-700 ring-amber-100" },
  ACCEPTED: { label: "Accepted", className: "bg-emerald-50 text-emerald-700 ring-emerald-100" },
  EXPIRED: { label: "Expired", className: "bg-neutral-100 text-neutral-600 ring-neutral-200" },
  CANCELLED: { label: "Cancelled", className: "bg-rose-50 text-rose-700 ring-rose-100" },
};

const MEMBERSHIP_STATUS_CLASS: Record<InvitationMembershipStatus, string> = {
  Active: "text-emerald-700",
  Inactive: "text-neutral-500",
  "Not yet a member": "text-neutral-400",
};

const STATUS_FILTER_OPTIONS: { value: InvitationStatus | ""; label: string }[] = [
  { value: "", label: "All Statuses" },
  { value: "PENDING", label: "Pending" },
  { value: "ACCEPTED", label: "Accepted" },
  { value: "EXPIRED", label: "Expired" },
  { value: "CANCELLED", label: "Cancelled" },
];

const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

function initials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return `${parts[0].charAt(0)}${parts[parts.length - 1].charAt(0)}`.toUpperCase();
}

type InvitationListProps = {
  initialPage: InvitationsPage;
  /** Bumped by the page-level Add User dialog's onSuccess — forces this
   *  list to re-fetch whatever it's currently showing so a newly created
   *  invitation appears without a browser refresh. Same relationship
   *  ContactsPageClient/ContactList already have. */
  refreshToken: number;
};

/**
 * Invitation History. Architecturally the same shape as ContactList:
 * debounced search, server-side paging via a Server Action, page reset
 * on filter change through the render-time "adjust state" pattern, and
 * a `cancelled` guard so a slow response can never overwrite a newer
 * one. Every fetch goes through getInvitationsPageAction, which derives
 * customer_id from the caller's own membership — the browser never names
 * a tenant, and the whole table is never loaded to be filtered here.
 */
export function InvitationList({ initialPage, refreshToken }: InvitationListProps) {
  const [searchInput, setSearchInput] = useState("");
  const [committedSearch, setCommittedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<InvitationStatus | "">("");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [invitations, setInvitations] = useState(initialPage.invitations);
  const [totalCount, setTotalCount] = useState(initialPage.totalCount);
  const [isLoading, setIsLoading] = useState(false);
  // A second, LOCAL refresh signal alongside the prop: resend/cancel are
  // handled inside this component, so their success needs its own way to
  // trigger a re-fetch without reaching back up to the parent.
  const [localRefreshToken, setLocalRefreshToken] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setCommittedSearch(searchInput), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  // Resets to page 1 whenever the search, the status filter, or the page
  // size changes — "adjust state during render" (this component's own
  // page state, kept in sync with its own filter state), not an effect,
  // matching the pattern used throughout this app for exactly this.
  const [syncedSearch, setSyncedSearch] = useState(committedSearch);
  const [syncedStatus, setSyncedStatus] = useState(statusFilter);
  const [syncedPageSize, setSyncedPageSize] = useState(pageSize);
  if (committedSearch !== syncedSearch || statusFilter !== syncedStatus || pageSize !== syncedPageSize) {
    setSyncedSearch(committedSearch);
    setSyncedStatus(statusFilter);
    setSyncedPageSize(pageSize);
    setPage(0);
  }

  const isFirstRun = useRef(true);
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return; // the server already fetched this exact page — don't immediately re-fetch it
    }

    let cancelled = false;
    setIsLoading(true);

    getInvitationsPageAction({ search: committedSearch, status: statusFilter, page, pageSize }).then((result) => {
      if (cancelled) return;
      setInvitations(result.invitations);
      setTotalCount(result.totalCount);
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [committedSearch, statusFilter, page, pageSize, refreshToken, localRefreshToken]);

  const pageCount = Math.max(Math.ceil(totalCount / pageSize), 1);
  const currentPage = Math.min(page, pageCount - 1);
  const hasFilters = Boolean(committedSearch || statusFilter);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-neutral-900">Invitation History</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Everyone who has been invited to your organization, newest first.
        </p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="group relative w-full sm:flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-sky-500" />
          <input
            type="text"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search invitations by name or email..."
            aria-label="Search invitations"
            className={`${controlClass} w-full pl-9`}
          />
        </div>

        <div className="relative w-full shrink-0 sm:w-44">
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as InvitationStatus | "")}
            aria-label="Filter by invitation status"
            className={`${controlClass} w-full appearance-none truncate pr-9`}
          >
            {STATUS_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
        {/* aria-busy marks the rows as stale while a new page/search is
            in flight, so assistive tech doesn't read out results that are
            about to be replaced. */}
        <div aria-busy={isLoading} className="relative flex flex-col gap-2.5 p-4 sm:p-5">
          {invitations.length === 0 ? (
            <p className="rounded-xl bg-neutral-50 px-4 py-8 text-center text-sm text-neutral-400">
              {hasFilters ? "No invitations found." : "No invitations yet."}
            </p>
          ) : (
            invitations.map((invitation) => (
              <InvitationRow
                key={invitation.id}
                invitation={invitation}
                onChanged={() => setLocalRefreshToken((token) => token + 1)}
              />
            ))
          )}

          {isLoading ? (
            /* role="status" (an implicit polite live region) is what
               actually announces the sr-only text below. Without it the
               node is simply inserted and removed, and a screen-reader
               user gets no feedback at all that searching, filtering or
               paging is doing anything. */
            <div role="status" className="absolute inset-0 flex items-center justify-center rounded-2xl bg-white/70">
              <span
                aria-hidden="true"
                className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-200 border-t-sky-600"
              />
              <span className="sr-only">Loading invitations…</span>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col items-center justify-between gap-2 border-t border-neutral-100 px-4 py-3 sm:flex-row sm:px-5">
          <div className="flex items-center gap-2 text-xs text-neutral-500">
            <label htmlFor="invitation-rows-per-page">Rows Per Page</label>
            <select
              id="invitation-rows-per-page"
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
              Page {currentPage + 1} of {pageCount} &middot; {totalCount} invitation
              {totalCount === 1 ? "" : "s"}
            </p>
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
    </div>
  );
}

/**
 * One invitation. A stacked card rather than a real <table> row, the
 * same choice ContactRow and TaskRow already make in this app: it
 * reflows to one column on a phone with no horizontal scrolling, which a
 * seven-column table cannot do without either shrinking text or
 * overflowing.
 */
function InvitationRow({
  invitation,
  onChanged,
}: {
  invitation: InvitationListItem;
  onChanged: () => void;
}) {
  const badge = INVITATION_STATUS_BADGE[invitation.effectiveStatus];

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden="true"
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white ${getOwnerAvatarColor(invitation.id)}`}
        >
          {initials(invitation.full_name)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-neutral-900">{invitation.full_name}</p>
          <p className="flex items-center gap-1.5 truncate text-xs text-neutral-500">
            <MailIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
            <span className="truncate">{invitation.email}</span>
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs sm:shrink-0">
        <div className="min-w-[6rem]">
          <p className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">Role</p>
          <p className="mt-0.5 font-medium text-neutral-700">{formatRoleLabel(invitation.roleName)}</p>
        </div>

        <div className="min-w-[7rem]">
          <p className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">Manager</p>
          <p className="mt-0.5 truncate font-medium text-neutral-700">{invitation.managerName ?? "—"}</p>
        </div>

        <div className="min-w-[7rem]">
          <p className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">Membership</p>
          <p className={`mt-0.5 font-medium ${MEMBERSHIP_STATUS_CLASS[invitation.membershipStatus]}`}>
            {invitation.membershipStatus}
          </p>
        </div>

        <div className="min-w-[6.5rem]">
          <p className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">Invitation</p>
          <span
            className={`mt-0.5 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase ring-1 ring-inset ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>

        <div className="min-w-[6rem]">
          <p className="text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">Invited</p>
          <p className="mt-0.5 font-medium text-neutral-700">
            {dateFormatter.format(new Date(invitation.invited_at))}
          </p>
        </div>

        <InvitationActionsMenu invitation={invitation} onChanged={onChanged} />
      </div>
    </div>
  );
}
