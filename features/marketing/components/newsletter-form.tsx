"use client";

import { useId, useState, type FormEvent } from "react";

const CONTACT_EMAIL = "techmatrixsalesmanagment@gmail.com";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * No newsletter/email-list backend exists yet, so this opens the
 * visitor's email client addressed to the real support inbox instead of
 * faking a "subscribed" confirmation — same honest pattern as the
 * contact form.
 */
export function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const inputId = useId();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!EMAIL_PATTERN.test(email)) {
      setError("Enter a valid email address");
      return;
    }

    setError(null);
    const params = new URLSearchParams({
      subject: "Newsletter Signup",
      body: `Please add this email to the newsletter list: ${email}`,
    });
    window.location.href = `mailto:${CONTACT_EMAIL}?${params.toString().replace(/\+/g, "%20")}`;
    setIsSubmitted(true);
  }

  if (isSubmitted) {
    return <p className="mt-4 text-sm text-teal-300">Opening your email client to confirm…</p>;
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="mt-4 flex flex-col gap-2">
      <div className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          Email address
        </label>
        <input
          id={inputId}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : undefined}
          className="min-w-0 flex-1 rounded-lg border border-white/15 bg-white/5 px-3.5 py-2.5 text-sm text-white outline-none transition-colors placeholder:text-slate-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-400/30"
        />
        <button
          type="submit"
          className="shrink-0 rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-sky-500"
        >
          Subscribe
        </button>
      </div>
      {error ? (
        <p id={`${inputId}-error`} role="alert" className="text-xs text-red-300">
          {error}
        </p>
      ) : null}
    </form>
  );
}
