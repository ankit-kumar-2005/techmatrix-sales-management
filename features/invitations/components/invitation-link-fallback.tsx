"use client";

import { useEffect } from "react";
import { readAuthLinkPayload } from "../lib/auth-link-payload";

/** Supabase link types this may forward. "recovery" is deliberately
 *  absent: a password-reset link must stay with /reset-password. */
const FORWARDABLE_LINK_TYPES = new Set(["signup", "magiclink", "invite"]);

/**
 * Renders nothing, does nothing, and creates no Supabase client — unless
 * the home page was opened with an auth session in its URL fragment.
 *
 * WHY IT EXISTS — this is the reported bug's outer half. Supabase honours
 * `redirect_to` only when it matches the project's Site URL hostname or
 * one of its allow-listed Redirect URLs. When it does not, GoTrue does
 * NOT return an error: it silently redirects to the project's SITE URL
 * instead, and still appends the session fragment. For this app that
 * means the invitee clicks "Confirm email address" and lands on the
 * marketing home page, session in hand, with nothing on the page that
 * looks at it — which is exactly the "it opens the Home page" symptom.
 *
 * The real fix is configuration (APP_URL must be a stable origin that is
 * allow-listed in Supabase — see lib/app-url.ts). This is the safety net
 * that keeps a misconfiguration from silently swallowing a live
 * invitation: the fragment is forwarded, untouched, to the one route
 * that knows how to consume it. /accept-invitation resolves which
 * invitation it belongs to from the session itself
 * (get_pending_invitation_for_current_user), because the redirect that
 * dropped us here dropped the invitation id with it.
 *
 * Deliberately narrow: no session is read or established here, nothing
 * is stored, and a visitor arriving at the home page normally never
 * triggers any of it.
 */
export function InvitationLinkFallback() {
  useEffect(() => {
    const payload = readAuthLinkPayload();

    // Only a fragment carrying a real session, from one of the two email
    // types the invitation flow sends. Everything else — a normal visit,
    // a PKCE `?code=` from a browser-initiated flow, a recovery link —
    // is left completely alone.
    if (!payload.session) return;
    if (payload.linkType && !FORWARDABLE_LINK_TYPES.has(payload.linkType)) return;

    // The hash is carried across verbatim; InvitationLinkHandler is the
    // single place that reads it and calls setSession().
    window.location.replace(`/accept-invitation${window.location.hash}`);
  }, []);

  return null;
}
