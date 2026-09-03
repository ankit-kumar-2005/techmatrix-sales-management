"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { signUpSchema } from "../schemas";
import { getFieldErrors } from "../lib/get-field-errors";
import { mapAuthErrorMessage } from "../lib/map-auth-error";
import { generateTempPassword } from "../lib/generate-temp-password";
import { FormField } from "./form-field";

export function SignUpForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setFormError(null);
    setInfoMessage(null);
    setIsDuplicate(false);

    const result = signUpSchema.safeParse({ email });
    if (!result.success) {
      setFieldErrors(getFieldErrors(result.error));
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { data, error } = await supabase.auth.signUp({
        email: result.data.email,
        password: generateTempPassword(),
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/set-password&on_error=/signup`,
        },
      });

      if (error) {
        // error.code is Supabase's documented, stable signal for this case
        // ("user_already_exists") — checked first because the human-readable
        // error.message text varies by project configuration and isn't
        // safe to pattern-match on alone.
        const isDuplicateEmail =
          error.code === "user_already_exists" ||
          error.message.toLowerCase().includes("already registered") ||
          error.message.toLowerCase().includes("already exists");

        if (isDuplicateEmail) {
          setIsDuplicate(true);
          return;
        }

        setFormError(mapAuthErrorMessage(error.message));
        return;
      }

      // Supabase's documented signal for "this email already has a
      // confirmed account": signUp() succeeds with no error, but the
      // identities array comes back empty. No new confirmation email is
      // sent in that case, so we tell the user directly rather than
      // showing a misleading "check your email" message.
      const isObfuscatedExistingUser = data.user?.identities?.length === 0;
      if (isObfuscatedExistingUser) {
        setIsDuplicate(true);
        return;
      }

      if (data.session) {
        router.push("/set-password");
        router.refresh();
        return;
      }

      setInfoMessage(
        "Verification email sent. Please check your inbox and click the link to continue setting up your account.",
      );
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

      {formError ? (
        <p role="alert" className="text-sm text-red-600">
          {formError}
        </p>
      ) : null}

      {infoMessage ? (
        <p role="status" className="text-sm text-emerald-600">
          {infoMessage}
        </p>
      ) : null}

      {isDuplicate ? (
        <div role="alert" className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200">
          <p>Email is already registered. Please login.</p>
          <Link
            href="/login"
            className="mt-2 inline-block rounded-full bg-amber-800 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-amber-900"
          >
            Login
          </Link>
        </div>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        className="mt-2 min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? "Sending verification email..." : "Continue"}
      </button>

      <p className="text-center text-sm text-neutral-600">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-sky-600 hover:underline">
          Log In
        </Link>
      </p>
    </form>
  );
}
