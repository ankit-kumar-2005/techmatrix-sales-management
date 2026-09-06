"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { createLeadSchema } from "./schemas";
import type { LeadFormState } from "./form-state";

/**
 * customer_id is never read from the form — it's derived from the
 * caller's own current membership, the same rule every other
 * customer-scoped write in this app follows (see
 * multi-tenant-security skill / CLAUDE.md Section G). owner_id, if
 * supplied, is still constrained to the same customer at the database
 * level regardless (leads_owner_same_customer_fkey, a composite FK
 * against customer_users(customer_id, id)) — this isn't the only layer,
 * just the first one.
 *
 * OWNER AUTHORIZATION: only an ADMIN may choose who a lead is assigned
 * to. Everyone else has the "Owner" field forced to their own
 * customer_users.id, regardless of what (if anything) the form
 * submitted for owner_id — a non-admin cannot assign a lead to another
 * user by hand-crafting a request, because their submitted value is
 * simply never read for that branch. The leads INSERT policy
 * ("members create leads owned by themselves, admins by anyone", see
 * 20260906120000_lead_hierarchy_and_optional_fields.sql) enforces the
 * same rule again at the database level, independent of this check —
 * so the invariant holds even if this Server Action is bypassed
 * entirely and Supabase is called directly.
 */
export async function createLeadAction(
  _prevState: LeadFormState,
  formData: FormData,
): Promise<LeadFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  const raw = Object.fromEntries(formData);
  const parsed = createLeadSchema.safeParse({
    ...raw,
    // An empty <select> value ("") means "no owner chosen" — normalize
    // before validation so it hits the optional-field branch, not a
    // failed one.
    owner_id: raw.owner_id || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const ownerId = membership.role === "ADMIN" ? (parsed.data.owner_id ?? null) : membership.membership.id;

  const { error } = await supabase.from("leads").insert({
    customer_id: membership.customer.id,
    company: parsed.data.company ?? null,
    contact_name: parsed.data.contact_name,
    email: parsed.data.email ?? null,
    phone: parsed.data.phone,
    deal_value: parsed.data.deal_value ?? null,
    stage: parsed.data.stage,
    owner_id: ownerId,
    source: parsed.data.source ?? null,
    next_step: parsed.data.next_step ?? null,
  });

  if (error) {
    return { formError: "Something went wrong creating the lead. Please try again." };
  }

  revalidatePath("/sales-management");
  return { success: true };
}
