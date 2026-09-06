import Image from "next/image";
import Link from "next/link";
import { SiteHeader } from "@/features/marketing/components/site-header";
import { SiteFooter } from "@/features/marketing/components/site-footer";
import { ScrollFadeIn } from "@/features/marketing/components/scroll-fade-in";
import {
  ShieldCheckIcon,
  TargetIcon,
  TeamIcon,
  TrendingUpIcon,
} from "@/features/sales-management/components/icons";

const VALUES = [
  {
    icon: TargetIcon,
    title: "Customer-Focused",
    description: "Every feature starts with a real problem sales teams face, not a checklist.",
    accent: "bg-sky-50 text-sky-600",
  },
  {
    icon: TeamIcon,
    title: "Built for Teams",
    description: "Designed around how sales organizations actually work, from reps to reporting lines.",
    accent: "bg-teal-50 text-teal-600",
  },
  {
    icon: ShieldCheckIcon,
    title: "Secure by Design",
    description: "Your data stays isolated and protected, with role-based access built in from day one.",
    accent: "bg-amber-50 text-amber-600",
  },
  {
    icon: TrendingUpIcon,
    title: "Focused on Growth",
    description: "Clear pipeline visibility and reporting that help your team close more, faster.",
    accent: "bg-violet-50 text-violet-600",
  },
];

const STATS = [
  { value: "100%", label: "Tenant Data Isolation" },
  { value: "Real-Time", label: "Pipeline & Deal Visibility" },
  { value: "Role-Based", label: "Access For Every Team Member" },
  { value: "Zero", label: "Spreadsheets Required" },
];

export default function AboutPage() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <SiteHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-neutral-100">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-full bg-gradient-to-b from-sky-50 via-sky-50/60 to-white"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 right-1/2 -z-10 h-72 w-72 translate-x-1/3 rounded-full bg-sky-200/40 blur-3xl sm:h-96 sm:w-96"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-16 left-0 -z-10 h-64 w-64 -translate-x-1/4 rounded-full bg-teal-200/30 blur-3xl sm:h-80 sm:w-80"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute bottom-0 right-1/4 -z-10 h-56 w-56 rounded-full bg-violet-200/25 blur-3xl"
          />
          <div className="relative mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-20 lg:px-8">
            <span className="rounded-full bg-sky-100 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-sky-700">
              About Us
            </span>
            <h1 className="mt-5 text-4xl font-bold tracking-tight text-neutral-900 sm:text-5xl">
              About Techmatrix Sales Management
            </h1>
            <p className="mt-4 text-lg leading-relaxed text-neutral-600">
              A focused, modern sales management platform built to help teams run their
              pipeline, leads, and people in one place.
            </p>
          </div>
        </section>

        {/* Our Story */}
        <ScrollFadeIn>
          <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
            <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16">
              <div>
                <h2 className="text-3xl font-bold tracking-tight text-neutral-900">Our Story</h2>
                <p className="mt-4 text-base leading-relaxed text-neutral-600">
                  We believe sales teams do their best work when they aren&apos;t fighting their
                  own tools. Techmatrix Sales Management exists to give teams a single, reliable
                  place to manage leads, track deals, and understand how their pipeline is
                  performing — without the overhead of a bloated, generic CRM.
                </p>
                <p className="mt-4 text-base leading-relaxed text-neutral-600">
                  From lead capture to pipeline visibility to team structure, every part of the
                  platform is built around how sales organizations actually operate — so teams
                  can spend less time managing software and more time closing business.
                </p>
              </div>

              <div className="relative mx-auto w-full max-w-md">
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 -z-10 mx-auto h-[85%] w-[85%] translate-y-4 rounded-full bg-sky-100"
                />
                <div className="relative rounded-3xl bg-white p-4 shadow-lg ring-1 ring-black/5 sm:p-5">
                  <div className="relative overflow-hidden rounded-2xl">
                    <Image
                      src="/about-partnership.jpg"
                      alt="Two business partners shaking hands above their storefronts, representing a trusted business partnership"
                      width={1920}
                      height={1356}
                      className="h-auto w-full"
                    />
                    <div
                      aria-hidden
                      className="pointer-events-none absolute inset-0"
                      style={{
                        background:
                          "linear-gradient(to bottom, transparent 0%, transparent 52%, rgba(8,145,178,0.55) 68%, rgba(3,105,161,0.7) 100%)",
                        mixBlendMode: "color",
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>
        </ScrollFadeIn>

        {/* Core Values */}
        <ScrollFadeIn>
          <section className="bg-[#F0F6FF]">
            <div className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
              <div className="mx-auto max-w-2xl text-center">
                <h2 className="text-3xl font-bold tracking-tight text-neutral-900">What We Value</h2>
                <p className="mt-3 text-base text-neutral-600">
                  The principles that shape every decision we make about the platform.
                </p>
              </div>

              <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
                {VALUES.map((value) => {
                  const Icon = value.icon;
                  return (
                    <div
                      key={value.title}
                      className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-1 hover:shadow-md"
                    >
                      <div className={`flex h-11 w-11 items-center justify-center rounded-xl ${value.accent}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <h3 className="mt-4 text-base font-semibold text-neutral-900">{value.title}</h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">
                        {value.description}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </ScrollFadeIn>

        {/* Stats */}
        <ScrollFadeIn>
          <section className="bg-[#0B1F3A]">
            <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 py-16 sm:px-6 lg:grid-cols-4 lg:px-8">
              {STATS.map((stat) => (
                <div key={stat.label} className="text-center">
                  <p className="text-3xl font-bold text-white sm:text-4xl">{stat.value}</p>
                  <p className="mt-1.5 text-sm text-sky-200">{stat.label}</p>
                </div>
              ))}
            </div>
          </section>
        </ScrollFadeIn>

        {/* CTA */}
        <ScrollFadeIn>
          <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
            <div className="rounded-3xl bg-gradient-to-br from-sky-600 to-teal-500 px-6 py-14 text-center sm:px-16">
              <h2 className="text-3xl font-bold text-white">Ready to grow your sales?</h2>
              <p className="mx-auto mt-3 max-w-xl text-base text-sky-50">
                Create your account and start managing your pipeline in minutes.
              </p>
              <div className="mt-8 flex justify-center">
                <Link
                  href="/signup"
                  className="min-h-12 rounded-full bg-white px-8 py-3 text-base font-semibold text-sky-700 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                >
                  Get Started Free
                </Link>
              </div>
            </div>
          </section>
        </ScrollFadeIn>
      </main>

      <SiteFooter />
    </div>
  );
}
