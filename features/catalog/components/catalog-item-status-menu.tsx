"use client";

import { useState, useTransition } from "react";
import { MoreVerticalIcon, PauseCircleIcon, RefreshIcon } from "@/features/sales-management/components/icons";
import { setCatalogItemStatusAction } from "../actions";
import type { CatalogItem } from "@/types/catalog";

type CatalogItemStatusMenuProps = {
  item: CatalogItem;
  /** Called after a successful status change so the caller (the
   *  paginated grid) can refresh whatever it's currently showing —
   *  same current search/filter/page, not reset to page 1. Optional so
   *  this component still works standalone if a future consumer has no
   *  such refresh to do. */
  onChanged?: () => void;
};

/**
 * Only ever rendered by CatalogItemCard for an ADMIN — see
 * app/(app)/catalog/page.tsx's canManage check. UX convenience only:
 * setCatalogItemStatusAction re-checks the role independently, and RLS
 * ("admins can update their customer's catalog items") is what actually
 * holds if either were ever bypassed.
 *
 * No confirmation step and no success message at all — selecting the
 * menu item calls setCatalogItemStatusAction immediately, and the
 * card's own status pill/styling (driven by `item`, refreshed via
 * onChanged) is the only feedback for a successful change. A failure is
 * still surfaced, but as a plain inline line inside this already-open
 * menu — never a separate floating/fixed element — so there is nothing
 * here that can require a click to dismiss, and nothing positioned in a
 * way an ancestor's hover transform could ever trap (the bug that used
 * to make a previous version of this component's toast render "inside"
 * the card — see Modal's own comment for the full explanation of that
 * CSS containing-block issue).
 *
 * No dropdown/menu primitive existed anywhere in this project yet, so
 * this is a small, local one (click-outside via a full-screen invisible
 * button) — not promoted to components/shared/ since this is its only
 * consumer so far, matching this project's own "start local" convention.
 */
export function CatalogItemStatusMenu({ item, onChanged }: CatalogItemStatusMenuProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Never both actions at once — exactly one, matching the item's
  // current status. nextStatus is derived fresh from `item.status`
  // (a prop) rather than stored separately, so there's nothing that
  // could drift out of sync with it.
  const nextStatus = item.status === "Active" ? "Inactive" : "Active";
  const actionLabel = nextStatus === "Inactive" ? "Deactivate" : "Activate";
  const pendingLabel = nextStatus === "Inactive" ? "Deactivating..." : "Activating...";
  const ActionIcon = nextStatus === "Inactive" ? PauseCircleIcon : RefreshIcon;

  function handleSelect() {
    setError(null);
    startTransition(async () => {
      const result = await setCatalogItemStatusAction(item.id, nextStatus);
      if (!result.success) {
        // Keep the menu open so the error has somewhere non-blocking to
        // live, right next to the action that failed.
        setError(result.error ?? "Unable to update this item. Please try again.");
        return;
      }
      setIsMenuOpen(false);
      onChanged?.();
    });
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setIsMenuOpen((open) => !open)}
        disabled={isPending}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-label={`Actions for ${item.name}`}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <MoreVerticalIcon className="h-4 w-4" />
      </button>

      {isMenuOpen ? (
        <>
          {/* Click-outside-to-close — an invisible full-screen button
              behind the menu, same technique this project has no
              existing primitive for yet (there's no shared dropdown to
              reuse), rather than a document-level listener. */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setIsMenuOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            aria-label={`Actions for ${item.name}`}
            className="absolute top-full right-0 z-20 mt-1 w-48 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-black/5"
          >
            <button
              type="button"
              role="menuitem"
              onClick={handleSelect}
              disabled={isPending}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ActionIcon className="h-4 w-4 text-neutral-400" />
              {isPending ? pendingLabel : actionLabel}
            </button>
            {error ? (
              <p role="alert" className="px-3 pt-1.5 pb-1 text-xs text-red-600">
                {error}
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
