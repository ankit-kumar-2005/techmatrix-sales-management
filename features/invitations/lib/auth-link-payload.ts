/**
 * BROWSER-ONLY. What Supabase left on the URL after it verified an
 * emailed link, read by hand instead of by the Supabase client.
 *
 * WHY BY HAND — this is the bug this module exists to fix:
 * sendInvitationLink() has to generate an IMPLICIT-flow link, because a
 * PKCE link stores its code verifier on whoever started the flow (here a
 * server process) while the person who finishes it is the invitee in
 * their own browser. Supabase therefore hands the session back in the
 * URL FRAGMENT (#access_token=...&refresh_token=...).
 *
 * But every browser client in this app comes from @supabase/ssr's
 * createBrowserClient, which HARD-CODES flowType: "pkce" (it is not an
 * option — see node_modules/@supabase/ssr/dist/main/createBrowserClient.js).
 * When auth-js's detectSessionInUrl then sees an implicit fragment while
 * configured for PKCE, it does not read it: it throws
 * AuthPKCEGrantCodeExchangeError("Not a valid PKCE flow url.")
 * (GoTrueClient._getSessionFromURL). So the automatic hand-off could
 * never establish a session for an invitation link, no matter how many
 * times the page retried.
 *
 * Reading the fragment here and calling setSession() with it bypasses
 * that mismatch entirely, and works whichever flow type any future
 * Supabase client happens to be configured for.
 *
 * Nothing here authorizes anything. These tokens are Supabase's own,
 * minted by its verify endpoint for the address IT confirmed; every
 * decision about the invitation is still made by
 * accept_customer_user_invitation() against auth.uid().
 */
export type AuthLinkPayload = {
  /** Present only when the link actually carried a session. */
  session: { accessToken: string; refreshToken: string } | null;
  /** Supabase's own rejection text (expired link, already used, ...). */
  error: string | null;
  /** How Supabase labelled the link: "signup", "magiclink", "invite",
   *  "recovery", ... Used to leave password-recovery links alone. */
  linkType: string | null;
  /** A browser-initiated PKCE flow landed here instead. Never true for
   *  an invitation link; kept so a caller can report it accurately
   *  rather than reporting "nothing arrived". */
  hasPkceCode: boolean;
};

/**
 * MUST run before any Supabase browser client is constructed on the
 * page: that client strips the fragment with history.replaceState as
 * part of its own initialization, and a stripped URL cannot be told
 * apart from a link that never arrived.
 */
export function readAuthLinkPayload(): AuthLinkPayload {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);

  const accessToken = hash.get("access_token");
  const refreshToken = hash.get("refresh_token");

  return {
    // Both halves or nothing: setSession() needs the refresh token as
    // well, and half a payload is not a usable session.
    session: accessToken && refreshToken ? { accessToken, refreshToken } : null,
    error:
      hash.get("error_description") ??
      query.get("error_description") ??
      hash.get("error") ??
      query.get("error"),
    linkType: hash.get("type") ?? query.get("type"),
    hasPkceCode: query.has("code"),
  };
}

/**
 * Takes the tokens back out of the address bar once they have been read.
 *
 * replaceState, not a navigation: no history entry, no reload, so the
 * back button never returns to a URL carrying a session. Also stops any
 * Supabase client constructed later on the same page from tripping over
 * a fragment it is not configured to parse.
 */
export function stripAuthLinkFragment(): void {
  const url = new URL(window.location.href);
  if (!url.hash) return;
  url.hash = "";
  window.history.replaceState(window.history.state, "", url.toString());
}
