"use client";

import { useState, type ReactNode } from "react";
import { NewContactDialog } from "./new-contact-dialog";
import { ContactList } from "./contact-list";
import { PlusIcon } from "@/features/sales-management/components/icons";
import type { ContactsPage } from "../lib/get-contacts";
import type { TeamDirectoryEntry } from "@/types/lead";

type ContactsPageClientProps = {
  initialPage: ContactsPage;
  initialSearch: string;
  initialLeadId: string;
  /** The already-Suspense-wrapped <DuplicateContactsPanel /> element,
   *  instantiated by the page (a Server Component) and passed down as an
   *  opaque slot (Phase 7) — this component doesn't fetch duplicate
   *  candidates or run Fuse.js itself, and doesn't need to know that the
   *  element it's rendering here is a Server Component streamed in later;
   *  it just renders it in the same position DuplicateContactsSection
   *  used to occupy directly. */
  duplicatesPanel: ReactNode;
  /** The caller's own hierarchy-visible teammates (getVisibleTeamDirectory)
   *  — used both for the New Contact dialog's Owner picker and for
   *  resolving each listed contact's owner display (initials/label),
   *  same source/shape TaskList already uses for assignees. */
  assignableUsers: TeamDirectoryEntry[];
  currentUserCustomerUserId: string;
};

/**
 * The single client boundary the Contacts page needs, owning exactly one
 * piece of shared state (`refreshToken`) — the "+ New contact" button
 * lives in the page HEADER (top-right, next to the heading, matching the
 * reference design) while the list it needs to refresh
 * (ContactList) is a sibling further down the page; lifting just this
 * one token to their nearest common ancestor is the standard React
 * pattern for that, the same relationship TaskList's own toolbar/
 * refreshToken already has, just inverted (there refreshToken's owner
 * and the "Add task" trigger are the same component; here the trigger
 * needed to move up a level to match this page's own layout).
 */
export function ContactsPageClient({
  initialPage,
  initialSearch,
  initialLeadId,
  duplicatesPanel,
  assignableUsers,
  currentUserCustomerUserId,
}: ContactsPageClientProps) {
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Contacts</h1>
          <span
            aria-hidden="true"
            className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
          />
          <p className="mt-1.5 text-sm text-neutral-500">
            Everyone you deal with — active leads, customers, and partners — in one directory.
          </p>
        </div>

        <NewContactDialog
          assignableUsers={assignableUsers}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onSuccess={() => setRefreshToken((token) => token + 1)}
          renderTrigger={(open) => (
            <button
              type="button"
              onClick={open}
              className="flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none sm:w-auto"
            >
              <PlusIcon className="h-4 w-4 shrink-0" />
              New contact
            </button>
          )}
        />
      </div>

      {duplicatesPanel}

      <ContactList
        initialPage={initialPage}
        initialSearch={initialSearch}
        initialLeadId={initialLeadId}
        refreshToken={refreshToken}
        assignableUsers={assignableUsers}
        currentUserCustomerUserId={currentUserCustomerUserId}
      />
    </div>
  );
}
