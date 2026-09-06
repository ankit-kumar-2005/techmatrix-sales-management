import { z } from "zod";

const requiredText = (label: string) => z.string().trim().min(1, `${label} is required.`);

const optionalText = () =>
  z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value : undefined));

/**
 * Field names match the `customers` columns directly (company_name, not
 * companyName) so form data maps straight through with no translation
 * layer in the Server Action.
 *
 * No `email` field here deliberately — customers.email is immutable
 * after creation (enforced by a DB trigger, see the
 * customers_email_immutable migration), so it's never part of this
 * update payload; the form renders it read-only and doesn't submit it.
 */
export const updateCustomerSchema = z.object({
  company_name: optionalText(),
  phone: requiredText("Company phone").max(30),
  website: optionalText(),
  address: optionalText(),
  city: optionalText(),
  state: optionalText(),
  country: optionalText(),
});

export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
