"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { loginSchema } from "../schemas";
import { getFieldErrors } from "../lib/get-field-errors";
import { mapAuthErrorMessage } from "../lib/map-auth-error";
import { FormField } from "@/components/shared/form-field";
import { PasswordField } from "./password-field";
import { MessageBanner } from "@/components/shared/message-banner";
import { LockIcon, MailIcon } from "@/features/sales-management/components/icons";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setFormError(null);

    const result = loginSchema.safeParse({ email, password });
    if (!result.success) {
      setFieldErrors(getFieldErrors(result.error));
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signInWithPassword(result.data);

      if (error) {
        setFormError(mapAuthErrorMessage(error.message));
        return;
      }

      // /sales-management's layout does the actual (server-side)
      // customer-membership check and redirects to /signup if the
      // user somehow has none — see CLAUDE.md Section H. A hard
      // navigation (not router.push + router.refresh) is deliberate
      // here: the App Router's client-side Router Cache can otherwise
      // serve a stale RSC payload for this auth-gated route right after
      // the session changes, which looked like "login redirects back
      // to signup" even though the account was fine.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- intentional hard navigation, see comment above
      window.location.href = "/sales-management";
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
        icon={<MailIcon className="h-4 w-4" />}
      />
      <div className="flex flex-col gap-1.5">
        <PasswordField
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          error={fieldErrors.password}
          disabled={isSubmitting}
          icon={<LockIcon className="h-4 w-4" />}
        />
        <Link
          href="/forgot-password"
          className="self-end text-xs font-semibold text-sky-600 hover:underline"
        >
          Forgot Password?
        </Link>
      </div>

      {formError ? <MessageBanner tone="error">{formError}</MessageBanner> : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-2 min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Logging in..." : "Log In"}
      </button>

      <p className="text-center text-sm text-neutral-600">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-semibold text-sky-600 hover:underline">
          Sign Up
        </Link>
      </p>
    </form>
  );
}
