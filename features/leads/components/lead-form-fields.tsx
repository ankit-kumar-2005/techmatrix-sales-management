"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import { useFormStatus } from "react-dom";
import { FormField } from "@/components/shared/form-field";
import { SelectField } from "@/components/shared/select-field";
import { FormSection } from "@/components/shared/form-section";
import { LeadCaptureIcon, TrendingUpIcon, UserPlusIcon } from "@/features/sales-management/components/icons";
import { LEAD_SOURCES } from "../schemas";
import { getOwnerDisplayLabels } from "../lib/owner-display";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

/**
 * The one set of lead fields shared by Create Lead and Edit Lead, so the
 * two forms can never drift apart — same markup, same field names (so
 * both dialogs' <form action={...}> submits the exact shape
 * createLeadSchema/updateLeadSchema expect), same WhatsApp-sync
 * behavior, same role-based Owner control. Extracted from what used to
 * be CreateLeadDialog's own inline JSX. SelectField itself now lives in
 * components/shared/ (promoted from a local definition here once the
 * Catalog feature needed the identical pattern).
 *
 * Grouped into FormSections (Lead Details / Deal Info / Assignment) —
 * a purely visual reorganization matching the grouping ContactFormFields/
 * TaskFormFields already use; every field keeps its exact name/type/
 * required/validation behavior, only its position in the layout changed.
 */

/** Shared submit button — same gradient treatment as ContactFormSubmitButton/
 *  TaskFormSubmitButton elsewhere in this app (previously a flat
 *  `bg-sky-600`, restyled here purely for visual consistency with the
 *  other three creation forms — same type="submit"/disabled/pending
 *  behavior). */
export function LeadFormSubmitButton({ idleLabel, pendingLabel }: { idleLabel: string; pendingLabel: string }) {
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

export type LeadFormDefaultValues = {
  contact_name?: string;
  phone?: string | null;
  whatsapp_phone?: string | null;
  email?: string | null;
  company?: string | null;
  deal_value?: number | null;
  /** ISO yyyy-mm-dd, which is both what the leads.expected_close_date
   *  `date` column returns and what <input type="date"> requires — no
   *  conversion needed in either direction. */
  expected_close_date?: string | null;
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

  // Same shared disambiguation logic as the Owner column/filter on the
  // Pipeline page — computed here too (rather than passed as a prop)
  // since Create/Edit Lead only ever receive the raw `owners` array,
  // not something upstream that already derived labels from it.
  const ownerLabelById = useMemo(() => getOwnerDisplayLabels(owners), [owners]);

  function handleContactNumberChange(event: ChangeEvent<HTMLInputElement>) {
    setContactNumber(event.target.value);
  }

  function handleWhatsappSameChange(event: ChangeEvent<HTMLInputElement>) {
    setWhatsappSame(event.target.checked);
  }

  return (
    <>
      <FormSection icon={<LeadCaptureIcon className="h-3.5 w-3.5" />} title="Lead Details">
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

        {/* Same underlying checkbox (name="whatsapp_same", same checked/
            onChange) as before — only visually restyled as a sliding
            pill toggle, the "peer" input driving a sibling track+thumb
            via peer-checked, rather than a bare browser checkbox. */}
        <label className="inline-flex w-fit cursor-pointer items-center gap-2.5 text-sm text-neutral-600">
          <input
            type="checkbox"
            name="whatsapp_same"
            checked={whatsappSame}
            onChange={handleWhatsappSameChange}
            className="peer sr-only"
          />
          <span className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-neutral-300 transition-colors duration-200 peer-checked:bg-sky-600 peer-focus-visible:ring-2 peer-focus-visible:ring-sky-500/40 peer-focus-visible:ring-offset-2">
            <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform duration-200 peer-checked:translate-x-4" />
          </span>
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
      </FormSection>

      <FormSection icon={<TrendingUpIcon className="h-3.5 w-3.5" />} title="Deal Info">
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
          {/* Optional on purpose: plenty of deals have no realistic close
              date yet, and a blank submits "" which the schema turns into
              a real NULL. An undated deal still counts toward the
              Weighted Forecast total — it just can't be placed on the
              by-month chart, which the Forecast page says out loud. */}
          <FormField
            label="Expected Close Date"
            name="expected_close_date"
            type="date"
            variant="filled"
            defaultValue={defaultValues?.expected_close_date ?? undefined}
            error={fieldErrors.expected_close_date}
            helperText="Used for revenue forecasting. Leave blank if unknown."
          />
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

          <SelectField label="Source" id="lead-source" name="source" defaultValue={defaultValues?.source ?? ""}>
            <option value="">Select a source</option>
            {sourceOptions.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </SelectField>
        </div>

        <FormField
          label="Next Step"
          name="next_step"
          variant="filled"
          placeholder="e.g. Send proposal"
          defaultValue={defaultValues?.next_step ?? undefined}
          error={fieldErrors.next_step}
        />
      </FormSection>

      <FormSection icon={<UserPlusIcon className="h-3.5 w-3.5" />} title="Assignment">
        {role === "ADMIN" ? (
          <SelectField label="Owner" id="lead-owner" name="owner_id" defaultValue={defaultValues?.owner_id ?? ""}>
            <option value="">Unassigned</option>
            {owners.map((owner) => (
              <option key={owner.customer_user_id} value={owner.customer_user_id}>
                {ownerLabelById.get(owner.customer_user_id) ?? owner.email}
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
      </FormSection>
    </>
  );
}
