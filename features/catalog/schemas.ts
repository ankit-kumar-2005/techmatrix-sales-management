import { z } from "zod";
import { PRICING_UNITS, type PricingUnit } from "@/types/catalog";

/**
 * pricing_unit is validated via a plain .refine() against PRICING_UNITS
 * rather than z.enum(...) — this project is on Zod v4, whose enum
 * error-customization API differs from v3's, and this codebase's other
 * schemas don't use z.enum anywhere yet. A refine() sidesteps that
 * entirely rather than guessing at an API surface this project hasn't
 * already exercised.
 */
const pricingUnitSchema = z.string().refine((value): value is PricingUnit => (PRICING_UNITS as readonly string[]).includes(value), {
  message: "Select a pricing unit.",
});

/**
 * "" (never filled in) becomes undefined, stored as NULL — not 0.
 * Deliberately no upper bound on price beyond what numeric(12,2) itself
 * allows; the CHECK (price >= 0) constraint is the real backstop
 * regardless of what this schema catches first.
 */
const priceSchema = z
  .string()
  .trim()
  .min(1, "Price is required.")
  .transform((value) => Number(value))
  .refine((value) => Number.isFinite(value) && value >= 0, {
    message: "Price must be zero or greater.",
  });

const catalogItemFieldsShape = {
  name: z.string().trim().min(1, "Name is required.").max(150, "Name must be 150 characters or fewer."),
  category: z.string().trim().min(1, "Category is required.").max(60, "Category must be 60 characters or fewer."),
  price: priceSchema,
  pricing_unit: pricingUnitSchema,
  description: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
};

export const createCatalogItemSchema = z.object(catalogItemFieldsShape);

export type CreateCatalogItemInput = z.infer<typeof createCatalogItemSchema>;

/**
 * Editing an item validates every field exactly like creating one —
 * built from the same catalogItemFieldsShape object, not a re-typed
 * copy — plus the id of the item being edited. WHETHER the caller may
 * actually edit this specific item (ADMIN role) is an authorization
 * question decided in updateCatalogItemAction and by RLS, not Zod's job.
 */
export const updateCatalogItemSchema = z.object({
  id: z.string().uuid(),
  ...catalogItemFieldsShape,
});

export type UpdateCatalogItemInput = z.infer<typeof updateCatalogItemSchema>;
