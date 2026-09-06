import { z } from "zod";

/** Matches the `leads.stage` CHECK constraint exactly. */
export const LEAD_STAGES = ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"] as const;

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
 * customer_id and status are deliberately not here — customer_id is
 * always derived server-side from the caller's own membership (never
 * trusted from the client, see createLeadAction), and status always
 * defaults to 'Active' at creation, matching the DB default, rather
 * than being a field the creator picks. owner_id is validated here as
 * "an optional customer_users id" only — WHETHER the submitted value is
 * actually honored (vs. overridden to the caller's own id) is a
 * role-based authorization decision made in createLeadAction, not a
 * shape/format concern Zod should own.
 */
export const createLeadSchema = z.object({
  company: optionalText(),
  contact_name: z.string().trim().min(1, "Contact name is required."),
  email: optionalEmail(),
  phone: z.string().trim().min(1, "Contact number is required."),
  deal_value: optionalDealValue(),
  stage: z.enum(LEAD_STAGES, {
    message: "Select a stage.",
  }),
  owner_id: optionalText(),
  source: optionalText(),
  next_step: optionalText(),
});

export type CreateLeadInput = z.infer<typeof createLeadSchema>;
