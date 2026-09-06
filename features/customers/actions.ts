"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { updateCustomerSchema } from "./schemas";
import { getCurrentMembership } from "./lib/get-current-membership";
import type { CustomerFormState } from "./form-state";

/**
 * Only the Primary Admin (customers.created_by === user.id) may update
 * company information. Checked server-side here; RLS's "admins can
 * update their customer" policy is the layer that holds even if this
 * check is ever bypassed or this code has a bug — defense in depth.
 */
export async function updateCustomerAction(
  _prevState: CustomerFormState,
  formData: FormData,
): Promise<CustomerFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const current = await getCurrentMembership(supabase, user.id);
  if (!current) {
    redirect("/signup");
  }
  if (!current.isPrimaryAdmin) {
    return { formError: "Only the Primary Admin can edit company information." };
  }

  const parsed = updateCustomerSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const { error } = await supabase
    .from("customers")
    .update({
      company_name: parsed.data.company_name ?? null,
      phone: parsed.data.phone,
      website: parsed.data.website ?? null,
      address: parsed.data.address ?? null,
      city: parsed.data.city ?? null,
      state: parsed.data.state ?? null,
      country: parsed.data.country ?? null,
    })
    .eq("id", current.customer.id);

  if (error) {
    return { formError: "Something went wrong saving company information. Please try again." };
  }

  return { success: true };
}
