"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { newPasswordSchema } from "@/features/auth/schemas";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { mapAuthErrorMessage } from "@/features/auth/lib/map-auth-error";
import { PasswordField } from "@/features/auth/components/password-field";
import { PasswordRequirements } from "@/features/auth/components/password-requirements";
import { MessageBanner } from "@/components/shared/message-banner";
import { formatRoleLabel } from "@/features/customers/lib/role-labels";
import { acceptInvitationAction } from "../actions";
import type { InvitationContext } from "../lib/get-invitation-context";

type AcceptInvitationFormProps = {
  invitationId: string;
  /** Server-verified via supabase.auth.getUser(). Non-null by
   *  construction: the page renders its own link-handler state when
   *  there is no session, so this component only ever mounts for an
   *  authenticated visitor. */
  authenticatedEmail: string;
  /** What the DATABASE is willing to tell this viewer about the
   *  invitation (get_invitation_context). Null when there's no such
   *  invitation or the lookup failed, in which case the password step
   *  still renders and the acceptance RPC remains the authority. */
  context: InvitationContext | null;
};

/** How long the "Invitation accepted" state stays on screen before the
 *  invitee is taken to /login. Long enough to read, short enough not to
 *  feel stuck; the button below it goes there immediately. */
const REDIRECT_TO_LOGIN_MS = 2500;

/** One label + one value, the shape every row of the invitation summary
 *  and the wrong-account panel uses. Local to this file on purpose — it
 *  has exactly one consumer (CLAUDE.md Section M: start local, promote
 *  when actually reused). */
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-wide text-neutral-500 uppercase">{label}</dt>
      <dd className="mt-0.5 truncate text-sm font-medium text-neutral-800">{children}</dd>
    </div>
  );
}

/**
 * The invitation's password step — and, deliberately, nothing before it.
 *
 * WHAT WAS REMOVED AND WHY: this component used to open on an email-entry
 * form ("Accept your invitation" → type your address → Continue) that
 * called supabase.auth.signUp() to send a SECOND verification email. That
 * was a whole duplicate email-confirmation flow living inside the
 * acceptance page, and it made the invitee prove an address Supabase had
 * already verified one click earlier. The invitation email establishes
 * who was invited; asking again was redundant work and an extra failure
 * point. Arriving without a session now means the emailed link did not
 * work, which the page says plainly instead of offering to start a
 * parallel signup.
 *
 * REUSES THE NORMAL SIGNUP PASSWORD MECHANICS VERBATIM — newPasswordSchema,
 * PasswordField, PasswordRequirements, mapAuthErrorMessage. Only the
 * submit behaviour differs: normal signup finishes with
 * create_customer_with_admin() (which creates a customer), invitation
 * acceptance finishes with accept_customer_user_invitation() (which never
 * does). The two flows share components, never their final step.
 *
 * ORDER IS LOAD-BEARING: the password is set FIRST and acceptance runs
 * only if that succeeded. A failed password update therefore leaves the
 * invitation PENDING and creates no membership.
 */
export function AcceptInvitationForm({
  invitationId,
  authenticatedEmail,
  context,
}: AcceptInvitationFormProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isAccepted, setIsAccepted] = useState(false);

  /** Terminal invitation states, surfaced BEFORE the user fills in a
   *  password that could only be rejected. Only ever populated for the
   *  genuine invitee — the context function returns a status to nobody
   *  else. */
  const blockedMessage =
    context?.effectiveStatus === "ACCEPTED"
      ? "This invitation has already been accepted."
      : context?.effectiveStatus === "CANCELLED"
        ? "This invitation is no longer valid."
        : context?.effectiveStatus === "EXPIRED"
          ? "This invitation has expired. Please ask your administrator to send a new invitation."
          : null;

  // The membership exists and the onboarding session has already been
  // ended by the time this runs, so /login is the only place left to be.
  // Hard navigation via replace(), not router.push: the App Router's
  // client Router Cache would otherwise serve an RSC payload rendered
  // while that session still existed, and replace() keeps a one-time
  // invitation URL out of the back button.
  useEffect(() => {
    if (!isAccepted) return;
    const timer = setTimeout(() => window.location.replace("/login"), REDIRECT_TO_LOGIN_MS);
    return () => clearTimeout(timer);
  }, [isAccepted]);

  /**
   * The way OUT of a wrong-account dead end.
   *
   * An invitation is bound to the address it was issued to, and that is
   * deliberately not negotiable — the acceptance RPC compares it against
   * the email Supabase itself verified. When the browser already holds
   * somebody else's session (very commonly the admin who sent the
   * invitation, testing it in their own browser), the only correct
   * resolution is to sign that account out and open the link again.
   *
   * Accounts are never switched automatically.
   */
  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);

    try {
      const supabase = createClient();
      // scope: "local" — NOT the default "global". A global sign-out
      // revokes every refresh token the account holds, which would sign
      // the admin out of their phone and every other machine merely
      // because they opened somebody else's invitation link once. Only
      // this browser's session should end here.
      await supabase.auth.signOut({ scope: "local" });
      // Full reload, not router.push: which state this page renders is
      // decided server-side from the session cookie.
      window.location.replace(`/accept-invitation?invitation_id=${encodeURIComponent(invitationId)}`);
    } catch {
      setFormError("Something went wrong signing out. Please try again.");
      setIsSigningOut(false);
    }
  }

  /**
   * Set the password, then accept — in that order, never in parallel.
   *
   * Every decision about whether this invitation may be accepted is made
   * inside accept_customer_user_invitation(): it re-reads the invitation
   * under a row lock, compares it against the caller's VERIFIED email,
   * re-checks status/expiry/role/manager, and creates the membership from
   * the invitation's own customer_id, role_id and manager_id with
   * user_id = auth.uid(). Nothing this component sends can influence any
   * of that beyond naming which invitation.
   */
  async function handleSetPasswordAndAccept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setFormError(null);

    const parsed = newPasswordSchema.safeParse({ password, confirmPassword });
    if (!parsed.success) {
      setFieldErrors(getFieldErrors(parsed.error));
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

      if (error) {
        // Password never set -> acceptance never runs -> no membership is
        // created and the invitation stays PENDING, still usable.
        setFormError(mapAuthErrorMessage(error.message));
        return;
      }

      const result = await acceptInvitationAction(invitationId);

      if (!result.success) {
        // The password IS set. Acceptance is safe to retry: the RPC
        // creates nothing until it succeeds and is idempotent for the
        // same person, so the form stays on screen rather than claiming
        // a success that never happened.
        setFormError(result.error ?? "This invitation could not be accepted.");
        return;
      }

      // The transaction has committed: the membership exists and the
      // invitation is ACCEPTED. Only now does the UI claim success.
      //
      // End this browser's session before showing that. The session the
      // invitee holds came from a one-time email link and was only ever
      // the onboarding context for completing the invitation — never an
      // application session. Logging in properly once is what proves the
      // new password works and puts them on the normal authenticated
      // path. scope: "local" again, so nothing is revoked on any other
      // device.
      try {
        await supabase.auth.signOut({ scope: "local" });
      } catch {
        // Acceptance already committed; a failed sign-out must not be
        // reported as a failed acceptance. They will simply still be
        // signed in when they reach /login, which is harmless.
      }

      setIsAccepted(true);
    } catch {
      setFormError("Something went wrong while accepting the invitation. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  // ---- Accepted -----------------------------------------------------------
  if (isAccepted) {
    return (
      <div className="flex flex-col gap-4">
        <MessageBanner tone="success">
          <p className="font-semibold">Invitation accepted</p>
          <p className="mt-0.5">
            Your account has been created successfully. Please log in with your email and password.
          </p>
        </MessageBanner>

        <button
          type="button"
          onClick={() => window.location.replace("/login")}
          className="min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700"
        >
          Continue to Log In
        </button>

        <p role="status" className="text-center text-xs text-neutral-500">
          Taking you to the login page&hellip;
        </p>
      </div>
    );
  }

  // ---- Wrong account ------------------------------------------------------
  // The DATABASE decided this, not the browser: get_invitation_context
  // compares the invitation against the email Supabase itself verified
  // for this session. The invited address is shown MASKED — whoever is
  // looking at this screen is, by definition, not the person it was sent
  // to, and a masked hint is enough to recognise your own address without
  // handing a third party's out to a link-holder.
  if (context && !context.matchesCurrentUser) {
    return (
      <div className="flex flex-col gap-4">
        <MessageBanner tone="warning">This invitation was sent to a different email address.</MessageBanner>

        <dl className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
          <DetailRow label="Invited address">{context.invitedEmailHint ?? "—"}</DetailRow>
          <DetailRow label="Currently signed in as">{authenticatedEmail}</DetailRow>
        </dl>

        <p className="text-sm leading-relaxed text-neutral-600">
          Sign out of this account, then open the link from your invitation email again. This signs you out on
          this device only &mdash; your other devices stay signed in.
        </p>

        {formError ? <MessageBanner tone="error">{formError}</MessageBanner> : null}

        <div className="flex flex-col gap-3 sm:flex-row-reverse">
          <button
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
            aria-live="polite"
            className="min-h-11 flex-1 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSigningOut ? "Signing out..." : "Sign out"}
          </button>
          <Link
            href="/"
            className="min-h-11 flex-1 rounded-full border border-neutral-300 px-5 py-2.5 text-center text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
          >
            Cancel
          </Link>
        </div>
      </div>
    );
  }

  // ---- Terminal invitation state ------------------------------------------
  if (blockedMessage) {
    return (
      <div className="flex flex-col gap-4">
        <MessageBanner tone="warning">{blockedMessage}</MessageBanner>
        <Link
          href="/login"
          className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-center text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50"
        >
          Go to Log In
        </Link>
      </div>
    );
  }

  // ---- Invitation details + set password (the first and only step) --------
  // Everything below came from get_invitation_context, which returns it
  // ONLY to the invited person. Nothing sensitive is exposed: no ids, no
  // invited_by, nobody else in the organization.
  return (
    <div className="flex flex-col gap-4">
      {context?.matchesCurrentUser ? (
        <dl className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
          {context.invitedFullName ? <DetailRow label="Name">{context.invitedFullName}</DetailRow> : null}
          {context.companyName ? <DetailRow label="Company">{context.companyName}</DetailRow> : null}
          {context.roleName ? <DetailRow label="Role">{formatRoleLabel(context.roleName)}</DetailRow> : null}
          {context.managerName ? <DetailRow label="Manager">{context.managerName}</DetailRow> : null}
          <DetailRow label="Email">{authenticatedEmail}</DetailRow>
        </dl>
      ) : null}

      {formError ? <MessageBanner tone="error">{formError}</MessageBanner> : null}

      <form onSubmit={handleSetPasswordAndAccept} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <PasswordField
            label="Password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            error={fieldErrors.password}
            disabled={isSubmitting}
          />
          <PasswordRequirements value={password} />
        </div>

        <PasswordField
          label="Confirm Password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          error={fieldErrors.confirmPassword}
          disabled={isSubmitting}
        />

        <button
          type="submit"
          disabled={isSubmitting}
          aria-live="polite"
          className="mt-2 min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? "Setting up your account..." : "Set Password"}
        </button>
      </form>
    </div>
  );
}
