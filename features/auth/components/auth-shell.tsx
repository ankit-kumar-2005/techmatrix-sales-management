import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/shared/logo";

type AuthShellProps = {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Optional step indicator for multi-step flows (e.g. signup → set password). */
  step?: { current: number; total: number };
  /** Hides the centered logo entirely — for pages that render their own
   *  persistent header (logo + hamburger) above this shell instead. */
  hideLogo?: boolean;
};

/**
 * The shared visual frame for every auth page (login, signup,
 * forgot-password, reset-password, set-password): logo, heading,
 * description, form slot, footer slot. Keeps sizing, spacing and
 * typography consistent across all of them instead of each page
 * reinventing its own card. Purely presentational — no auth logic lives
 * here.
 */
export function AuthShell({ title, description, children, footer, step, hideLogo }: AuthShellProps) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-gradient-to-b from-sky-50 to-white px-4 py-10 sm:px-6 sm:py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -left-24 -z-10 h-72 w-72 rounded-full bg-sky-300/30 blur-3xl sm:h-96 sm:w-96"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-24 -right-24 -z-10 h-72 w-72 rounded-full bg-teal-300/25 blur-3xl sm:h-96 sm:w-96"
      />

      <div className={`mb-7 transition-opacity hover:opacity-80 sm:mb-9 ${hideLogo ? "hidden" : ""}`}>
        <Logo iconClassName="h-10 w-auto sm:h-12" />
      </div>

      <div className="w-full max-w-md rounded-[20px] bg-white p-7 shadow-2xl shadow-sky-950/15 ring-1 ring-black/5 sm:p-9">
        {step ? (
          <div className="mb-5">
            <div className="flex items-center gap-1.5">
              {Array.from({ length: step.total }).map((_, index) => (
                <span
                  key={index}
                  className={`h-1.5 flex-1 rounded-full ${
                    index < step.current ? "bg-sky-600" : "bg-neutral-200"
                  }`}
                />
              ))}
            </div>
            <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-neutral-400">
              Step {step.current} of {step.total}
            </p>
          </div>
        ) : null}
        <h1 className="text-xl font-bold tracking-tight text-neutral-900 sm:text-2xl">{title}</h1>
        {description ? <p className="mt-2 text-sm leading-relaxed text-neutral-600">{description}</p> : null}

        <div className="mt-7">{children}</div>

        {footer ? <div className="mt-6 border-t border-neutral-100 pt-5">{footer}</div> : null}
      </div>

      <Link
        href="/"
        className="mt-8 text-xs font-medium text-neutral-400 transition-colors hover:text-neutral-600"
      >
        ← Back to Home
      </Link>
    </div>
  );
}
