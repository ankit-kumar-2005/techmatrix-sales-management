import { z } from "zod";

const NAME_MAX_LENGTH = 200;
const TAGS_MAX_COUNT = 20;
const TAG_MAX_LENGTH = 60;

/**
 * customer_id and created_by are deliberately not here — both are always
 * derived server-side (see createContactAction), never trusted from the
 * client, matching createTaskSchema/createLeadSchema's own reasoning.
 *
 * lead_id is validated only as "a uuid was selected" — WHETHER the
 * caller may actually attach a contact to that lead is a hierarchy/
 * visibility question re-checked server-side against the live database
 * (and enforced again by RLS regardless), not something Zod can look up.
 *
 * tags arrives from the form as one comma-separated string (matching the
 * reference UI's single "Tags (comma-separated)" input) and is split/
 * trimmed/de-duplicated-of-blanks here into the string[] the database
 * column actually stores — this is presentation-to-storage shaping, not
 * a second source of truth for what a "tag" is.
 */
export const createContactSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(NAME_MAX_LENGTH, `Name must be ${NAME_MAX_LENGTH} characters or fewer.`),
  company: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  title: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  // Same verified pattern features/leads/schemas.ts's own optionalEmail()
  // uses (z.string().email(), not the newer top-level z.email() — this
  // project avoids exercising a Zod v4 API surface no existing schema
  // has already verified works as expected here).
  email: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || z.string().email().safeParse(value).success, {
      message: "Enter a valid email address.",
    }),
  phone: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined)),
  tags: z
    .string()
    .trim()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
        .slice(0, TAGS_MAX_COUNT)
        .map((tag) => tag.slice(0, TAG_MAX_LENGTH)),
    ),
  lead_id: z.string().trim().min(1, "Select a lead.").uuid("Select a lead."),
  // Validated only as "a uuid was selected" — WHETHER the caller may
  // actually assign a contact to this specific owner is a hierarchy/
  // visibility question re-checked server-side (createContactAction
  // forces this to the caller's own id for SALES_REP regardless of what
  // was submitted) and enforced again by RLS either way, not something
  // Zod can look up.
  owner_id: z.string().trim().min(1, "Select an owner.").uuid("Select an owner."),
});

export type CreateContactInput = z.infer<typeof createContactSchema>;

/**
 * lead_id is deliberately NOT part of this schema — it's immutable after
 * creation (contacts_protect_identity_columns, see the contacts
 * migration's own design notes: "lead_id -> immutable"), so the edit
 * form never submits it at all; the edit dialog shows it as read-only
 * display text instead of the searchable picker createContactSchema's
 * own lead_id field feeds. Everything else (including owner_id) is
 * editable, matching "owner_id SHOULD be changeable by authorized
 * users."
 */
export const updateContactSchema = z.object({
  id: z.string().trim().min(1).uuid(),
  name: createContactSchema.shape.name,
  company: createContactSchema.shape.company,
  title: createContactSchema.shape.title,
  email: createContactSchema.shape.email,
  phone: createContactSchema.shape.phone,
  tags: createContactSchema.shape.tags,
  owner_id: createContactSchema.shape.owner_id,
});

export type UpdateContactInput = z.infer<typeof updateContactSchema>;
