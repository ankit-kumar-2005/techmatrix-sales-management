"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { ContactsIcon } from "@/features/sales-management/components/icons";
import { createContactAction } from "../actions";
import { initialContactFormState } from "../form-state";
import { ContactFormFields, ContactFormSubmitButton } from "./contact-form-fields";
import type { TeamDirectoryEntry } from "@/types/lead";

type NewContactDialogProps = {
  assignableUsers: TeamDirectoryEntry[];
  currentUserCustomerUserId: string;
  renderTrigger: (open: () => void) => ReactNode;
  /** Called after a successful create (in addition to closing the dialog
   *  and showing the success toast) — ContactList uses this to bump its
   *  shared refreshToken, so the list re-fetches and the new contact
   *  shows up without the user navigating away and back. */
  onSuccess?: () => void;
};

/**
 * One real INSERT into public.contacts via createContactAction, RLS +
 * the composite same-customer-safe lead FK and owner FK enforcing tenant
 * isolation and hierarchy-scoped ownership underneath. Mounted only
 * while open, so each open starts from a clean, empty form — including
 * right after a successful create, matching AddTaskDialog's own
 * identical render-time close pattern.
 */
export function NewContactDialog({
  assignableUsers,
  currentUserCustomerUserId,
  renderTrigger,
  onSuccess,
}: NewContactDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [state, formAction] = useActionState(createContactAction, initialContactFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Close-on-success (self-owned isOpen, safe to adjust during render —
  // same reasoning as AddTaskDialog's identical block) and show a toast.
  // A failed create leaves isOpen untouched, so the dialog stays open
  // with the user's entered values intact and state.formError renders
  // below.
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success && isOpen) {
      setIsOpen(false);
      setShowSuccessToast(true);
    }
  }

  useEffect(() => {
    if (!showSuccessToast) return;
    const timer = setTimeout(() => setShowSuccessToast(false), 4000);
    return () => clearTimeout(timer);
  }, [showSuccessToast]);

  // onSuccess calls into the PARENT (ContactList bumping its shared
  // refreshToken) — must happen in an effect, not during this
  // component's own render (the isOpen/showSuccessToast handling above
  // is a different, safe case only because both are this component's
  // own state) — same pattern and reasoning as AddTaskDialog's identical
  // effect.
  useEffect(() => {
    if (state.success) {
      onSuccess?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onSuccess intentionally excluded: a fresh closure every parent render, re-running this effect for that alone would re-fire onSuccess without state actually changing
  }, [state]);

  return (
    <>
      {renderTrigger(() => setIsOpen(true))}

      {isOpen ? (
        <Modal
          title="New contact"
          subtitle="Add someone you deal with to your directory."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 ring-1 ring-sky-100">
              <ContactsIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setIsOpen(false)}
        >
          <form action={formAction} className="flex flex-col gap-5">
            <ContactFormFields
              assignableUsers={assignableUsers}
              currentUserCustomerUserId={currentUserCustomerUserId}
              fieldErrors={fieldErrors}
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
              <ContactFormSubmitButton idleLabel="Add contact" pendingLabel="Adding..." />
            </div>
          </form>
        </Modal>
      ) : null}

      {showSuccessToast ? (
        <div className="fixed right-6 bottom-6 z-[1100] w-full max-w-xs shadow-lg">
          <MessageBanner tone="success">Contact added successfully.</MessageBanner>
        </div>
      ) : null}
    </>
  );
}
