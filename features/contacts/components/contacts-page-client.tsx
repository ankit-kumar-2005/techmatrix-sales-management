"use client";

import { useState } from "react";
import { NewContactDialog } from "./new-contact-dialog";
import { DuplicateContactsSection } from "./duplicate-contacts-section";
import { ContactList } from "./contact-list";
import { PlusIcon } from "@/features/sales-management/components/icons";
import type { ContactsPage } from "../lib/get-contacts";
import type { DuplicatePair } from "../lib/duplicate-detection";
import type { Lead, TeamDirectoryEntry } from "@/types/lead";

type ContactsPageClientProps = {
  initialPage: ContactsPage;
  initialSearch: string;
  initialLeadId: string;
  initialDuplicatePairs: DuplicatePair[];
  leads: Lead[];
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
  initialDuplicatePairs,
  leads,
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
          leads={leads}
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

      <DuplicateContactsSection initialPairs={initialDuplicatePairs} />

      <ContactList
        initialPage={initialPage}
        initialSearch={initialSearch}
        initialLeadId={initialLeadId}
        refreshToken={refreshToken}
        assignableUsers={assignableUsers}
        leads={leads}
        currentUserCustomerUserId={currentUserCustomerUserId}
      />
    </div>
  );
}
