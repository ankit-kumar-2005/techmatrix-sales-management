import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client. Use only from Client Components / client-side
 * hooks. Built with the public URL + publishable key — every query made
 * with this client is subject to Row Level Security (RLS) as the current
 * user. Never import the service-role key here.
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}
