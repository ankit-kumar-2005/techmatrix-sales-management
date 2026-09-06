"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { forgotPasswordSchema } from "../schemas";
import { getFieldErrors } from "../lib/get-field-errors";
import { mapAuthErrorMessage } from "../lib/map-auth-error";
import { FormField } from "@/components/shared/form-field";
import { MessageBanner } from "@/components/shared/message-banner";

const GENERIC_SUCCESS_MESSAGE =
  "If an account exists for this email, a password reset link has been sent. Please check your email.";

export function ForgotPasswordForm() {
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setFormError(null);
    setInfoMessage(null);

    const result = forgotPasswordSchema.safeParse({ email });
    if (!result.success) {
      setFieldErrors(getFieldErrors(result.error));
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resetPasswordForEmail(result.data.email, {
        redirectTo: `${window.location.origin}/auth/callback?next=/reset-password&on_error=/forgot-password`,
      });

      // Supabase does not distinguish "email not found" from success here
      // by design (anti-enumeration). A returned error at this point is
      // something else — rate limiting, a network issue — so it's safe to
      // surface without leaking whether the account exists.
      if (error) {
        setFormError(mapAuthErrorMessage(error.message));
        return;
      }

      setInfoMessage(GENERIC_SUCCESS_MESSAGE);
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <FormField
        label="Email"
        type="email"
        autoComplete="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={fieldErrors.email}
        disabled={isSubmitting}
      />

      {formError ? <MessageBanner tone="error">{formError}</MessageBanner> : null}
      {infoMessage ? <MessageBanner tone="success">{infoMessage}</MessageBanner> : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-2 min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Sending reset link..." : "Send Reset Link"}
      </button>

      <p className="text-center text-sm text-neutral-600">
        <Link href="/login" className="font-semibold text-sky-600 hover:underline">
          Back to Login
        </Link>
      </p>
    </form>
  );
}
