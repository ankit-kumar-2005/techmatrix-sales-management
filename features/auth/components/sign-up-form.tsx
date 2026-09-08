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

/** Resend cooldown, in seconds — a rate-limit on how often this specific
 *  browser can trigger another verification email, not the link's own
 *  expiration (that stays whatever the Supabase project has configured,
 *  documented as 3600s/1hr by convention — never changed from app code). */
const RESEND_COOLDOWN_SECONDS = 60;

export function SignUpForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isDuplicate, setIsDuplicate] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Once a verification email has actually been sent, the form switches
  // to a dedicated "check your email" view for that address — pendingEmail
  // doubles as both "which view to show" and "which email resend targets".
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState<string | null>(null);
  const [resendError, setResendError] = useState<string | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((seconds) => (seconds > 0 ? seconds - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;

    setFormError(null);
    setIsDuplicate(false);

    const result = signUpSchema.safeParse({ name, email, phone, companyName });
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
            name: result.data.name,
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

      // Note: Supabase's signUp() response is identical whether this was
      // a brand-new email or a re-attempt for an email that already has
      // a pending, unverified signup (both cases: no error, a non-empty
      // identities array) — that's deliberate on Supabase's part, the
      // same anti-enumeration reasoning as ForgotPasswordForm. Either
      // way, no duplicate Auth user is created and a verification email
      // is (re-)sent, so this one message is accurate for both.
      setPendingEmail(result.data.email);
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setResendMessage(null);
      setResendError(null);
    } catch {
      setFormError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResend() {
    if (!pendingEmail || isResending || resendCooldown > 0) return;

    setIsResending(true);
    setResendMessage(null);
    setResendError(null);

    try {
      const supabase = createClient();
      const { error } = await supabase.auth.resend({
        type: "signup",
        email: pendingEmail,
        // Without this, resend() falls back to the project's default
        // Site URL instead of this flow's own callback — the root cause
        // of a resent link landing on the home page instead of
        // /set-password. Must match signUp()'s own emailRedirectTo above
        // exactly.
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=/set-password&on_error=/signup`,
        },
      });

      if (error) {
        // Supabase returns an error here specifically when there's no
        // pending signup left to resend for (e.g. the account was
        // verified in the meantime, in another tab) — that's a distinct,
        // known outcome, not a generic failure.
        const alreadyConfirmed = error.message.toLowerCase().includes("already confirmed");
        if (alreadyConfirmed) {
          setPendingEmail(null);
          setIsDuplicate(true);
          return;
        }

        setResendError(mapAuthErrorMessage(error.message));
        return;
      }

      setResendMessage("Verification email resent. Please check your inbox.");
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch {
      setResendError("Something went wrong. Please try again.");
    } finally {
      setIsResending(false);
    }
  }

  if (pendingEmail) {
    return (
      <div className="flex flex-col gap-4">
        <MessageBanner tone="success">
          Verification email sent to <strong>{pendingEmail}</strong>. Please check your inbox (and spam folder) to
          verify your account. If you already started signing up with this email before, we&apos;ve sent a new link.
        </MessageBanner>

        {resendMessage ? <MessageBanner tone="success">{resendMessage}</MessageBanner> : null}
        {resendError ? <MessageBanner tone="error">{resendError}</MessageBanner> : null}

        <div className="rounded-lg bg-neutral-50 px-4 py-4 text-center ring-1 ring-neutral-100">
          <p className="text-sm font-medium text-neutral-600">Didn&apos;t receive the email?</p>
          <button
            type="button"
            onClick={handleResend}
            disabled={isResending || resendCooldown > 0}
            className="mt-2 text-sm font-semibold text-sky-600 hover:underline disabled:cursor-not-allowed disabled:text-neutral-400 disabled:no-underline"
          >
            {isResending
              ? "Resending..."
              : resendCooldown > 0
                ? `Resend available in ${resendCooldown}s`
                : "Resend verification email"}
          </button>
        </div>

        <p className="text-center text-sm text-neutral-600">
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-sky-600 hover:underline">
            Log In
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
      <FormField
        label="Name"
        type="text"
        autoComplete="name"
        required
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={fieldErrors.name}
        disabled={isSubmitting}
      />

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

      {isDuplicate ? (
        <MessageBanner tone="warning">
          <p>This email is already registered. Please log in.</p>
          <Link
            href="/login"
            className="mt-2 inline-block rounded-full bg-amber-800 px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-amber-900"
          >
            Log In
          </Link>
        </MessageBanner>
      ) : null}

      <button
        type="submit"
        disabled={isSubmitting}
        aria-live="polite"
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
