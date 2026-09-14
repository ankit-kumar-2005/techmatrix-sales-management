"use client";

import { useActionState, useEffect } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { updateContactAction } from "../actions";
import { initialContactFormState } from "../form-state";
import { ContactFormFields, ContactFormSubmitButton } from "./contact-form-fields";
import { ContactsIcon } from "@/features/sales-management/components/icons";
import type { ContactListItem } from "../lib/get-contacts";
import type { TeamDirectoryEntry } from "@/types/lead";

type EditContactDialogProps = {
  contact: ContactListItem;
  /** Already resolved by the caller (ContactList already has this
   *  contact's linked-lead label on hand from its own bounded
   *  leadLabels — the same page of contacts this dialog was opened
   *  from), so this dialog no longer needs the full customer Lead list
   *  just to derive one string via .find(). */
  lockedLeadLabel: string;
  assignableUsers: TeamDirectoryEntry[];
  currentUserCustomerUserId: string;
  onClose: () => void;
};

/**
 * Contacts' Edit action — reuses ContactFormFields (the same component
 * NewContactDialog uses), same pattern as EditLeadDialog reusing
 * LeadFormFields: one shared fields component, two dialogs (create vs.
 * edit), never two separate forms. Only ever mounted for a contact
 * ContactList has already fetched (and therefore one the caller could
 * already see under RLS's "hierarchy-aware contact visibility" policy),
 * but that's a UX convenience, not the security boundary —
 * updateContactAction and RLS's "visible-hierarchy members can update a
 * contact" policy (is_customer_user_visible(owner_id) on both USING and
 * WITH CHECK) independently re-verify authorization on every submit,
 * including against whatever owner_id the caller reassigns it to.
 */
export function EditContactDialog({
  contact,
  lockedLeadLabel,
  assignableUsers,
  currentUserCustomerUserId,
  onClose,
}: EditContactDialogProps) {
  const [state, formAction] = useActionState(updateContactAction, initialContactFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Closing this dialog means calling the PARENT's (ContactList's)
  // setEditingContact(null) — a different component's state, so this
  // must happen in an effect, not during this component's own render —
  // same pattern and reasoning as EditLeadDialog's identical effect.
  useEffect(() => {
    if (state.success) {
      onClose();
    }
  }, [state, onClose]);

  return (
    <Modal
      title="Edit Contact"
      subtitle="Update this contact's details."
      icon={
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 ring-1 ring-sky-100">
          <ContactsIcon className="h-5 w-5" />
        </span>
      }
      onClose={onClose}
    >
      <form action={formAction} className="flex flex-col gap-5">
        <input type="hidden" name="id" value={contact.id} />

        <ContactFormFields
          assignableUsers={assignableUsers}
          currentUserCustomerUserId={currentUserCustomerUserId}
          fieldErrors={fieldErrors}
          lockedLeadLabel={lockedLeadLabel}
          defaultValues={{
            name: contact.name,
            company: contact.company,
            title: contact.title,
            email: contact.email,
            phone: contact.phone,
            tags: contact.tags,
            owner_id: contact.owner_id,
          }}
        />

        {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

        <div className="sticky bottom-0 -mx-6 -mb-5 flex justify-end gap-3 border-t border-neutral-100 bg-white px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
          >
            Cancel
          </button>
          <ContactFormSubmitButton idleLabel="Save Changes" pendingLabel="Saving..." />
        </div>
      </form>
    </Modal>
  );
}
