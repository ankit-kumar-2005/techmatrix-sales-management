"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

/** One retry per tab. Without this, a browser that holds a session the
 *  server genuinely cannot read (third-party-cookie blocking, a cleared
 *  server cookie) would reload forever. */
const RETRY_FLAG = "techmatrix.invitation.session-retry";

/**
 * Renders nothing unless it has something to fix.
 *
 * WHY THIS EXISTS: the invitation link's session is established by the
 * Supabase BROWSER client and stored in cookies, while /accept-invitation
 * is server-rendered FROM those cookies. Those two steps can race — the
 * navigation can reach the server a moment before the cookie does — and
 * the result is a server render that says "no session" for a hand-off
 * that actually succeeded, leaving the invitee staring at a dead end
 * while their browser is, in fact, signed in.
 *
 * So before showing that dead end, ask the browser directly. If it does
 * hold a session, the cookie exists now and one reload renders the real
 * page. If it doesn't, this stays invisible and the message stands.
 *
 * This is recovery, not authorization: it only ever triggers a reload.
 * Whether the session may accept the invitation is decided entirely by
 * accept_customer_user_invitation() against the caller's verified email.
 */
export function InvitationSessionRecovery() {
  const [isRecovering, setIsRecovering] = useState(false);

  useEffect(() => {
    let isCancelled = false;

    async function recover() {
      let alreadyRetried = false;
      try {
        alreadyRetried = window.sessionStorage.getItem(RETRY_FLAG) === "1";
      } catch {
        // Private mode / storage blocked. Treat as "not retried yet" but
        // skip recovery entirely, since without the flag a reload loop
        // could not be prevented.
        return;
      }
      if (alreadyRetried) return;

      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      if (isCancelled || !data.session) return;

      try {
        window.sessionStorage.setItem(RETRY_FLAG, "1");
      } catch {
        return;
      }

      setIsRecovering(true);
      window.location.reload();
    }

    recover().catch(() => {
      // Nothing to recover — leave the page's own message in place.
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  if (!isRecovering) return null;

  return (
    <p role="status" className="text-sm leading-relaxed text-neutral-600">
      Signing you in&hellip;
    </p>
  );
}
