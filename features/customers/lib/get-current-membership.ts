import type { SupabaseClient } from "@supabase/supabase-js";
import type { CurrentMembership, CustomerRole } from "@/types/customer";

/**
 * Server-side only: resolves the current authenticated user's customer
 * membership (customer + role name), or null if they don't have an
 * active one. Filters to status = 'Active' deliberately — a deactivated
 * customer_user should be treated as having no access, not silently
 * let back in. This is the single source of truth the (app) layout
 * guard, /signup's redirect check, and every settings page use — never
 * inferred from client state. See CLAUDE.md Section G / the
 * multi-tenant-security skill.
 */
export async function getCurrentMembership(
  supabase: SupabaseClient,
  userId: string,
): Promise<CurrentMembership | null> {
  const { data, error } = await supabase
    .from("customer_users")
    .select("*, customer:customers(*), role:roles(name)")
    .eq("user_id", userId)
    .eq("status", "Active")
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.customer || !data.role) {
    return null;
  }

  const { customer, role, ...membership } = data;

  return {
    customer,
    membership,
    role: role.name as CustomerRole,
    isPrimaryAdmin: customer.created_by === userId,
  };
}
