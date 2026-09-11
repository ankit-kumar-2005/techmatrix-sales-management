"use client";

import { useActionState, useEffect, useState } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { LeadCaptureIcon, PlusIcon } from "@/features/sales-management/components/icons";
import { createLeadAction } from "../actions";
import { initialLeadFormState } from "../form-state";
import { LeadFormFields, LeadFormSubmitButton } from "./lead-form-fields";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

type CreateLeadDialogProps = {
  /** Every one of this customer's stages, ordered by display_order —
   *  LeadFormFields itself narrows this to Active-only here (a brand-new
   *  lead has no defaultValues.stage_id to keep an inactive one
   *  selectable), the same order used everywhere else (filter, board,
   *  legend). This is the entire dropdown; there is no fixed fallback
   *  list. */
  stages: CustomerLeadStage[];
  owners: TeamDirectoryEntry[];
  /** Only ADMIN gets an editable Owner picker — everyone else gets a
   *  read-only display of themselves, since createLeadAction forces
   *  owner_id to the caller's own id for every non-admin role. */
  role: CustomerRole;
  currentUserEmail: string;
};

/**
 * The one new piece of functionality this page gains: a real INSERT
 * into public.leads via createLeadAction, RLS + the composite
 * same-customer-safe owner/stage FKs enforcing tenant isolation
 * underneath. Mounted only while open, so each open starts from a clean,
 * empty form — including right after a successful create (see the
 * state-reset effect below).
 */
export function CreateLeadDialog({ stages, owners, role, currentUserEmail }: CreateLeadDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [showSuccessToast, setShowSuccessToast] = useState(false);
  const [state, formAction] = useActionState(createLeadAction, initialLeadFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Close the dialog once a create succeeds. Comparing to a ref-like
  // state value (React's documented "adjust state during render"
  // pattern) instead of useEffect, matching CompanyInformationForm.
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success && isOpen) {
      setIsOpen(false);
      setShowSuccessToast(true);
    }
  }

  // The toast outlives the dialog (which unmounts on close), so it's a
  // sibling of the Modal, not something rendered inside it — and it
  // self-dismisses rather than requiring the user to notice/close it.
  useEffect(() => {
    if (!showSuccessToast) return;
    const timer = setTimeout(() => setShowSuccessToast(false), 4000);
    return () => clearTimeout(timer);
  }, [showSuccessToast]);

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="flex min-h-11 items-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/30 transition-all duration-200 hover:-translate-y-0.5 hover:from-blue-700 hover:to-violet-700 hover:shadow-xl hover:shadow-blue-600/40 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <PlusIcon className="h-4 w-4 shrink-0" />
        New Lead
      </button>

      {isOpen ? (
        <Modal
          title="New Lead"
          subtitle="Add a new lead to your pipeline."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 ring-1 ring-sky-100">
              <LeadCaptureIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setIsOpen(false)}
        >
          <form action={formAction} className="flex flex-col gap-5">
            <LeadFormFields
              stages={stages}
              owners={owners}
              role={role}
              currentUserEmail={currentUserEmail}
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
              <LeadFormSubmitButton idleLabel="Add Lead" pendingLabel="Adding..." />
            </div>
          </form>
        </Modal>
      ) : null}

      {showSuccessToast ? (
        <div className="fixed right-6 bottom-6 z-[1100] w-full max-w-xs shadow-lg">
          <MessageBanner tone="success">Lead created successfully.</MessageBanner>
        </div>
      ) : null}
    </>
  );
}
