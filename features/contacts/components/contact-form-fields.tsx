"use client";

import { useMemo } from "react";
import { useFormStatus } from "react-dom";
import { FormField } from "@/components/shared/form-field";
import { SelectField } from "@/components/shared/select-field";
import { FormSection } from "@/components/shared/form-section";
import { LeadSearchSelect } from "@/features/leads/components/lead-search-select";
// Reused directly from features/leads, the same way TaskFormFields
// already does — this is the shared owner-label-disambiguation logic
// every owner/assignee picker in this app uses, not a Contact-specific
// reimplementation of it.
import { getOwnerDisplayLabels } from "@/features/leads/lib/owner-display";
import { ContactsIcon, LeadCaptureIcon, UserPlusIcon } from "@/features/sales-management/components/icons";
import type { TeamDirectoryEntry } from "@/types/lead";

/** Same look as TaskFormSubmitButton/LeadFormSubmitButton elsewhere in
 *  this app. */
export function ContactFormSubmitButton({ idleLabel, pendingLabel }: { idleLabel: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-sm"
    >
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}

type ContactFormFieldsProps = {
  /** The caller's own hierarchy-visible teammates (getVisibleTeamDirectory)
   *  — ADMIN gets everyone in the customer, everyone else gets themselves
   *  + their recursive reports, the SAME list and SAME RPC
   *  TaskFormFields' own "Assign" field already uses. A SALES_REP's own
   *  list naturally contains only themselves (no reports), so "Owner
   *  defaults to and is effectively locked to self" falls out of this
   *  list being short — no separate read-only branch needed here, the
   *  same reasoning TaskFormFields' Assign field already relies on. */
  assignableUsers: TeamDirectoryEntry[];
  /** Preselects Owner to the current user on a new contact — still
   *  changeable by anyone whose assignableUsers list has more than one
   *  entry. */
  currentUserCustomerUserId: string;
  fieldErrors: Record<string, string>;
  /** Present only when editing an existing contact — pre-fills every
   *  field. Lead is deliberately excluded from what gets edited here:
   *  lead_id is immutable after creation (contacts_protect_identity_
   *  columns, see the contacts migration), so in edit mode the Lead
   *  field renders as read-only display text instead of the searchable
   *  picker below, and defaultValues carries no lead_id of its own to
   *  submit — see EditContactDialog, which resolves the linked lead's
   *  label itself and passes it here as `lockedLeadLabel`. */
  defaultValues?: {
    name: string;
    company: string | null;
    title: string | null;
    email: string | null;
    phone: string | null;
    tags: string[];
    owner_id: string;
  };
  lockedLeadLabel?: string;
};

export function ContactFormFields({
  assignableUsers,
  currentUserCustomerUserId,
  fieldErrors,
  defaultValues,
  lockedLeadLabel,
}: ContactFormFieldsProps) {
  // Same disambiguation logic the Owner column/picker use for Leads and
  // the Assign field uses for Tasks — computed here from the raw
  // assignableUsers array for the same reason those components do.
  const ownerLabelById = useMemo(() => getOwnerDisplayLabels(assignableUsers), [assignableUsers]);

  return (
    <>
      <FormSection icon={<ContactsIcon className="h-3.5 w-3.5" />} title="Contact details">
        <FormField
          label="Name"
          name="name"
          required
          variant="filled"
          placeholder="e.g. Ravi Deshmukh"
          defaultValue={defaultValues?.name}
          error={fieldErrors.name}
        />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Company"
            name="company"
            variant="filled"
            placeholder="e.g. Vindhya Precision Manufacturing"
            defaultValue={defaultValues?.company ?? undefined}
            error={fieldErrors.company}
          />
          <FormField
            label="Title"
            name="title"
            variant="filled"
            placeholder="e.g. COO"
            defaultValue={defaultValues?.title ?? undefined}
            error={fieldErrors.title}
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Email"
            name="email"
            type="email"
            variant="filled"
            placeholder="name@company.com"
            defaultValue={defaultValues?.email ?? undefined}
            error={fieldErrors.email}
          />
          <FormField
            label="Phone"
            name="phone"
            type="tel"
            variant="filled"
            placeholder="e.g. +91 98765 43210"
            defaultValue={defaultValues?.phone ?? undefined}
            error={fieldErrors.phone}
          />
        </div>

        <FormField
          label="Tags"
          name="tags"
          variant="filled"
          placeholder="e.g. Decision maker, Enterprise"
          helperText="Comma-separated."
          defaultValue={defaultValues?.tags.join(", ")}
          error={fieldErrors.tags}
        />
      </FormSection>

      <FormSection icon={<LeadCaptureIcon className="h-3.5 w-3.5" />} title="Linked lead">
        {defaultValues ? (
          // Read-only in edit mode — lead_id is immutable after creation
          // (see this component's own defaultValues comment), so there's
          // no lead_id form field submitted here at all in edit mode; the
          // linked lead is still shown, just not changeable.
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-neutral-700">Lead</label>
            <input
              type="text"
              value={lockedLeadLabel ?? ""}
              disabled
              readOnly
              aria-readonly="true"
              className="w-full cursor-not-allowed rounded-lg border border-transparent bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-500 outline-none"
            />
            <p className="text-xs text-neutral-400">A contact&rsquo;s linked lead cannot be changed after creation.</p>
          </div>
        ) : (
          <LeadSearchSelect
            label="Lead"
            id="contact-lead"
            name="lead_id"
            required
            error={fieldErrors.lead_id}
            helperText="Every contact must be linked to a lead. Independent from Owner below."
          />
        )}
      </FormSection>

      <FormSection icon={<UserPlusIcon className="h-3.5 w-3.5" />} title="Ownership">
        <SelectField
          label="Owner"
          id="contact-owner"
          name="owner_id"
          required
          defaultValue={defaultValues?.owner_id ?? currentUserCustomerUserId}
          error={fieldErrors.owner_id}
          helperText="Only teammates within your reporting hierarchy are listed."
        >
          {assignableUsers.map((owner) => (
            <option key={owner.customer_user_id} value={owner.customer_user_id}>
              {ownerLabelById.get(owner.customer_user_id) ?? owner.email} — {owner.role_name}
            </option>
          ))}
        </SelectField>
      </FormSection>
    </>
  );
}
