"use client";

import { useActionState, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { TagIcon } from "@/features/sales-management/components/icons";
import { updateCatalogItemAction } from "../actions";
import { initialCatalogItemFormState } from "../form-state";
import { CatalogItemFormFields, CatalogItemFormSubmitButton } from "./catalog-item-form-fields";
import type { CatalogItem } from "@/types/catalog";

type EditCatalogItemDialogProps = {
  item: CatalogItem;
  /** Called after a successful save (in addition to closing the dialog)
   *  so the caller (the paginated grid) can re-fetch whatever it's
   *  currently showing — same search/filter/page, unlike creating a
   *  new item, which resets to page 1 instead (see
   *  NewCatalogItemDialog's own onSuccess). Optional so this dialog
   *  still works if a future consumer has no such grid to refresh. */
  onSuccess?: () => void;
  /** Supplies the trigger that opens this dialog, given an `open`
   *  callback — the same externally-supplied-trigger convention
   *  AddTaskDialog/NewContactDialog already use. CatalogItemCard passes
   *  its combined actions menu's "Edit" item here instead of this
   *  component rendering its own visible pencil button, so Edit and
   *  Activate/Deactivate can live inside one shared menu (see
   *  CatalogItemActionsMenu). */
  renderTrigger: (open: () => void) => ReactNode;
};

/**
 * Dialog-only now — no longer renders its own trigger button.
 * CatalogItemCard supplies the trigger via `renderTrigger` (see
 * CatalogItemActionsMenu's "Edit" menu item), so this component owns
 * only isOpen/the form itself; each open still starts from the item's
 * current values rather than carrying over anything from a previous
 * edit. Only ever reachable through a menu CatalogItemCard renders for
 * an ADMIN (see app/(app)/catalog/page.tsx's canManage) — a UX
 * convenience, not the security boundary: updateCatalogItemAction
 * re-checks the role independently, and RLS ("admins can update their
 * customer's catalog items") is what actually holds regardless.
 *
 * Reuses CatalogItemFormFields — the exact same fields/markup
 * NewCatalogItemDialog renders — pre-filled via defaultValues and
 * posting to updateCatalogItemAction instead of createCatalogItemAction.
 * Not a second catalog item form.
 */
export function EditCatalogItemDialog({ item, onSuccess, renderTrigger }: EditCatalogItemDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, formAction] = useActionState(updateCatalogItemAction, initialCatalogItemFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Same self-owned-state render-time close pattern as every other
  // dialog in this app (see NewCatalogItemDialog's own comment) — safe
  // here because isOpen belongs to this component, not a caller's.
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success && isOpen) {
      setIsOpen(false);
    }
  }

  // onSuccess calls into the PARENT (CatalogItemsGrid re-fetching its
  // current page) — must happen in an effect, not during this
  // component's own render, for the same reason NewCatalogItemDialog's
  // identical effect does.
  useEffect(() => {
    if (state.success) {
      onSuccess?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSuccess intentionally excluded: see NewCatalogItemDialog's identical effect
  }, [state]);

  return (
    <>
      {renderTrigger(() => setIsOpen(true))}

      {isOpen ? (
        <Modal
          title="Edit catalog item"
          subtitle={`Update ${item.name}'s details.`}
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-teal-50 to-teal-100 text-teal-700 ring-1 ring-teal-100">
              <TagIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setIsOpen(false)}
        >
          <form action={formAction} className="flex flex-col gap-5">
            <input type="hidden" name="id" value={item.id} />

            <CatalogItemFormFields
              fieldErrors={fieldErrors}
              defaultValues={{
                name: item.name,
                category: item.category,
                price: item.price,
                pricing_unit: item.pricing_unit,
                description: item.description,
              }}
            />

            {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

            <div className="sticky bottom-0 -mx-6 -mb-5 flex justify-end gap-3 border-t border-neutral-100 bg-white px-6 py-4">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
              >
                Cancel
              </button>
              <CatalogItemFormSubmitButton idleLabel="Save changes" pendingLabel="Saving..." />
            </div>
          </form>
        </Modal>
      ) : null}
    </>
  );
}
