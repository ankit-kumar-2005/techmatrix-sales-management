"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import {
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { createCatalogItemSchema, updateCatalogItemSchema } from "./schemas";
import { getCatalogItemsPage, type CatalogItemsPage, type CatalogItemsPageParams } from "./lib/get-catalog-items";
import type { CatalogItemFormState } from "./form-state";

/**
 * Only ADMIN may create a catalog item — this is the ADMIN *role*
 * (membership.role === "ADMIN"), the same concept every other
 * ADMIN-role-gated action in this app uses (see e.g. stage
 * configuration in features/leads/actions.ts), not "Primary Admin"
 * (customers.created_by). This membership.role check is the UX layer
 * only: RLS ("admins can create catalog items for their customer",
 * using the existing is_customer_admin() SECURITY DEFINER helper — the
 * same one every other admin-gated table policy in this project uses)
 * is the real boundary, and holds even if this check were ever removed
 * or bypassed by a direct API call.
 *
 * customer_id is never read from the form — always derived from the
 * caller's own current membership, the same rule every other
 * customer-scoped write in this app follows (see multi-tenant-security
 * skill / CLAUDE.md Section G).
 */
export async function createCatalogItemAction(
  _prevState: CatalogItemFormState,
  formData: FormData,
): Promise<CatalogItemFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }
  if (membership.role !== "ADMIN") {
    return { formError: "You do not have permission to perform this action." };
  }

  const parsed = createCatalogItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const { error } = await supabase.from("customer_catalog_items").insert({
    customer_id: membership.customer.id,
    name: parsed.data.name,
    category: parsed.data.category,
    price: parsed.data.price,
    pricing_unit: parsed.data.pricing_unit,
    description: parsed.data.description ?? null,
    created_by: user.id,
  });

  if (error) {
    // Never surface raw Postgres error text (constraint names, internal
    // schema detail) — see CLAUDE.md Section K.
    return { formError: "Unable to add catalog item. Please try again." };
  }

  revalidatePath("/catalog");
  return { success: true };
}

/**
 * Edits an existing catalog item's own fields (name/category/price/
 * pricing_unit/description) — status is never touched here, that stays
 * setCatalogItemStatusAction's own job. Same ADMIN-role-gated shape as
 * createCatalogItemAction; RLS ("admins can update their customer's
 * catalog items") already covers every column on this table, not just
 * status, so no new policy was needed for this — the same policy
 * setCatalogItemStatusAction already relies on is the real boundary
 * here too.
 */
export async function updateCatalogItemAction(
  _prevState: CatalogItemFormState,
  formData: FormData,
): Promise<CatalogItemFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }
  if (membership.role !== "ADMIN") {
    return { formError: "You do not have permission to perform this action." };
  }

  const parsed = updateCatalogItemSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return { fieldErrors: getFieldErrors(parsed.error) };
  }

  const { data, error } = await supabase
    .from("customer_catalog_items")
    .update({
      name: parsed.data.name,
      category: parsed.data.category,
      price: parsed.data.price,
      pricing_unit: parsed.data.pricing_unit,
      description: parsed.data.description ?? null,
    })
    .eq("id", parsed.data.id)
    .eq("customer_id", membership.customer.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return { formError: "Unable to update catalog item. Please try again." };
  }
  if (!data) {
    // RLS silently excluded the row (e.g. it belongs to a different
    // customer, or was removed in the meantime) — the database is
    // still the real boundary even when this action's own checks agree.
    return { formError: "This item could not be updated. It may no longer exist." };
  }

  revalidatePath("/catalog");
  return { success: true };
}

export type SetCatalogItemStatusResult = { success: boolean; error?: string };

/**
 * Same ADMIN-role-gated shape as setLeadStageStatusAction
 * (features/leads/actions.ts) — auth check, membership check, role
 * check, then a customer_id-scoped UPDATE — but returns a result
 * instead of void, since this one drives a confirmation dialog that
 * needs to show a friendly error if the update didn't go through
 * (setLeadStageStatusAction's own caller has no such UI to feed).
 *
 * The final `.select("id").maybeSingle()` check mirrors
 * updateLeadAction's own defense-in-depth pattern: if RLS silently
 * filtered the row (e.g. it belongs to a different customer, or was
 * removed in the meantime), `.update()` itself doesn't error — it just
 * affects zero rows — so checking the returned row is what actually
 * catches that case rather than reporting a false success.
 */
export async function setCatalogItemStatusAction(
  itemId: string,
  status: "Active" | "Inactive",
): Promise<SetCatalogItemStatusResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }
  if (membership.role !== "ADMIN") {
    return { success: false, error: "You do not have permission to perform this action." };
  }

  const { data, error } = await supabase
    .from("customer_catalog_items")
    .update({ status })
    .eq("id", itemId)
    .eq("customer_id", membership.customer.id)
    .select("id")
    .maybeSingle();

  if (error) {
    return { success: false, error: "Unable to update this item. Please try again." };
  }
  if (!data) {
    return { success: false, error: "This item could not be updated. It may no longer exist." };
  }

  revalidatePath("/catalog");
  return { success: true };
}

/**
 * Callable directly from CatalogItemsGrid (a Client Component) like an
 * RPC, the same way completeTaskAction/moveLeadStageAction already are
 * — this project has no Route Handlers yet, and this is a read, not a
 * mutation, but Server Actions work equally well for either and nothing
 * elsewhere in this app has needed to draw that line yet. customer_id
 * is never accepted as a parameter — always derived from the caller's
 * own current membership, same rule every other customer-scoped query
 * in this app follows, so a crafted request can't page through another
 * customer's catalog by supplying someone else's id.
 */
export async function getCatalogItemsPageAction(params: CatalogItemsPageParams): Promise<CatalogItemsPage> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  return getCatalogItemsPage(supabase, membership.customer.id, params);
}
