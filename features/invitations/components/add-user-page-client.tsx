"use client";

import { useEffect, useState } from "react";
import { MessageBanner } from "@/components/shared/message-banner";
import { PlusIcon } from "@/features/sales-management/components/icons";
import { AddUserDialog } from "./add-user-dialog";
import { InvitationList } from "./invitation-list";
import type { AssignableRole } from "../lib/get-roles";
import type { InvitationsPage } from "../lib/get-invitations";
import type { TeamDirectoryEntry } from "@/types/lead";

type AddUserPageClientProps = {
  initialPage: InvitationsPage;
  roles: AssignableRole[];
  managerOptions: TeamDirectoryEntry[];
};

/**
 * The single client boundary this page needs, owning exactly one piece
 * of shared state (`refreshToken`) — the "+ Add User" button lives in
 * the page HEADER while the list it must refresh (InvitationList) is a
 * sibling below it, so the token is lifted to their nearest common
 * ancestor. The same relationship ContactsPageClient/ContactList and
 * TasksPageClient/TaskList already have.
 *
 * The success toast is a fixed bottom-right MessageBanner — this app's
 * existing "toast" convention (see CreateLeadDialog's own success toast
 * and PipelineView's drag-error toast), not a new notification system.
 */
export function AddUserPageClient({ initialPage, roles, managerOptions }: AddUserPageClientProps) {
  const [refreshToken, setRefreshToken] = useState(0);
  const [toast, setToast] = useState<{
    tone: "success" | "warning";
    title: string;
    detail?: string;
  } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Add User</h1>
          <span
            aria-hidden="true"
            className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
          />
          <p className="mt-1.5 text-sm text-neutral-500">
            Invite teammates to your organization and track every invitation you&rsquo;ve sent.
          </p>
        </div>

        <AddUserDialog
          roles={roles}
          managerOptions={managerOptions}
          onSuccess={(state, email) => {
            setRefreshToken((token) => token + 1);
            // The action reports created-but-not-emailed as success WITH
            // a formError. Showing "Invitation sent successfully." there
            // would be a lie, so the action's own honest wording is used
            // verbatim instead.
            setToast(
              state.formError
                ? { tone: "warning", title: "Invitation created", detail: state.formError }
                : {
                    tone: "success",
                    title: "Invitation sent",
                    detail: `An invitation has been sent to ${email}.`,
                  },
            );
          }}
          renderTrigger={(open) => (
            <button
              type="button"
              onClick={open}
              className="flex h-10 w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none sm:w-auto"
            >
              <PlusIcon className="h-4 w-4 shrink-0" />
              Add User
            </button>
          )}
        />
      </div>

      <InvitationList initialPage={initialPage} refreshToken={refreshToken} />

      {toast ? (
        <div className="fixed right-6 bottom-6 z-[1100] w-full max-w-xs shadow-lg">
          <MessageBanner tone={toast.tone}>
            <p className="font-semibold">{toast.title}</p>
            {toast.detail ? <p className="mt-0.5">{toast.detail}</p> : null}
          </MessageBanner>
        </div>
      ) : null}
    </div>
  );
}
