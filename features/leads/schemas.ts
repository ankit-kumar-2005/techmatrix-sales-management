import { z } from "zod";
import { INTEGRATION_SOURCES } from "@/types/integration";
import { isRealIsoDate } from "@/utils/iso-date";

/**
 * THE ONE CANONICAL LIST OF LEAD SOURCE VALUES — every place in the app
 * that lets someone pick or filter by a lead's source reads this array,
 * not a list of its own. `source` has no CHECK constraint in the schema
 * (still a plain nullable text column) — this is a curated list for a
 * nicer picker, not a DB-enforced enum, so a value outside this list can
 * still reach the database from anywhere else without issue.
 *
 * BUILT FROM `INTEGRATION_SOURCES`, NOT A SEPARATE COPY OF IT. Every
 * connected integration (IndiaMART today) is also a value this list
 * offers, so a future integration becomes pickable here automatically
 * the moment it is added there — the same "one list, not two that can
 * drift" reasoning `INTEGRATION_SOURCES` itself already documents.
 *
 * A LEAD WITH NO SOURCE PICKED HAS `source = null`, NEVER THE LITERAL
 * TEXT "Manual". There is deliberately no "Manual" (or any other)
 * placeholder value in this list for that case — matching "no source"
 * is expressed with an emptiness check (e.g. the automation condition
 * builder's "is empty" operator on the Source field), not by picking a
 * fake value that would have to be excluded from every real comparison
 * everywhere this list is used. An earlier version of the automation
 * builder got exactly this wrong: it stored the literal string "Manual"
 * into a filter list and compared it against a lead's real `source`
 * column, which is NULL for a hand-entered lead — a comparison that
 * could never match. Fixed by removing the fake value at the source
 * (this list) rather than teaching every consumer to special-case it.
 */
export const LEAD_SOURCES: readonly string[] = [
  ...INTEGRATION_SOURCES,
  "Referral",
  "Website",
  "Google Ads",
  "LinkedIn",
  "Cold Outreach",
  "Event",
  "Other",
];

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
 * A real calendar date in ISO yyyy-mm-dd, or nothing at all.
 *
 * TWO CHECKS, AND BOTH ARE LOAD-BEARING:
 *
 *   1. The SHAPE must be exactly yyyy-mm-dd. <input type="date"> always
 *      submits that regardless of the format the browser DISPLAYS (a
 *      browser on an en-IN/en-GB locale shows 31-10-2026 for the same
 *      value it submits as 2026-10-31), so this never rejects anything a
 *      user picked. It exists for what the form isn't: a crafted
 *      request, where Postgres would otherwise answer with a raw 22007
 *      instead of a field error.
 *
 *   2. The date must ROUND-TRIP. A shape check alone is not enough,
 *      because JavaScript does not reject an out-of-range day — it rolls
 *      it over: new Date("2026-02-30") silently becomes March 2nd, and
 *      "2026-04-31" becomes May 1st. Neither produces an Invalid Date,
 *      so a NaN check cannot see them. Comparing the parsed date's own
 *      y/m/d back against the three numbers that went in is the only
 *      reliable way to catch a day that doesn't exist in that month —
 *      and it gets leap years right for free (2024-02-29 passes,
 *      2100-02-29 does not).
 *
 * Parsed with an explicit T00:00:00Z so the check runs in UTC. Without
 * it the string is treated as local midnight, and getUTCDate() would
 * then disagree with the input by one day for anyone west of UTC —
 * turning a correct date into a validation error purely by timezone.
 *
 * A PAST date is deliberately allowed: a slipped forecast date is a
 * real, common state, and the Forecast chart gives those their own
 * Overdue bucket rather than pretending they can't happen.
 *
 * An empty input submits "", which becomes undefined here so the action
 * stores a real NULL rather than a blank string — NULL is meaningful
 * ("not forecast yet"), the same reasoning as optionalDealValue.
 *
 * isRealIsoDate itself now lives in utils/iso-date.ts — it was defined
 * here while this was its only consumer, and moved (not copied) once the
 * Meeting Notes extraction needed to validate model-suggested dates with
 * exactly the same rules. Its own doc comment carries the full
 * explanation of both checks.
 */
const optionalDate = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || isRealIsoDate(value), {
      message: `${label} must be a valid date.`,
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
  address: optionalText(),
  deal_value: optionalDealValue(),
  expected_close_date: optionalDate("Expected close date"),
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

/**
 * Whole percentage points only, 0-100 — matching the smallint column and
 * its CHECK. Required (not optional-with-a-default) so creating a stage
 * is a deliberate choice about what it contributes to the forecast,
 * rather than silently inheriting the column's conservative 0.
 *
 * The CHECK also pins probability to 100 for a won stage and 0 for any
 * other closed stage. That is NOT re-validated here: Zod cannot see
 * is_won/is_closed's interaction cleanly on a FormData shape where both
 * are checkbox strings, and the actions normalize probability against
 * them before writing (see normalizeStageOutcome in actions.ts) so the
 * database never has to reject the combination.
 */
const stageProbability = () =>
  z
    .string()
    .trim()
    .min(1, "Probability is required.")
    .transform((value) => Number(value))
    .refine((value) => Number.isInteger(value) && value >= 0 && value <= 100, {
      message: "Probability must be a whole number between 0 and 100.",
    });

/** An unchecked checkbox submits nothing at all; a checked one submits
 *  "on". Same transform is_closed has always used. */
const stageFlag = () =>
  z
    .string()
    .optional()
    .transform((value) => value === "on");

export const createLeadStageSchema = z.object({
  stage: stageName(),
  is_closed: stageFlag(),
  is_won: stageFlag(),
  probability: stageProbability(),
});

export type CreateLeadStageInput = z.infer<typeof createLeadStageSchema>;

export const updateLeadStageSchema = z.object({
  id: z.string().uuid(),
  stage: stageName(),
  is_closed: stageFlag(),
  is_won: stageFlag(),
  probability: stageProbability(),
});

export type UpdateLeadStageInput = z.infer<typeof updateLeadStageSchema>;
