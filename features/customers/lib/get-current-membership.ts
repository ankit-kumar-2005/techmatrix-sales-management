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

/**
 * Why a membership is unusable, for the one caller that has to tell the
 * two reasons apart.
 *
 *   "active"   — a usable Active membership exists.
 *   "inactive" — this user IS a member of a customer, but that membership
 *                was deactivated. They have an account; they need an
 *                admin to reactivate them.
 *   "none"     — no customer_users row at all. Either a signup that never
 *                reached /set-password, or an auth user created outside
 *                the app (e.g. straight from the Supabase dashboard).
 *                This one genuinely still has registration to finish.
 */
export type MembershipState = "active" | "inactive" | "none";

/**
 * THE BUG THIS EXISTS TO FIX — "correct password, and I land on /signup".
 *
 * getCurrentMembership() filters `.eq("status", "Active")`, so it returns
 * null for BOTH of the failure states above. Its callers cannot tell them
 * apart, and every one of them treats null as "restart signup":
 *
 *   app/(app)/layout.tsx      if (!membership) redirect("/signup")
 *
 * For a DEACTIVATED member that is wrong twice over. It is the wrong
 * page — they already have an account, so "Create your account" is a
 * dead end that tells them nothing about what actually happened. And it
 * is a dangerous page: /signup leads to /set-password, whose form calls
 * create_customer_with_admin(), which would manufacture a SECOND
 * customer for somebody who is already a member of one.
 *
 * It also made app/(app)/layout.tsx's own
 *   if (membership.membership.status !== "Active") redirect("/inactive")
 * unreachable — a non-null membership is Active by construction — so
 * /inactive could never render, and the Inactive case fell through to
 * /signup instead. That page's whole reason to exist was dead code.
 *
 * NO EXTRA QUERY ON THE HAPPY PATH. getCurrentMembership is cache()d on
 * (supabase client, userId), and the one caller here calls it too — so
 * this await returns that already-resolved result rather than re-running
 * it. The second query below only ever runs for a user who is ALREADY
 * being redirected away, which is the one moment the extra round trip is
 * worth spending to send them somewhere truthful.
 *
 * Reads customer_users ONLY — deliberately no customers/roles embed.
 * customer_users' SELECT policy is
 *   using (user_id = auth.uid() or public.is_customer_member(customer_id))
 * and that FIRST clause carries no status condition, so a user can always
 * read their own rows however deactivated they are. The `customers`
 * policy is not so kind (is_customer_member() requires Active), which is
 * exactly why an embed here would come back null and put us right back to
 * "can't tell inactive from none".
 *
 * Bounded to one row: customer_users_one_active_membership_per_user caps
 * Active rows at one per user, but INACTIVE rows are uncapped (a user can
 * be deactivated by several customers over time). Any one of them answers
 * the only question being asked.
 */
export const getMembershipState = cache(async function getMembershipState(
  supabase: SupabaseClient,
  userId: string,
): Promise<MembershipState> {
  if (await getCurrentMembership(supabase, userId)) {
    return "active";
  }

  const { data, error } = await supabase
    .from("customer_users")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "Inactive")
    .limit(1)
    .maybeSingle();

  // An error here is treated as "none" on purpose: this function decides
  // where to send somebody who is already being redirected, and the
  // pre-existing destination is the safe default. It must never be able
  // to turn a read failure into access.
  if (error || !data) {
    return "none";
  }

  return "inactive";
});

/**
 * Where to send a user whose getCurrentMembership() came back null.
 *
 * ONE decision, called from every guard, so they cannot disagree.
 * app/(app)/layout.tsx and each (app) page check membership
 * independently (defense in depth, CLAUDE.md Section H) — and a layout
 * and its page render in the same pass, so if the layout redirected a
 * deactivated member to /inactive while the page underneath still said
 * /signup, which one the request ended on would come down to whose
 * redirect() threw first. That is not something to leave to a race when
 * one of the two answers is the bug being fixed.
 *
 * cache()d over the same (client, userId) pair as everything else here,
 * so all of those guards resolving in one request share a single answer
 * and a single query.
 */
export const getNoMembershipRedirect = cache(async function getNoMembershipRedirect(
  supabase: SupabaseClient,
  userId: string,
): Promise<"/inactive" | "/signup"> {
  return (await getMembershipState(supabase, userId)) === "inactive" ? "/inactive" : "/signup";
});
