import { createServerClient } from "@supabase/ssr";

/**
 * The webhook Supabase client — a THIRD, distinct, explicitly-named
 * client alongside client.ts (browser) and server.ts (cookie-based
 * server), per CLAUDE.md Section E's own rule that a client construction
 * pattern this different gets its own named factory rather than being
 * folded into an existing one or hand-rolled at each call site.
 *
 * A DELIBERATELY SESSION-LESS client. Not server.ts's createClient(),
 * which reads cookies — a webhook has no session, and if an admin
 * happened to open a webhook URL in their own logged-in browser, the
 * cookie client would run any RPC as `authenticated` instead of `anon`,
 * making the same endpoint behave differently depending on who poked
 * it. Empty cookie handlers make that impossible: this client is always
 * anon, for everyone, regardless of who or what is calling it.
 *
 * It grants nothing by itself. Every RPC it calls (ingest_lead and any
 * future webhook function like it) is SECURITY DEFINER and resolves the
 * tenant from a caller-supplied token alone — the anon role's only
 * privilege here is permission to call the function at all.
 *
 * NOT feature-scoped under features/integrations/, even though Lead
 * Capture is its only caller today: this is infrastructure (a client
 * construction pattern), not business logic, and any future webhook
 * this app adds — a second lead source, a payment provider callback,
 * anything unauthenticated posting to a URL — needs the exact same
 * client, not a copy of it.
 */
export function createWebhookClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: () => {},
      },
    },
  );
}
