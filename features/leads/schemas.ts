import { z } from "zod";

/**
 * `source` has no CHECK constraint in the schema (still a plain nullable
 * text column) — this is a curated list of common values for a nicer
 * picker, not a DB-enforced enum, so a value outside this list can still
 * reach the database from anywhere else without issue. Shared between
 * the Create Lead form and the Pipeline Source filter so both offer the
 * same options.
 */
export const LEAD_SOURCES = ["Referral", "Website", "Google Ads", "LinkedIn", "Cold Outreach", "Event", "Other"];

const optionalText = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined));

const optionalEmail = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || z.string().email().safeParse(value).success, {
      message: "Enter a valid email address.",
    });

/**
 * "" (never filled in) becomes `undefined`, which the action stores as
 * NULL — not 0. NULL means "deal value wasn't provided"; 0 means "the
 * deal is genuinely worth zero." Collapsing the two would lose real
 * information the field is meant to carry.
 */
const optionalDealValue = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? Number(value) : undefined))
    .refine((value) => value === undefined || (Number.isFinite(value) && value >= 0), {
      message: "Deal value must be zero or more.",
    });

/**
 * No phone-format validation existed anywhere in this app before this
 * (signup/company phone were both just "non-empty") — there is no
 * existing business rule to preserve, so this defines one: digits plus
 * common separators (space, +, -, parentheses, dot), 7–15 actual digits
 * (the E.164 international maximum). Deliberately lenient/international
 * rather than a fixed-length rule, since nothing elsewhere in the app
 * assumes a single country's phone format.
 */
const PHONE_DIGITS_MIN = 7;
const PHONE_DIGITS_MAX = 15;

function isValidPhoneFormat(value: string): boolean {
  if (!/^[0-9+\-\s().]+$/.test(value)) return false;
  const digitCount = value.replace(/\D/g, "").length;
  return digitCount >= PHONE_DIGITS_MIN && digitCount <= PHONE_DIGITS_MAX;
}

const requiredPhone = (message: string) =>
  z
    .string()
    .trim()
    .min(1, message)
    .refine(isValidPhoneFormat, { message: "Please enter a valid phone number." });

const optionalPhone = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || isValidPhoneFormat(value), {
      message: "Please enter a valid phone number.",
    });

/**
 * customer_id and status are deliberately not here — customer_id is
 * always derived server-side from the caller's own membership (never
 * trusted from the client, see createLeadAction), and status always
 * defaults to 'Active' at creation, matching the DB default, rather
 * than being a field the creator picks. owner_id is validated here as
 * "an optional customer_users id" only — WHETHER the submitted value is
 * actually honored (vs. overridden to the caller's own id) is a
 * role-based authorization decision made in createLeadAction, not a
 * shape/format concern Zod should own. Likewise stage_id is validated
 * only as "a uuid was selected" — WHETHER it's actually one of this
 * customer's active stages is re-checked server-side in the action,
 * since Zod has no way to look that up.
 *
 * whatsapp_same drives whether whatsapp_phone is copied from `phone`
 * server-side (see createLeadAction) — when true, whatever the client
 * submitted for whatsapp_phone is ignored in favor of the authoritative
 * `phone` value, rather than trusting a client-synced copy.
 */
const leadFieldsShape = {
  company: optionalText(),
  contact_name: z.string().trim().min(1, "Contact name is required."),
  email: optionalEmail(),
  phone: requiredPhone("Contact number is required."),
  whatsapp_same: z
    .string()
    .optional()
    .transform((value) => value === "on"),
  whatsapp_phone: optionalPhone(),
  deal_value: optionalDealValue(),
  stage_id: z.string().trim().min(1, "Select a stage.").uuid("Select a stage."),
  owner_id: optionalText(),
  source: optionalText(),
  next_step: optionalText(),
};

export const createLeadSchema = z.object(leadFieldsShape);

export type CreateLeadInput = z.infer<typeof createLeadSchema>;

/**
 * Editing a lead validates every field exactly like creating one — built
 * from the same leadFieldsShape object, not a re-typed copy — plus the
 * id of the lead being edited. WHETHER the caller is actually allowed to
 * edit this specific lead at all (ownership, the closed-lead lock) is an
 * authorization question decided in updateLeadAction against the live
 * database, not something Zod's job to express.
 */
export const updateLeadSchema = z.object({
  id: z.string().uuid(),
  ...leadFieldsShape,
});

export type UpdateLeadInput = z.infer<typeof updateLeadSchema>;

// -------------------------------------------------------------------
// Lead stage configuration (ADMIN only — see stage-actions.ts)
// -------------------------------------------------------------------

const stageName = () =>
  z
    .string()
    .trim()
    .min(1, "Stage name is required.")
    .max(60, "Stage name must be 60 characters or fewer.");

export const createLeadStageSchema = z.object({
  stage: stageName(),
  is_closed: z
    .string()
    .optional()
    .transform((value) => value === "on"),
});

export type CreateLeadStageInput = z.infer<typeof createLeadStageSchema>;

export const updateLeadStageSchema = z.object({
  id: z.string().uuid(),
  stage: stageName(),
  is_closed: z
    .string()
    .optional()
    .transform((value) => value === "on"),
});

export type UpdateLeadStageInput = z.infer<typeof updateLeadStageSchema>;
