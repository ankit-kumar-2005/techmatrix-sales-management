import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Server Supabase client. Use only from Server Components, Route Handlers,
 * and Server Actions. Reads the session from cookies via the App Router's
 * cookies() API, so RLS applies per-request as the authenticated user —
 * this is not a service-role client and does not bypass RLS.
 */
export async function createClient() {
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
}
