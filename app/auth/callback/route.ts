import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";

/**
 * Handles every Supabase email-link redirect: signup verification and
 * password-recovery both land here. This is the server-side half of
 * Supabase's PKCE flow — the link carries a one-time `code`, which must
 * be exchanged for a real session here (a Route Handler, unlike a Server
 * Component, can write the resulting session cookies onto the response).
 * Not a business API route — this is the same convention Supabase's own
 * docs use for any email-link or OAuth flow.
 *
 * `next` / `on_error` let each flow that sends a link decide where it
 * lands on success/failure, without this route needing to know about
 * signup vs. password-recovery specifically:
 *   - signup verification -> next=/set-password, on_error=/signup
 *   - password recovery   -> next=/reset-password, on_error=/forgot-password
 *
 * EMAIL VERIFICATION != REGISTRATION COMPLETE: a signup-verification
 * link only proves the address is real — registration only finishes
 * once /set-password's own submit creates the customer_users row (see
 * SetPasswordForm). A verified-but-unregistered user still needs
 * next=/set-password. But someone re-clicking an old signup-verification
 * link *after* already finishing registration (bookmarked it, clicked a
 * stale email long after) has a real customer_users row already —
 * sending them through /set-password again would ask them to re-set
 * their password outside of Forgot Password, for no reason. So: only
 * for that specific case (next === "/set-password"), check the
 * session's membership via the existing customer_users relationship
 * (no new table) and redirect straight to the app if it already exists.
 * This check is deliberately scoped to next === "/set-password" only —
 * password-recovery's next (/reset-password) must never be redirected
 * away like this, since resetting a password for an already-registered
 * user is the entire point of that flow.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/set-password";
  const onError = searchParams.get("on_error") ?? "/login";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      if (next === "/set-password" && data.user) {
        const membership = await getCurrentMembership(supabase, data.user.id);
        if (membership) {
          return NextResponse.redirect(`${origin}/sales-management`);
        }
      }

      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}${onError}?error=link_invalid`);
}
