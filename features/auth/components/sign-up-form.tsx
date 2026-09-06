"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { signUpSchema } from "../schemas";
import { getFieldErrors } from "../lib/get-field-errors";
import { mapAuthErrorMessage } from "../lib/map-auth-error";
import { generateTempPassword } from "../lib/generate-temp-password";
import { FormField } from "@/components/shared/form-field";
import { MessageBanner } from "@/components/shared/message-banner";
import { MailIcon, PhoneIcon } from "@/features/sales-management/components/icons";

export function SignUpForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((seconds) => (seconds > 0 ? seconds - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting || resendCooldown > 0) return;

    setFormError(null);
    setInfoMessage(null);
    setIsDuplicate(false);

    const result = signUpSchema.safeParse({ email, phone, companyName });
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
          // Carried through email verification via Supabase's own
          // user_metadata mechanism (not a workaround — this is the
          // supported way to pass extra signup data through a flow that
          // may be completed in a different browser/tab than it started
          // in). Read back in SetPasswordForm to create the customer.
          data: {
            phone: result.data.phone,
            company_name: result.data.companyName ?? null,
          },
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
      setResendCooldown(15);
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
        required
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        error={fieldErrors.email}
        disabled={isSubmitting}
        icon={<MailIcon className="h-4 w-4" />}
      />

      <FormField
        label="Phone"
        type="tel"
        autoComplete="tel"
        required
        value={phone}
        onChange={(event) => setPhone(event.target.value)}
        error={fieldErrors.phone}
        disabled={isSubmitting}
        icon={<PhoneIcon className="h-4 w-4" />}
      />

      <FormField
        label="Company Name (Optional)"
        type="text"
        autoComplete="organization"
        value={companyName}
        onChange={(event) => setCompanyName(event.target.value)}
        error={fieldErrors.companyName}
        disabled={isSubmitting}
      />

      {formError ? <MessageBanner tone="error">{formError}</MessageBanner> : null}

      {infoMessage ? <MessageBanner tone="success">{infoMessage}</MessageBanner> : null}

      {isDuplicate ? (
        <MessageBanner tone="warning">
          <p>Email is already registered. Please login.</p>
          <Link
            href="/login"
            className="mt-2 inline-block rounded-full bg-amber-800 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-900"
          >
            Login
          </Link>
        </MessageBanner>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting || resendCooldown > 0}
        aria-live="polite"
        className="mt-2 min-h-11 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting
          ? "Sending verification email..."
          : resendCooldown > 0
            ? `Resend available in ${resendCooldown}s`
            : "Continue"}
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
