import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

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
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/set-password";
  const onError = searchParams.get("on_error") ?? "/login";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}${onError}?error=link_invalid`);
}
