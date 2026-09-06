"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { newPasswordSchema } from "../schemas";
import { getFieldErrors } from "../lib/get-field-errors";
import { mapAuthErrorMessage } from "../lib/map-auth-error";
import { PasswordField } from "./password-field";
import { PasswordRequirements } from "./password-requirements";
import { MessageBanner } from "@/components/shared/message-banner";

/**
 * Signup-specific: unlike NewPasswordForm (used only by /reset-password
 * now), this doesn't sign out and bounce to /login after setting the
 * password. It also creates the customer record — this is the single
 * remaining server call standing between "email verified" and "using
 * the app," now that there is no separate Create Organization step. The
 * user already has a valid session (from clicking the verification
 * link), so it goes straight to /sales-management.
 */
export function SetPasswordForm() {
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
      const { error: passwordError } = await supabase.auth.updateUser({
        password: result.data.password,
      });

      if (passwordError) {
        setFormError(mapAuthErrorMessage(passwordError.message));
        return;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      const phone = (user?.user_metadata?.phone as string | undefined) ?? "";
      const companyName = (user?.user_metadata?.company_name as string | null | undefined) ?? null;
      const email = user?.email ?? "";

      const { error: customerError } = await supabase.rpc("create_customer_with_admin", {
        p_email: email,
        p_phone: phone,
        p_company_name: companyName,
      });

      if (customerError) {
        // Retrying this page after a customer was already created
        // (e.g. a refresh after success) shouldn't show an error — it
        // should just continue on, since the account is already set up.
        if (customerError.message.includes("already belongs to a customer")) {
          // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation, see comment below
          window.location.href = "/sales-management";
          return;
        }

        setFormError(
          "Your password was set, but we couldn't finish setting up your account. Please contact support.",
        );
        return;
      }

      // Hard navigation, not router.push + router.refresh — see the
      // matching note in login-form.tsx: the App Router's client-side
      // Router Cache can otherwise serve a stale RSC payload for this
      // auth-gated route immediately after the customer_users row is
      // created, which looked like "redirected back to signup" even
      // though create_customer_with_admin succeeded.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation
      window.location.href = "/sales-management";
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
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

      {formError ? (
        <MessageBanner tone="error">{formError}</MessageBanner>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-2 min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Setting up your account..." : "Set Password"}
      </button>
    </form>
  );
}
