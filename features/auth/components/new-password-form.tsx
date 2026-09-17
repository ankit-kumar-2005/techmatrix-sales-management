"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { newPasswordSchema } from "../schemas";
import { getFieldErrors } from "../lib/get-field-errors";
import { mapAuthErrorMessage } from "../lib/map-auth-error";
import { PasswordField } from "./password-field";
import { PasswordRequirements } from "./password-requirements";
import { MessageBanner } from "@/components/shared/message-banner";

type NewPasswordFormProps = {
  /** Button label while idle, e.g. "Set Password" or "Reset Password". */
  submitLabel: string;
  /** Button label while submitting, e.g. "Setting password..." */
  submittingLabel: string;
  /** Appended as /login?message=<value> once the password is updated. */
  successMessageKey: "password_created" | "password_reset";
};

/**
 * Used by /reset-password (forgot-password recovery). Sets the password,
 * signs out the session that came from the email link, then sends the
 * user to /login to authenticate with the password they just chose,
 * rather than silently continuing an already-authenticated session.
 *
 * (/set-password has its own SetPasswordForm — it does not share this
 * one, because finishing signup also has to create the customer. This
 * comment used to claim both pages shared this component; they don't.)
 */
export function NewPasswordForm({ submitLabel, submittingLabel, successMessageKey }: NewPasswordFormProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setFormError(null);

    const result = newPasswordSchema.safeParse({ password, confirmPassword });
    if (!result.success) {
      setFieldErrors(getFieldErrors(result.error));
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.updateUser({ password: result.data.password });

      if (error) {
        setFormError(mapAuthErrorMessage(error.message));
        // Re-enabled explicitly rather than by a finally block: the
        // success path below deliberately leaves the button disabled
        // while the browser navigates away, so there is no single exit
        // that is right for both.
        setIsSubmitting(false);
        return;
      }

      await supabase.auth.signOut();

      // HARD NAVIGATION, and replace() rather than push() — the same
      // move AcceptInvitationForm and LoginForm already make, for the
      // same two reasons plus one specific to this page.
      //
      // 1. The App Router's client Router Cache still holds RSC payloads
      //    rendered while the recovery session existed. A soft push
      //    reuses them, which is precisely the failure LoginForm's own
      //    comment records as having looked like "login redirects back
      //    to signup" when the account was fine.
      //
      // 2. router.refresh() used to fire on the line after router.push().
      //    push() does not settle before the next statement runs, so the
      //    refresh could land on /reset-password instead of /login — and
      //    /reset-password's server guard, now that signOut() has just
      //    cleared the session, redirects to /forgot-password. A
      //    successful reset could therefore end on "Reset your password"
      //    again instead of the login success banner.
      //
      // 3. replace() keeps the spent one-time recovery URL out of the
      //    back button, which would otherwise return to a page that can
      //    only bounce to /forgot-password.
      //
      // No setIsSubmitting(false) on this path on purpose: the button
      // stays disabled while the browser navigates away, so a
      // now-signed-out session cannot be submitted against twice.
      window.location.replace(`/login?message=${successMessageKey}`);
      return;
    } catch {
      setFormError("Something went wrong. Please try again.");
    }

    setIsSubmitting(false);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <PasswordField
          label="Password"
          autoComplete="new-password"
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
        value={confirmPassword}
        onChange={(event) => setConfirmPassword(event.target.value)}
        error={fieldErrors.confirmPassword}
        disabled={isSubmitting}
      />

      {formError ? <MessageBanner tone="error">{formError}</MessageBanner> : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-2 min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? submittingLabel : submitLabel}
      </button>
    </form>
  );
}
