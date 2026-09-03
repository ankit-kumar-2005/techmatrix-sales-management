import Image from "next/image";
import Link from "next/link";

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-8 bg-neutral-50 px-4 py-16 text-center sm:px-6">
      <Image
        src="/techmatrix-logo.png"
        alt="Techmatrix Consulting"
        width={516}
        height={387}
        priority
        className="h-20 w-auto sm:h-24"
      />

      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 sm:text-4xl lg:text-5xl">
          Techmatrix Sales Management
        </h1>
        <p className="text-lg font-semibold text-sky-600">Modern Sales Management Platform</p>
        <p className="mx-auto max-w-xl text-base leading-relaxed text-neutral-600">
          Manage leads, contacts, opportunities, tasks, and sales performance efficiently.
        </p>
      </div>

      <div className="flex w-full max-w-xs flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row">
        <Link
          href="/login"
          className="min-h-11 rounded-full border-2 border-neutral-900 px-8 py-2.5 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-900 hover:text-white"
        >
          Login
        </Link>
        <Link
          href="/signup"
          className="min-h-11 rounded-full bg-sky-600 px-8 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-700"
        >
          Get Started
        </Link>
      </div>

      <p className="rounded-full bg-neutral-900 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-white">
        Secure • Enterprise • Scalable
      </p>
    </div>
  );
}
