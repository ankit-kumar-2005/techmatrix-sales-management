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
/**
 * `next`/`on_error` are redirect TARGETS, and this route pastes them
 * straight onto `origin`. A value like "//evil.com" would produce
 * "https://thisapp.com//evil.com", which browsers follow off-site as a
 * protocol-relative URL — so only same-origin paths are accepted, and
 * anything else falls back to the caller's default.
 *
 * Added with the invitation flow specifically because that flow is the
 * first to put a value in `next` that carries its own query string
 * ("/accept-invitation?invitation_id=…") and the first where the value
 * originates from a link an invitee arrived on rather than a fixed
 * string in this codebase — both of which widen what reaches this
 * parameter. Every existing caller ("/set-password", "/reset-password")
 * passes this check unchanged, so signup verification, password
 * recovery and login behave exactly as before.
 */
function safeRedirectPath(value: string | null, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  return value;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = safeRedirectPath(searchParams.get("next"), "/set-password");
  const onError = safeRedirectPath(searchParams.get("on_error"), "/login");

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

  // Built through URL rather than string concatenation: on_error can now
  // carry its own query string ("/accept-invitation?invitation_id=…"),
  // and appending "?error=…" to that would produce a second "?" — which
  // would silently fold the error flag into the previous parameter's
  // value instead of adding one. Unchanged for the existing callers,
  // whose on_error values have no query string of their own.
  const errorUrl = new URL(onError, origin);
  errorUrl.searchParams.set("error", "link_invalid");
  return NextResponse.redirect(errorUrl);
}
