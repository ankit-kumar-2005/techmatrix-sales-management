import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";

/**
 * Server Supabase client. Use only from Server Components, Route Handlers,
 * and Server Actions. Reads the session from cookies via the App Router's
 * cookies() API, so RLS applies per-request as the authenticated user —
 * this is not a service-role client and does not bypass RLS.
 *
 * Wrapped in React's cache() — the official Supabase/Next.js App Router
 * pattern for this — so every Server Component rendered for ONE request
 * (app/(app)/layout.tsx and whichever page it wraps: Pipeline, Catalog,
 * Contacts, Tasks, ...) gets back the exact same client instance instead
 * of each one separately reading cookies() and constructing its own.
 * React's cache() is scoped to a single request/render pass (it's the
 * same mechanism Next.js's own fetch() deduping uses under the hood) —
 * nothing here is a persistent/global cache, so there is no risk of one
 * user's or request's client leaking into another's. This alone doesn't
 * dedupe anything by itself; see getAuthenticatedUser/getCurrentMembership
 * in features/customers/lib/get-current-membership.ts, which rely on this
 * same client instance being stable across a request to dedupe the actual
 * auth/membership work.
 */
export const createClient = cache(async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // setAll was called from a Server Component that can't set
            // cookies (e.g. during rendering). Safe to ignore here since
            // no session-refreshing middleware exists yet in this
            // foundation-only setup.
          }
        },
      },
    },
  );
});
