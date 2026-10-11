import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * A Supabase client that acts as the person who owns `accessToken` — for
 * callers that authenticate with a bearer token instead of the cookie
 * session (the MCP server). Built with the publishable key, so PostgREST
 * runs every query as `authenticated` with auth.uid() = the token's
 * subject, and every RLS policy applies exactly as it does in the app.
 *
 * NOT a service-role client and never one: there is no service-role key
 * anywhere in this project's runtime. persistSession/autoRefreshToken are
 * off — the token's lifetime is the caller's business (the MCP client
 * refreshes it with Supabase Auth), and this client must never write or
 * refresh a session of its own.
 *
 * Verify the token BEFORE building this (features/mcp/lib/verify-token.ts);
 * this function trusts nothing and checks nothing on its own.
 */
export function createBearerClient(accessToken: string): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
