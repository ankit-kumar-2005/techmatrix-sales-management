import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CurrentMembership, CustomerRole } from "@/types/customer";

/**
 * Server-side only: verifies the current session via Supabase Auth
 * (a real round trip to the auth server, deliberately NOT the cheaper
 * but unverified getSession()/local-JWT-decode — see every call site's
 * own "why getUser()" comment). Wrapped in cache() for the same reason
 * createClient() itself is (see lib/supabase/server.ts's own comment):
 * app/(app)/layout.tsx and whatever page it wraps (Pipeline, Catalog,
 * Contacts, Tasks, ...) each independently re-check auth on every
 * request as their own defense-in-depth guard — this makes the SECOND
 * (and any later) check in the same request reuse the first one's
 * result instead of hitting the auth server again, without removing
 * either guard. Same shape as supabase.auth.getUser() itself
 * ({ data: { user }, error }), so every existing call site's own
 * destructuring keeps working unchanged.
 */
export const getAuthenticatedUser = cache(async (supabase: SupabaseClient) => {
  return supabase.auth.getUser();
});

/**
 * Server-side only: resolves the current authenticated user's customer
 * membership (customer + role name), or null if they don't have an
 * active one. Filters to status = 'Active' deliberately — a deactivated
 * customer_user should be treated as having no access, not silently
 * let back in. This is the single source of truth the (app) layout
 * guard, /signup's redirect check, and every settings page use — never
 * inferred from client state. See CLAUDE.md Section G / the
 * multi-tenant-security skill.
 *
 * Wrapped in cache() for the same reason getAuthenticatedUser is above:
 * this DB query was previously re-run once per Server Component that
 * calls it (the layout AND the page it wraps, every navigation), even
 * though the answer for a given (supabase client, userId) pair can't
 * change mid-request. Deduping it only removes REDUNDANT work within
 * one request/render pass — it changes nothing about what any caller
 * receives, and nothing here is shared across requests or users.
 */
export const getCurrentMembership = cache(async function getCurrentMembership(
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
});
