"use client";

import { useState, useTransition } from "react";
import { MoreVerticalIcon, PauseCircleIcon, PencilIcon, RefreshIcon } from "@/features/sales-management/components/icons";
import { setCatalogItemStatusAction } from "../actions";
import type { CatalogItemListItem } from "../lib/get-catalog-items";

type CatalogItemActionsMenuProps = {
  item: CatalogItemListItem;
  /** Opens EditCatalogItemDialog — passed straight through from
   *  CatalogItemCard, which supplies this menu as that dialog's
   *  renderTrigger. Selecting "Edit" closes this menu and calls it;
   *  it does not itself know or care what opens. */
  onEdit: () => void;
  /** Called after a successful status change so the caller (the
   *  paginated grid) can refresh whatever it's currently showing —
   *  same current search/filter/page, not reset to page 1. Optional so
   *  this component still works standalone if a future consumer has no
   *  such refresh to do. */
  onChanged?: () => void;
};

/**
 * Formerly CatalogItemStatusMenu (Activate/Deactivate only) — renamed
 * and expanded into the single "⋮" action menu for a catalog item, now
 * that the card no longer has its own separate visible pencil/Edit
 * button. Edit is just another menu item here; it doesn't run any edit
 * logic itself, only calls the onEdit callback EditCatalogItemDialog
 * supplies via renderTrigger.
 *
 * Only ever rendered by CatalogItemCard for an ADMIN — see
 * app/(app)/catalog/page.tsx's canManage check. UX convenience only:
 * setCatalogItemStatusAction/updateCatalogItemAction both re-check the
 * role independently, and RLS ("admins can update their customer's
 * catalog items") is what actually holds if either were ever bypassed.
 *
 * Activate/Deactivate keeps its original behavior exactly: no
 * confirmation step, no success message — selecting it calls
 * setCatalogItemStatusAction immediately, and the card's own status
 * pill/styling (driven by `item`, refreshed via onChanged) is the only
 * feedback for a successful change. A failure is still surfaced, but as
 * a plain inline line inside this already-open menu — never a separate
 * floating/fixed element.
 *
 * Same local click-outside/keyboard-accessible dropdown implementation
 * as before (no shared dropdown primitive exists yet in this project) —
 * reused here rather than rebuilt, per this project's "start local,
 * don't invent a second menu component" convention.
 */
export function CatalogItemActionsMenu({ item, onEdit, onChanged }: CatalogItemActionsMenuProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Never both actions at once — exactly one, matching the item's
  // current status. nextStatus is derived fresh from `item.status`
  // (a prop) rather than stored separately, so there's nothing that
  // could drift out of sync with it.
  const nextStatus = item.status === "Active" ? "Inactive" : "Active";
  const actionLabel = nextStatus === "Inactive" ? "Make inactive" : "Make active";
  const pendingLabel = nextStatus === "Inactive" ? "Deactivating..." : "Activating...";
  const ActionIcon = nextStatus === "Inactive" ? PauseCircleIcon : RefreshIcon;

  function handleEdit() {
    setIsMenuOpen(false);
    onEdit();
  }

  function handleToggleStatus() {
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
        className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
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
          {/* Opens UPWARD (bottom-full, not top-full) — this trigger now
              lives in the card's bottom price row, so opening downward
              would place the whole menu below the card entirely (outside
              it, overlapping whatever grid row comes next) instead of
              reading as "belonging" to this card. */}
          <div
            role="menu"
            aria-label={`Actions for ${item.name}`}
            className="absolute right-0 bottom-full z-20 mb-1 w-48 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-black/5"
          >
            <button
              type="button"
              role="menuitem"
              onClick={handleEdit}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50"
            >
              <PencilIcon className="h-4 w-4 text-neutral-400" />
              Edit
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={handleToggleStatus}
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
