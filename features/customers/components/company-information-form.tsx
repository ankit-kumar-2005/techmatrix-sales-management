"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { FormField } from "@/components/shared/form-field";
import { MessageBanner } from "@/components/shared/message-banner";
import type { Customer } from "@/types/customer";
import { updateCustomerAction } from "../actions";
import { initialCustomerFormState } from "../form-state";

function SaveButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Saving..." : "Save Changes"}
    </button>
  );
}

type CompanyInformationFormProps = {
  customer: Customer;
  /** Only the Primary Admin (customers.created_by === current user) may
   *  edit — enforced again, independently, server-side in
   *  updateCustomerAction and by the "admins can update their customer"
   *  RLS policy. This prop only controls the UI. */
  canEdit: boolean;
};

export function CompanyInformationForm({ customer, canEdit }: CompanyInformationFormProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [state, formAction] = useActionState(updateCustomerAction, initialCustomerFormState);
  const fieldErrors = state.fieldErrors ?? {};

  // Switch back to read-only after a successful save. Adjusting state
  // during render (React's documented pattern for this) instead of in a
  // useEffect avoids an extra cascading render.
  const [lastHandledState, setLastHandledState] = useState(state);
  if (state !== lastHandledState) {
    setLastHandledState(state);
    if (state.success && isEditing) {
      setIsEditing(false);
    }
  }

  const readOnly = !canEdit || !isEditing;

  return (
    <form action={formAction} className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Company Profile</h2>

        <FormField
          label="Company Name"
          name="company_name"
          defaultValue={customer.company_name ?? ""}
          disabled={readOnly}
          error={fieldErrors.company_name}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <FormField
              label="Company Email"
              name="email"
              type="email"
              defaultValue={customer.email}
              disabled
            />
            <p className="mt-1.5 text-xs text-neutral-500">🔒 Customer email cannot be changed.</p>
          </div>
          <FormField
            label="Company Phone"
            name="phone"
            type="tel"
            required
            defaultValue={customer.phone}
            disabled={readOnly}
            error={fieldErrors.phone}
          />
        </div>

        <FormField
          label="Website"
          name="website"
          type="url"
          defaultValue={customer.website ?? ""}
          disabled={readOnly}
          error={fieldErrors.website}
        />
      </div>

      <div className="flex flex-col gap-4 border-t border-neutral-100 pt-6">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">Address</h2>

        <FormField
          label="Address"
          name="address"
          defaultValue={customer.address ?? ""}
          disabled={readOnly}
          error={fieldErrors.address}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <FormField label="City" name="city" defaultValue={customer.city ?? ""} disabled={readOnly} error={fieldErrors.city} />
          <FormField
            label="State"
            name="state"
            defaultValue={customer.state ?? ""}
            disabled={readOnly}
            error={fieldErrors.state}
          />
          <FormField
            label="Country"
            name="country"
            defaultValue={customer.country ?? ""}
            disabled={readOnly}
            error={fieldErrors.country}
          />
        </div>
      </div>

      {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}
      {state.success ? (
        <MessageBanner tone="success">Company information saved successfully.</MessageBanner>
      ) : null}

      {canEdit ? (
        <div className="flex gap-3 border-t border-neutral-100 pt-6">
          {isEditing ? (
            <>
              <SaveButton />
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setIsEditing(true)}
              className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
            >
              Edit
            </button>
          )}
        </div>
      ) : null}
    </form>
  );
}
