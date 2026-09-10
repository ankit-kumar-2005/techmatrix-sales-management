"use client";

import { useFormStatus } from "react-dom";
import { FormField } from "@/components/shared/form-field";
import { SelectField } from "@/components/shared/select-field";
import { FormSection } from "@/components/shared/form-section";
import { TagIcon, TrendingUpIcon } from "@/features/sales-management/components/icons";
import { PRICING_UNITS } from "@/types/catalog";

/** Shared submit button — same look as LeadFormSubmitButton/
 *  TaskFormSubmitButton elsewhere in this app. */
export function CatalogItemFormSubmitButton({ idleLabel, pendingLabel }: { idleLabel: string; pendingLabel: string }) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-full bg-gradient-to-r from-teal-600 to-teal-800 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-teal-700/20 transition-all duration-200 hover:from-teal-700 hover:to-teal-900 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:shadow-sm"
    >
      {pending ? pendingLabel : idleLabel}
    </button>
  );
}

export type CatalogItemFormDefaultValues = {
  name?: string;
  category?: string;
  price?: number;
  pricing_unit?: string;
  description?: string | null;
};

type CatalogItemFormFieldsProps = {
  fieldErrors: Record<string, string>;
  /** Omitted entirely for New Catalog Item (a blank form). Provided by
   *  Edit Catalog Item, seeded from the item being edited — the one set
   *  of fields shared by both, so the two forms can never drift apart
   *  (same markup, same field names, matching what
   *  createCatalogItemSchema/updateCatalogItemSchema expect). */
  defaultValues?: CatalogItemFormDefaultValues;
};

export function CatalogItemFormFields({ fieldErrors, defaultValues }: CatalogItemFormFieldsProps) {
  return (
    <>
      <FormSection icon={<TagIcon className="h-3.5 w-3.5" />} title="Basic details" accent="teal">
        <FormField
          label="Name"
          name="name"
          required
          variant="filled"
          defaultValue={defaultValues?.name}
          error={fieldErrors.name}
        />

        <FormField
          label="Category"
          name="category"
          required
          variant="filled"
          placeholder="e.g. Support"
          defaultValue={defaultValues?.category}
          error={fieldErrors.category}
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor="catalog-item-description" className="text-sm font-medium text-neutral-700">
            Description
          </label>
          <textarea
            id="catalog-item-description"
            name="description"
            rows={3}
            placeholder="One or two sentences a rep could paste into a proposal"
            defaultValue={defaultValues?.description ?? undefined}
            aria-invalid={Boolean(fieldErrors.description)}
            className={`w-full resize-none rounded-lg border bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 ${
              fieldErrors.description ? "border-red-400" : "border-transparent"
            }`}
          />
          {fieldErrors.description ? (
            <p role="alert" className="text-xs text-red-600">
              {fieldErrors.description}
            </p>
          ) : null}
        </div>
      </FormSection>

      <FormSection icon={<TrendingUpIcon className="h-3.5 w-3.5" />} title="Pricing" accent="teal">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormField
            label="Price (₹)"
            name="price"
            type="number"
            min="0"
            step="0.01"
            required
            variant="filled"
            defaultValue={defaultValues?.price}
            error={fieldErrors.price}
          />
          <SelectField
            label="Pricing unit"
            id="catalog-item-pricing-unit"
            name="pricing_unit"
            required
            defaultValue={defaultValues?.pricing_unit ?? "One-time"}
            error={fieldErrors.pricing_unit}
          >
            {PRICING_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </SelectField>
        </div>
      </FormSection>
    </>
  );
}
