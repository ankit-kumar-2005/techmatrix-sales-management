"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { MessageBanner } from "@/components/shared/message-banner";
import { readAuthLinkPayload, stripAuthLinkFragment, type AuthLinkPayload } from "../lib/auth-link-payload";

type InvitationLinkHandlerProps = {
  /** Shape-validated by the page, or "" when the link lost it (see the
   *  Site-URL fallback note in InvitationLinkFallback). Only ever
   *  forwarded back into the URL — never sent to the database. */
  invitationId: string;
};

/** One retry per tab, so a browser holding a session the server truly
 *  cannot read (blocked cookies, a cleared server cookie) reloads once
 *  instead of forever. */
const RETRY_FLAG = "techmatrix.invitation.session-retry";

/**
 * The session established below lives in COOKIES, and the invitation
 * screen is server-rendered from those cookies. The browser writes them
 * asynchronously, so navigating the instant setSession() resolves can
 * reach the server before the cookie does — the server would then render
 * "no session" for a hand-off that actually succeeded. Wait until the
 * cookie is genuinely visible, with a short ceiling so a naming change
 * in @supabase/ssr degrades to "navigate anyway" rather than hanging.
 */
async function waitForAuthCookie(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (document.cookie.includes("-auth-token")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The whole emailed-link hand-off, in one place.
 *
 * REPLACES TWO COMPONENTS: CompleteInvitationLink (which lived on a
 * separate /accept-invitation/continue page and relied on the Supabase
 * client picking the fragment up by itself — it structurally cannot, see
 * lib/auth-link-payload.ts) and InvitationSessionRecovery (which reloaded
 * when the cookie lost a race). Both behaviours are folded in here, so
 * the invitation email now points straight at /accept-invitation and
 * there is exactly one landing route, one session hand-off and one
 * recovery path.
 *
 * THE IDENTITY TRAP THIS GUARDS AGAINST: an admin may already be signed
 * in in this browser. A pre-existing session is never treated as proof
 * of anything — this component forwards only when the URL itself carried
 * a session (which then REPLACES whoever was signed in, as it must), or
 * when a session exists that the server simply hasn't seen yet. Which
 * identity may accept the invitation is decided by
 * accept_customer_user_invitation() against auth.uid() regardless.
 */
export function InvitationLinkHandler({ invitationId }: InvitationLinkHandlerProps) {
  const [failure, setFailure] = useState<string | null>(null);

  // Captured on the FIRST effect run and reused. React StrictMode runs
  // effects twice in development, and by the second run the fragment has
  // already been read and stripped — re-reading would report "nothing
  // arrived" for a link that worked. A ref survives that; the URL does not.
  const payloadRef = useRef<AuthLinkPayload | null>(null);

  const invitationHref = invitationId
    ? `/accept-invitation?invitation_id=${encodeURIComponent(invitationId)}`
    : "/accept-invitation";

  useEffect(() => {
    if (payloadRef.current === null) {
      payloadRef.current = readAuthLinkPayload();
      // Read once, then out of the address bar immediately.
      stripAuthLinkFragment();
    }
    const payload = payloadRef.current;

    let isCancelled = false;

    async function complete() {
      if (payload.error) {
        setFailure(payload.error);
        return;
      }

      const supabase = createClient();

      // ---- The link carried a session -----------------------------------
      if (payload.session) {
        const { error } = await supabase.auth.setSession({
          access_token: payload.session.accessToken,
          refresh_token: payload.session.refreshToken,
        });
        if (isCancelled) return;

        if (error) {
          setFailure(error.message);
          return;
        }

        await waitForAuthCookie();
        if (isCancelled) return;

        // Full reload, not a router push: which state the invitation
        // screen renders is decided server-side from the session cookie.
        window.location.replace(invitationHref);
        return;
      }

      // ---- No payload: did the cookie simply lose the race? --------------
      // Reached when this page was reloaded after a successful hand-off
      // but the server still rendered "no session". Ask the browser
      // directly, and reload once if it does hold one.
      let alreadyRetried = true;
      try {
        alreadyRetried = window.sessionStorage.getItem(RETRY_FLAG) === "1";
      } catch {
        // Private mode / storage blocked. Without the flag a reload loop
        // could not be prevented, so don't start one.
        setFailure("");
        return;
      }

      if (!alreadyRetried) {
        const { data } = await supabase.auth.getSession();
        if (isCancelled) return;

        if (data.session) {
          try {
            window.sessionStorage.setItem(RETRY_FLAG, "1");
          } catch {
            setFailure("");
            return;
          }
          window.location.reload();
          return;
        }
      }

      setFailure("");
    }

    complete().catch(() => {
      if (!isCancelled) setFailure("");
    });

    return () => {
      isCancelled = true;
    };
  }, [invitationHref]);

  if (failure === null) {
    return (
      <p role="status" className="text-sm leading-relaxed text-neutral-600">
        Confirming your email address and opening your invitation&hellip;
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <MessageBanner tone="error">
        <p>
          This invitation link didn&rsquo;t sign you in. Invitation links work once and then expire, so it was
          most likely already used or has run out of time.
        </p>
        {failure ? <p className="mt-1.5 text-xs opacity-80">Reason: {failure}</p> : null}
        <p className="mt-1.5">Ask your administrator to resend the invitation, then open the newest email.</p>
      </MessageBanner>

      <Link
        href="/login"
        className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-center text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
      >
        Already have a password? Log In
      </Link>
    </div>
  );
}
