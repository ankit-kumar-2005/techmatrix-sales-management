import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CurrentMembership,
  CurrentMembershipCustomer,
  CurrentMembershipUser,
  CustomerRole,
} from "@/types/customer";

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
  // Column projection (Phase 3), traced against every consumer of the
  // returned `customer`/`membership` objects across the whole app —
  // notably CompanyInformationForm, which is passed `membership.customer`
  // directly as a prop and reads name/company_name/email/phone/website/
  // address/city/state/country (everything on `customers` except status/
  // created_at/updated_at, confirmed unused anywhere). created_by is kept
  // even though no consumer reads it directly: isPrimaryAdmin below is
  // computed from it before this function returns.
  //
  // customer_id and role_id are deliberately LEFT IN on customer_users'
  // own column list, unlike everywhere else this phase trims a filtered-
  // on/embed-adjacent column — this function gates literally every
  // protected page in the app, there is no live environment here to
  // verify PostgREST resolves both embeds purely from the schema's FK
  // metadata regardless of the parent's own selected columns, and the
  // possible savings (two uuids) aren't worth that risk. Only user_id is
  // dropped: it's read by the `.eq("user_id", userId)` filter below, not
  // by anything in the returned data (a WHERE clause doesn't need its own
  // column in the SELECT list to filter on it).
  // A single string literal, not built via concatenation — the
  // supabase-js client parses this exact literal's surface syntax at the
  // TYPE level (to infer what `data` looks like, including through the
  // two embeds below); a computed/concatenated string can't be parsed
  // that way and silently degrades to an untyped `GenericStringError`
  // result instead, which is what broke here the first time.
  const { data, error } = await supabase
    .from("customer_users")
    .select(
      "id, customer_id, role_id, name, manager_id, status, created_at, updated_at, customer:customers(id, name, company_name, email, phone, website, address, city, state, country, created_by), role:roles(name)",
    )
    .eq("user_id", userId)
    .eq("status", "Active")
    .limit(1)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  // This project has no generated Database types, so the client can't
  // know `customer`/`role` are to-one embeds (a unique FK relationship)
  // rather than to-many — it defaults to modeling both as arrays once
  // the select string names explicit columns (a plain `*` embed doesn't
  // trigger this). Cast once to the real, known single-row shape here —
  // the same "cast to the known real shape" convention every other query
  // in this app already uses for Supabase's own loose typing (e.g.
  // `return data as ContactListItem[]`), not a new pattern.
  const row = data as unknown as CurrentMembershipUser & {
    customer: CurrentMembershipCustomer;
    role: { name: string };
  };

  if (!row.customer || !row.role) {
    return null;
  }

  const { customer, role, ...membership } = row;

  return {
    customer,
    membership,
    role: role.name as CustomerRole,
    isPrimaryAdmin: customer.created_by === userId,
  };
});
