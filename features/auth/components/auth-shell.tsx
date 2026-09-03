import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";

type AuthShellProps = {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
};

/**
 * The shared visual frame for every auth page (login, signup,
 * forgot-password, reset-password, set-password): logo, heading,
 * description, form slot, footer slot. Keeps sizing, spacing and
 * typography consistent across all of them instead of each page
 * reinventing its own card.
 */
export function AuthShell({ title, description, children, footer }: AuthShellProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-neutral-50 px-4 py-10 sm:px-6 sm:py-16">
      <Link href="/" className="mb-6 inline-block sm:mb-8">
        <Image
          src="/techmatrix-logo.png"
          alt="Techmatrix Consulting"
          width={516}
          height={387}
          priority
          className="h-14 w-auto sm:h-16"
        />
      </Link>

      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl shadow-sky-950/10 ring-1 ring-black/5 sm:p-8">
        <h1 className="text-xl font-bold text-neutral-900 sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{description}</p> : null}

        <div className="mt-6">{children}</div>

        {footer ? <div className="mt-6 border-t border-neutral-100 pt-5">{footer}</div> : null}
      </div>
    </div>
  );
}
