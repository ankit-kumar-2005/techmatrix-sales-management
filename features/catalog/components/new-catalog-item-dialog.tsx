"use client";

import { useActionState, useEffect, useState } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { PlusIcon, TagIcon } from "@/features/sales-management/components/icons";
import { createCatalogItemAction } from "../actions";
import { initialCatalogItemFormState } from "../form-state";
import { CatalogItemFormFields, CatalogItemFormSubmitButton } from "./catalog-item-form-fields";

type NewCatalogItemDialogProps = {
  /** "button" (default) renders the "+ Add item" pill trigger used in
   *  the page header. "ghostCard" renders a dashed, grid-shaped trigger
   *  meant to sit as the last tile in the items grid — a second,
   *  purely visual entry point to the *same* createCatalogItemAction
   *  flow, not a second piece of creation logic. Each variant owns its
   *  own isOpen/form state independently (only one is ever mounted-open
   *  at a time in practice, since a person only clicks one trigger),
   *  which keeps this component self-contained rather than needing a
   *  shared-state wrapper for what is otherwise a purely cosmetic
   *  choice of trigger. */
  variant?: "button" | "ghostCard";
  /** Called after a successful create (in addition to closing the
   *  dialog). The two "ghostCard" instances inside CatalogItemsGrid pass
   *  a callback that resets its search/category filter and jumps back to
   *  page 1, so a newly created item is visible immediately regardless
   *  of whatever filter/page the caller was previously looking at. The
   *  header ("button") instance is a separate mount owned by
   *  CatalogPageClient, one level up — its own onSuccess only bumps a
   *  shared refreshToken, since it has no direct access to the grid's
   *  own internal filter state (see CatalogPageClient's own comment on
   *  that tradeoff). Optional so this dialog still works if a future
   *  consumer has no such grid to refresh at all. */
  onSuccess?: () => void;
};

/**
 * Only ever rendered by the Catalog page for an ADMIN — see
 * app/(app)/catalog/page.tsx. That's a UX convenience, not the security
 * boundary: createCatalogItemAction re-checks the role independently,
 * and RLS ("admins can create catalog items for their customer") is
 * what actually holds if either of those were ever wrong or bypassed.
 * Mounted only while open, so each open starts from a clean, empty
 * form — including right after a successful create.
 *
 * Its fields (CatalogItemFormFields) are shared with
 * EditCatalogItemDialog — same markup, same field names, so the two
 * forms can never drift apart. Only the outer shell (trigger, title,
 * hidden id, and which action the form posts to) differs between them.
 */
export function NewCatalogItemDialog({ variant = "button", onSuccess }: NewCatalogItemDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, formAction] = useActionState(createCatalogItemAction, initialCatalogItemFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // "Adjust state during render" close-on-success — this dialog's own
  // isOpen state, not a parent's, so it's safe to update synchronously
  // during render (the same pattern CreateLeadDialog uses, and for the
  // same reason it's safe there: self-owned state only).
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success && isOpen) {
      setIsOpen(false);
    }
  }

  // onSuccess calls into the PARENT (CatalogItemsGrid re-fetching/
  // resetting its own state) — a different component's state, which
  // must happen in an effect, never synchronously during this
  // component's own render (that's exactly the "Cannot update a
  // component while rendering a different component" hazard
  // EditLeadDialog's own onClose comment warns about; the isOpen
  // handling above is a different, safe case only because it's this
  // component's own state). Re-fires only when `state` itself becomes a
  // new object, so a successful create notifies the parent exactly once.
  useEffect(() => {
    if (state.success) {
      onSuccess?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSuccess intentionally excluded: it's a fresh closure on every parent render, and re-running this effect for that alone would re-fire onSuccess without state actually changing
  }, [state]);

  return (
    <>
      {variant === "ghostCard" ? (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-label="Add a new catalog item"
          className="flex h-full min-h-[11rem] w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-teal-200 bg-teal-50/30 text-teal-700 transition-all duration-200 hover:-translate-y-0.5 hover:border-teal-400 hover:bg-teal-50 focus-visible:ring-2 focus-visible:ring-teal-500/40 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-sky-100 text-sky-600">
            <PlusIcon className="h-6 w-6" />
          </span>
          <span className="text-sm font-semibold">Add Item</span>
          <span className="max-w-[14rem] text-center text-xs font-normal text-neutral-500">
            Add a product or service to your catalog
          </span>
        </button>
      ) : (
        // Header trigger — same background/text/radius/hover/shadow/
        // typography/icon as Pipeline's own "+ New Lead" button
        // (create-lead-dialog.tsx), reused verbatim rather than a new
        // color invented for this page, per the explicit "Catalog should
        // feel like the same application action" requirement. Only ever
        // rendered in the page HEADER now (CatalogPageClient) — the
        // in-grid toolbar instance this variant used to serve was
        // removed, not just restyled in place.
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="flex min-h-11 items-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/30 transition-all duration-200 hover:-translate-y-0.5 hover:from-blue-700 hover:to-violet-700 hover:shadow-xl hover:shadow-blue-600/40 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <PlusIcon className="h-4 w-4 shrink-0" />
          Add Item
        </button>
      )}

      {isOpen ? (
        <Modal
          title="New Catalog Item"
          subtitle="Add something your team can attach to a proposal."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-50 to-teal-100 text-teal-700 ring-1 ring-teal-100">
              <TagIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setIsOpen(false)}
        >
          <form action={formAction} className="flex flex-col gap-5">
            <CatalogItemFormFields fieldErrors={fieldErrors} />

            {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

            <div className="sticky bottom-0 -mx-6 -mb-5 flex justify-end gap-3 border-t border-neutral-100 bg-white px-6 py-4">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
              >
                Cancel
              </button>
              <CatalogItemFormSubmitButton idleLabel="Add Item" pendingLabel="Adding..." />
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
