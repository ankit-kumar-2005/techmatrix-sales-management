import { z } from "zod";

/**
 * Field names match the `customer_user_invitations` columns directly
 * (full_name, not fullName; role_id, not roleId) so form data maps
 * straight through with no translation layer in the Server Action — the
 * same convention updateCustomerSchema and createContactSchema already
 * follow.
 *
 * Nothing here validates the TENANT: customer_id is never accepted from
 * a form, always derived from the caller's own membership in the action
 * (CLAUDE.md Section G / multi-tenant-security). Nothing here validates
 * that the role/manager actually exist either — that is the database's
 * job (foreign keys plus the validation trigger), and duplicating it in
 * Zod would only produce a second, drift-prone copy of the rule.
 */
const requiredText = (label: string) => z.string().trim().min(1, `${label} is required.`);

/** An empty <select> submits "", which means "no manager" — normalized
 *  to undefined so the action can insert a real NULL rather than a
 *  blank string. */
const optionalUuid = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined))
    .refine((value) => value === undefined || z.string().uuid().safeParse(value).success, {
      message: `${label} is not valid.`,
    });

export const createInvitationSchema = z.object({
  email: requiredText("Email").email("Enter a valid email address.").max(255),
  full_name: requiredText("Full name").max(120),
  role_id: requiredText("Role").uuid("Role is not valid."),
  manager_id: optionalUuid("Manager"),
});

export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;
