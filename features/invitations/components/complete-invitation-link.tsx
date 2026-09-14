"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { MessageBanner } from "@/components/shared/message-banner";

type CompleteInvitationLinkProps = {
  /** Passed straight through to the accept page, which does the real
   *  shape validation — this component never sends it anywhere. */
  invitationId: string;
};

type LinkOutcome = {
  error: string | null;
  hasAuthPayload: boolean;
  /** Parameter NAMES only, never values — enough to tell a fragment
   *  hand-off from a PKCE one from nothing at all, with no token ever
   *  rendered to the screen. */
  hashKeys: string[];
  queryKeys: string[];
};

/**
 * What Supabase left on the URL when it bounced the invitee back here.
 *
 * MUST be read BEFORE the Supabase browser client is constructed: that
 * client consumes the fragment and then strips it with
 * history.replaceState, so reading afterwards sees a clean URL and
 * cannot tell a successful hand-off from a link that never arrived.
 *
 *   #access_token=… / ?code=…      the link carried a real session
 *   #error=… / ?error=…            Supabase rejected it (expired, reused)
 *   neither                        this page was opened without a link
 */
function readLinkOutcome(): LinkOutcome {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);

  return {
    error:
      hash.get("error_description") ??
      query.get("error_description") ??
      hash.get("error") ??
      query.get("error"),
    hasAuthPayload: hash.has("access_token") || query.has("code"),
    hashKeys: [...hash.keys()],
    queryKeys: [...query.keys()],
  };
}

/**
 * The session the Supabase browser client just established lives in
 * COOKIES, and the next page is server-rendered from those cookies. The
 * client writes them asynchronously, so navigating the instant
 * getSession() resolves can arrive at the server before the cookie does
 * — the server then renders "no session" for a hand-off that actually
 * succeeded, which is a dead end for the invitee.
 *
 * So: wait until the auth cookie is genuinely visible to document.cookie
 * (it is not httpOnly — the browser client owns it) before navigating,
 * with a short ceiling so a naming change in @supabase/ssr degrades to
 * "navigate anyway" rather than hanging. The accept page carries its own
 * recovery for the case where this still loses the race.
 */
async function waitForAuthCookie(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (document.cookie.includes("-auth-token")) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The landing half of an emailed invitation link, and nothing else.
 *
 * Supabase's verify endpoint has already confirmed the address by the
 * time the browser gets here, and hands the session over in the URL
 * FRAGMENT (#access_token=…). A fragment is never sent to the server, so
 * no Server Component or Route Handler can see it — only the browser
 * can. The Supabase browser client picks it up automatically on
 * construction (detectSessionInUrl) and writes the session to cookies.
 *
 * THE IDENTITY TRAP THIS GUARDS AGAINST: getSession() returns whatever
 * session the cookies hold, which is NOT necessarily the one this link
 * just created. If the link was expired or already used — invitation
 * links are single-use — Supabase establishes nothing, and an admin who
 * happened to already be signed in this browser would be forwarded on
 * their OWN session. So a session alone is not treated as proof: the URL
 * must actually have carried an auth payload.
 */
export function CompleteInvitationLink({ invitationId }: CompleteInvitationLinkProps) {
  const [failure, setFailure] = useState<string | null>(null);
  /** What actually arrived, for the failure screen to report. Populated
   *  only when something went wrong, so the happy path renders none of
   *  it. */
  const [diagnostics, setDiagnostics] = useState<{
    hashKeys: string[];
    queryKeys: string[];
    hadSession: boolean;
  } | null>(null);

  // Captured on the FIRST effect run and reused after that. React's
  // StrictMode runs effects twice in development: by the second run the
  // Supabase client from the first has already consumed and stripped the
  // fragment, so re-reading the URL would report "no auth payload" for a
  // hand-off that in fact worked, and fail a perfectly good link. Refs
  // survive that remount; the URL does not.
  const outcomeRef = useRef<LinkOutcome | null>(null);

  const acceptHref = `/accept-invitation?invitation_id=${encodeURIComponent(invitationId)}`;

  useEffect(() => {
    if (outcomeRef.current === null) {
      outcomeRef.current = readLinkOutcome();
    }
    const outcome = outcomeRef.current;

    let isCancelled = false;
    const supabase = createClient();

    async function complete() {
      const { data } = await supabase.auth.getSession();
      if (isCancelled) return;

      const seen = {
        hashKeys: outcome.hashKeys,
        queryKeys: outcome.queryKeys,
        hadSession: Boolean(data.session),
      };

      if (outcome.error) {
        setDiagnostics(seen);
        setFailure(outcome.error);
        return;
      }

      // No payload, or no session: either way this link did not sign
      // anybody in. Never forward on a pre-existing session here.
      if (!outcome.hasAuthPayload || !data.session) {
        setDiagnostics(seen);
        setFailure("");
        return;
      }

      await waitForAuthCookie();
      if (isCancelled) return;

      // Full reload, not a router push: which state the accept page
      // renders is decided server-side from the session cookie.
      window.location.replace(acceptHref);
    }

    complete().catch(() => {
      if (!isCancelled) setFailure("");
    });

    return () => {
      isCancelled = true;
    };
  }, [acceptHref]);

  if (failure !== null) {
    return (
      <div className="flex flex-col gap-4">
        <MessageBanner tone="error">
          <p>
            This invitation link didn&rsquo;t sign you in. Invitation links work once and then expire, so it
            was most likely already used or has run out of time.
          </p>
          {failure ? <p className="mt-1.5 text-xs opacity-80">Reason: {failure}</p> : null}
          <p className="mt-1.5">Ask your administrator to resend the invitation, then open the newest email.</p>
        </MessageBanner>

        {/* Parameter NAMES and a yes/no, never any token value. This is
            what distinguishes the three ways this screen can be reached:
            Supabase handed over a fragment session, handed over a PKCE
            code, or redirected here with nothing (which in practice
            means the redirect URL was not allow-listed). */}
        {diagnostics ? (
          <details className="rounded-lg bg-neutral-50 px-4 py-3 text-xs text-neutral-500 ring-1 ring-neutral-100">
            <summary className="cursor-pointer font-medium text-neutral-600">Technical details</summary>
            <dl className="mt-2 flex flex-col gap-1">
              <div>
                <dt className="inline font-medium">URL query keys: </dt>
                <dd className="inline">{diagnostics.queryKeys.join(", ") || "(none)"}</dd>
              </div>
              <div>
                <dt className="inline font-medium">URL fragment keys: </dt>
                <dd className="inline">{diagnostics.hashKeys.join(", ") || "(none)"}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Session established: </dt>
                <dd className="inline">{diagnostics.hadSession ? "yes" : "no"}</dd>
              </div>
            </dl>
          </details>
        ) : null}

        <Link
          href={acceptHref}
          className="min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-sky-700"
        >
          Continue Anyway
        </Link>
      </div>
    );
  }

  return (
    <p role="status" className="text-sm leading-relaxed text-neutral-600">
      Confirming your email address and opening your invitation&hellip;
    </p>
  );
}
