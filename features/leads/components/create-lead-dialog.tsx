"use client";

import { useActionState, useEffect, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Modal } from "@/components/shared/modal";
import { FormField } from "@/components/shared/form-field";
import { MessageBanner } from "@/components/shared/message-banner";
import { ChevronDownIcon, PlusIcon } from "@/features/sales-management/components/icons";
import { createLeadAction } from "../actions";
import { initialLeadFormState } from "../form-state";
import { LEAD_SOURCES, LEAD_STAGES } from "../schemas";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Adding..." : "Add Lead"}
    </button>
  );
}

/** Matches FormField's "filled" variant so every control in this form reads as one set. */
function SelectField({
  label,
  id,
  required,
  error,
  children,
  ...selectProps
}: {
  label: string;
  id: string;
  required?: boolean;
  error?: string;
  children: ReactNode;
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-neutral-700">
        {label}
        {required ? (
          <span className="text-red-500" aria-hidden="true">
            {" "}
            *
          </span>
        ) : null}
      </label>
      <div className="relative">
        <select
          id={id}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? errorId : undefined}
          aria-required={required}
          className={`w-full appearance-none rounded-lg border bg-neutral-100 px-3.5 py-2.5 pr-9 text-sm text-neutral-900 outline-none transition-colors focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 ${
            error ? "border-red-400" : "border-transparent"
          }`}
          {...selectProps}
        >
          {children}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-500" />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

type CreateLeadDialogProps = {
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
 * same-customer-safe owner FK enforcing tenant isolation underneath.
 * Mounted only while open, so each open starts from a clean, empty form
 * — including right after a successful create (see the state-reset
 * effect below).
 */
export function CreateLeadDialog({ owners, role, currentUserEmail }: CreateLeadDialogProps) {
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
        className="flex min-h-11 items-center gap-2 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-sky-600/20 transition-all duration-200 hover:-translate-y-0.5 hover:bg-sky-700 hover:shadow-lg hover:shadow-sky-600/30 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:ring-offset-2 focus-visible:outline-none"
      >
        <PlusIcon className="h-4 w-4 shrink-0" />
        New Lead
      </button>

      {isOpen ? (
        <Modal title="New Lead" onClose={() => setIsOpen(false)}>
          <form action={formAction} className="flex flex-col gap-4">
            <FormField
              label="Contact Name"
              name="contact_name"
              required
              variant="filled"
              error={fieldErrors.contact_name}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField
                label="Contact Number"
                name="phone"
                type="tel"
                required
                variant="filled"
                error={fieldErrors.phone}
              />
              <FormField label="Email" name="email" type="email" variant="filled" error={fieldErrors.email} />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <FormField label="Company" name="company" variant="filled" error={fieldErrors.company} />
              <FormField
                label="Deal Value (₹)"
                name="deal_value"
                type="number"
                min="0"
                step="0.01"
                variant="filled"
                error={fieldErrors.deal_value}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <SelectField
                label="Stage"
                id="lead-stage"
                name="stage"
                required
                defaultValue=""
                error={fieldErrors.stage}
              >
                <option value="" disabled>
                  Select a stage
                </option>
                {LEAD_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {stage}
                  </option>
                ))}
              </SelectField>

              {role === "ADMIN" ? (
                <SelectField label="Owner" id="lead-owner" name="owner_id" defaultValue="">
                  <option value="">Unassigned</option>
                  {owners.map((owner) => (
                    <option key={owner.customer_user_id} value={owner.customer_user_id}>
                      {owner.email}
                    </option>
                  ))}
                </SelectField>
              ) : (
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-neutral-700">Owner</label>
                  <input
                    type="text"
                    value={currentUserEmail}
                    disabled
                    readOnly
                    aria-readonly="true"
                    className="w-full cursor-not-allowed rounded-lg border border-transparent bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-500 outline-none"
                  />
                </div>
              )}
            </div>

            <SelectField label="Source" id="lead-source" name="source" defaultValue="">
              <option value="">Select a source</option>
              {LEAD_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </SelectField>

            <FormField
              label="Next Step"
              name="next_step"
              variant="filled"
              placeholder="e.g. Send proposal"
              error={fieldErrors.next_step}
            />

            {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}

            <div className="mt-2 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
              >
                Cancel
              </button>
              <SubmitButton />
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
