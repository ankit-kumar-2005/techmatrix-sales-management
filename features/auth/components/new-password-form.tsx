"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
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
 * Shared by /set-password (first password after signup verification) and
 * /reset-password (forgot-password recovery) — same fields, same
 * validation, same supabase.auth.updateUser() call. Both end the same
 * way: sign out the session that came from the email link, then send the
 * user to /login to authenticate with the password they just chose,
 * rather than silently continuing an already-authenticated session.
 */
export function NewPasswordForm({ submitLabel, submittingLabel, successMessageKey }: NewPasswordFormProps) {
  const router = useRouter();
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
        return;
      }

      await supabase.auth.signOut();
      router.push(`/login?message=${successMessageKey}`);
      router.refresh();
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
