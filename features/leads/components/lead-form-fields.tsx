"use client";

import { useState, type ChangeEvent, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { FormField } from "@/components/shared/form-field";
import { ChevronDownIcon } from "@/features/sales-management/components/icons";
import { LEAD_SOURCES } from "../schemas";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

/**
 * The one set of lead fields shared by Create Lead and Edit Lead, so the
 * two forms can never drift apart — same markup, same field names (so
 * both dialogs' <form action={...}> submits the exact shape
 * createLeadSchema/updateLeadSchema expect), same WhatsApp-sync
 * behavior, same role-based Owner control. Extracted from what used to
 * be CreateLeadDialog's own inline JSX.
 */

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

/** Shared submit button — same look everywhere, label configurable per dialog. */
export function LeadFormSubmitButton({ idleLabel, pendingLabel }: { idleLabel: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}

export type LeadFormDefaultValues = {
  contact_name?: string;
  phone?: string | null;
  whatsapp_phone?: string | null;
  email?: string | null;
  company?: string | null;
  deal_value?: number | null;
  stage_id?: string;
  owner_id?: string | null;
  source?: string | null;
  next_step?: string | null;
};

type LeadFormFieldsProps = {
  /** Every one of this customer's stages (active + inactive), ordered by
   *  display_order. Only Active ones are offered — unless
   *  defaultValues.stage_id points at a since-deactivated one, in which
   *  case that single stage stays selectable too, matching
   *  protect_lead_stage_transition()'s own "unchanged stage_id" rule: an
   *  existing lead sitting on a retired stage must never lose its own
   *  value from this dropdown just because it's no longer offered to
   *  *new* leads. */
  stages: CustomerLeadStage[];
  owners: TeamDirectoryEntry[];
  /** Only ADMIN gets an editable Owner picker — everyone else gets a
   *  read-only display of themselves. On create, the server forces
   *  owner_id to the caller's own id for every non-admin role; on edit,
   *  a non-admin can only ever reach this form for a lead they already
   *  own (see updateLeadAction), so the two always agree. */
  role: CustomerRole;
  currentUserEmail: string;
  fieldErrors: Record<string, string>;
  /** Omitted entirely for Create Lead (a blank form). Provided by Edit
   *  Lead, seeded from the lead being edited. */
  defaultValues?: LeadFormDefaultValues;
};

export function LeadFormFields({ stages, owners, role, currentUserEmail, fieldErrors, defaultValues }: LeadFormFieldsProps) {
  const [contactNumber, setContactNumber] = useState(defaultValues?.phone ?? "");

  // A lead only ever stores phone/whatsapp_phone separately, not "were
  // these the same" — so on edit, "same as contact number" starts
  // checked only when the two values actually match today; the user can
  // still uncheck it to diverge them.
  const initialWhatsappSame = Boolean(defaultValues?.whatsapp_phone) && defaultValues?.whatsapp_phone === defaultValues?.phone;
  const [whatsappSame, setWhatsappSame] = useState(initialWhatsappSame);
  const [whatsappNumber, setWhatsappNumber] = useState(initialWhatsappSame ? "" : (defaultValues?.whatsapp_phone ?? ""));

  const selectableStages = stages.filter((stage) => stage.status === "Active" || stage.id === defaultValues?.stage_id);

  // source has no DB-level CHECK constraint (see schemas.ts) — an
  // existing lead could in principle carry a value outside the curated
  // list below. Without a matching <option>, an uncontrolled <select>
  // silently falls back to its first option on render, which would
  // blank out that value the moment the form is saved without anyone
  // touching Source. Same defensive pattern PipelineView's own source
  // filter already uses.
  const sourceOptions =
    defaultValues?.source && !LEAD_SOURCES.includes(defaultValues.source)
      ? [...LEAD_SOURCES, defaultValues.source]
      : LEAD_SOURCES;

  function handleContactNumberChange(event: ChangeEvent<HTMLInputElement>) {
    setContactNumber(event.target.value);
  }

  function handleWhatsappSameChange(event: ChangeEvent<HTMLInputElement>) {
    setWhatsappSame(event.target.checked);
  }

  return (
    <>
      <FormField
        label=" Name"
        name="contact_name"
        required
        variant="filled"
        defaultValue={defaultValues?.contact_name}
        error={fieldErrors.contact_name}
      />

      <FormField
        label="Phone Number"
        name="phone"
        type="tel"
        required
        variant="filled"
        value={contactNumber}
        onChange={handleContactNumberChange}
        error={fieldErrors.phone}
      />

      <label className="flex items-center gap-2 text-sm text-neutral-600">
        <input
          type="checkbox"
          name="whatsapp_same"
          checked={whatsappSame}
          onChange={handleWhatsappSameChange}
          className="h-4 w-4 rounded border-neutral-300 text-sky-600 focus:ring-2 focus:ring-sky-500/30"
        />
        WhatsApp number is same as Phone number
      </label>

      <FormField
        label="WhatsApp Number"
        name="whatsapp_phone"
        type="tel"
        variant="filled"
        readOnly={whatsappSame}
        value={whatsappSame ? contactNumber : whatsappNumber}
        onChange={(event) => setWhatsappNumber(event.target.value)}
        error={fieldErrors.whatsapp_phone}
        className={whatsappSame ? "cursor-not-allowed" : ""}
      />

      <FormField
        label="Email"
        name="email"
        type="email"
        variant="filled"
        defaultValue={defaultValues?.email ?? undefined}
        error={fieldErrors.email}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormField
          label="Company"
          name="company"
          variant="filled"
          defaultValue={defaultValues?.company ?? undefined}
          error={fieldErrors.company}
        />
        <FormField
          label="Deal Value (₹)"
          name="deal_value"
          type="number"
          min="0"
          step="0.01"
          variant="filled"
          defaultValue={defaultValues?.deal_value ?? undefined}
          error={fieldErrors.deal_value}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField
          label="Stage"
          id="lead-stage"
          name="stage_id"
          required
          defaultValue={defaultValues?.stage_id ?? ""}
          error={fieldErrors.stage_id}
        >
          <option value="" disabled>
            Select a stage
          </option>
          {selectableStages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.stage}
              {stage.status === "Inactive" ? " (Inactive)" : ""}
            </option>
          ))}
        </SelectField>

        {role === "ADMIN" ? (
          <SelectField label="Owner" id="lead-owner" name="owner_id" defaultValue={defaultValues?.owner_id ?? ""}>
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

      <SelectField label="Source" id="lead-source" name="source" defaultValue={defaultValues?.source ?? ""}>
        <option value="">Select a source</option>
        {sourceOptions.map((source) => (
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
        defaultValue={defaultValues?.next_step ?? undefined}
        error={fieldErrors.next_step}
      />
    </>
  );
}
