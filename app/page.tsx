import Link from "next/link";
import { SiteHeader } from "@/features/marketing/components/site-header";
import { SiteFooter } from "@/features/marketing/components/site-footer";
import { ScrollFadeIn } from "@/features/marketing/components/scroll-fade-in";
import { LogoMarquee } from "@/features/marketing/components/logo-marquee";
import { TestimonialCarousel } from "@/features/marketing/components/testimonial-carousel";
import {
  ArrowRightIcon,
  AutomationsIcon,
  CheckIcon,
  ForecastIcon,
  LeadCaptureIcon,
  PipelineIcon,
  PlayIcon,
  TasksIcon,
  TeamIcon,
  TrendingUpIcon,
} from "@/features/sales-management/components/icons";

const FEATURES = [
  {
    icon: LeadCaptureIcon,
    title: "Lead Management",
    description:
      "Capture, qualify, and track every lead from first contact to closed deal, without losing a single detail.",
    accent: "sky",
  },
  {
    icon: PipelineIcon,
    title: "Sales Pipeline",
    description: "See exactly where every deal stands and what needs attention next, at a glance.",
    accent: "teal",
    highlighted: true,
  },
  {
    icon: TeamIcon,
    title: "Team Management",
    description: "Organize your team by role and reporting line, so everyone knows who owns what.",
    accent: "amber",
  },
  {
    icon: ForecastIcon,
    title: "Analytics & Reporting",
    description: "Track performance and forecast revenue with a clear, real-time view of your pipeline.",
    accent: "violet",
  },
  {
    icon: AutomationsIcon,
    title: "Automations",
    description: "Cut manual busywork so your team spends more time selling and less time on admin.",
    accent: "sky",
  },
  {
    icon: TasksIcon,
    title: "Tasks & Follow-ups",
    description: "Keep every follow-up on schedule with tasks tied directly to your leads and deals.",
    accent: "teal",
  },
] as const;

const ACCENTS = {
  sky: { icon: "bg-sky-50 text-sky-600", hover: "group-hover:bg-sky-600" },
  teal: { icon: "bg-teal-50 text-teal-600", hover: "group-hover:bg-teal-600" },
  amber: { icon: "bg-amber-50 text-amber-600", hover: "group-hover:bg-amber-600" },
  violet: { icon: "bg-violet-50 text-violet-600", hover: "group-hover:bg-violet-600" },
} as const;

/**
 * Honest, product-true claims rather than fabricated adoption numbers
 * (no real usage/uptime history exists yet for this pre-launch product).
 */
const STATS = [
  { value: "100%", label: "Data Isolation Between Teams" },
  { value: "Real-Time", label: "Pipeline & Deal Visibility" },
  { value: "Role-Based", label: "Access For Every Team Member" },
  { value: "Built-In", label: "Automation & Reporting" },
];

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <SiteHeader />

      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-neutral-100 bg-gradient-to-b from-sky-50 to-white">
          <div
            aria-hidden
            className="pointer-events-none absolute -top-24 -left-24 -z-10 h-72 w-72 rounded-full bg-sky-300/30 blur-3xl sm:h-96 sm:w-96"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-16 right-0 -z-10 h-72 w-72 translate-x-1/4 rounded-full bg-teal-300/25 blur-3xl sm:h-[28rem] sm:w-[28rem]"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-1/2 -z-10 h-64 w-64 -translate-x-1/2 rounded-full bg-violet-300/15 blur-3xl"
          />

          <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 py-16 sm:px-6 sm:py-20 lg:grid-cols-2 lg:px-8">
            <div className="flex flex-col items-start gap-6 text-left">
              <span className="rounded-full bg-sky-100 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-sky-700">
                Sales Management, Simplified
              </span>
              <h1 className="max-w-xl text-4xl font-bold tracking-tight text-neutral-900 sm:text-5xl lg:text-6xl">
                Power Your Sales. <span className="text-sky-600">Grow Your Business.</span>
              </h1>
              <p className="max-w-lg text-lg leading-relaxed text-neutral-600">
                Manage leads, teams, pipelines, and sales activities from one intelligent platform
                built for modern B2B sales teams.
              </p>
              <div className="flex w-full max-w-xs flex-col gap-3 sm:w-auto sm:max-w-none sm:flex-row">
                <Link
                  href="/signup"
                  className="min-h-12 rounded-full bg-sky-600 px-8 py-3 text-center text-base font-semibold text-white shadow-sm transition-colors hover:bg-sky-700"
                >
                  Start Free Trial
                </Link>
                <Link
                  href="/contact"
                  className="flex min-h-12 items-center justify-center gap-2 rounded-full border-2 border-neutral-900 px-7 py-3 text-base font-semibold text-neutral-900 transition-colors hover:bg-neutral-900 hover:text-white"
                >
                  <PlayIcon className="h-4 w-4" />
                  Watch Demo
                </Link>
              </div>
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-400">
                Secure • Enterprise-Grade • Built for Sales Teams
              </p>
            </div>

            {/* Product dashboard mockup — decorative illustration, not live data */}
            <div aria-hidden className="relative mx-auto w-full max-w-md lg:mx-0">
              <div className="rounded-3xl bg-white p-3 shadow-xl ring-1 ring-black/5">
                <div className="flex items-center gap-1.5 border-b border-neutral-100 px-3 pb-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                  <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                  <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
                  <span className="ml-2 text-xs font-medium text-neutral-400">Techmatrix — Pipeline</span>
                </div>

                <div className="grid grid-cols-3 gap-2 p-3">
                  <div className="rounded-lg bg-sky-50 p-2.5">
                    <p className="text-[10px] font-medium text-sky-700">Open Deals</p>
                    <p className="mt-0.5 text-base font-bold text-neutral-900">128</p>
                  </div>
                  <div className="rounded-lg bg-teal-50 p-2.5">
                    <p className="text-[10px] font-medium text-teal-700">Pipeline</p>
                    <p className="mt-0.5 text-base font-bold text-neutral-900">$482K</p>
                  </div>
                  <div className="rounded-lg bg-violet-50 p-2.5">
                    <p className="text-[10px] font-medium text-violet-700">Win Rate</p>
                    <p className="mt-0.5 text-base font-bold text-neutral-900">34%</p>
                  </div>
                </div>

                <div className="flex items-end gap-2 px-3 pb-1">
                  {[40, 65, 45, 80, 55, 90, 70].map((height, i) => (
                    <div key={i} className="flex-1 rounded-t bg-gradient-to-t from-sky-500 to-teal-400" style={{ height: `${height}px` }} />
                  ))}
                </div>

                <div className="mt-3 flex flex-col gap-2 border-t border-neutral-100 p-3">
                  {[
                    { name: "Acme Renewal", stage: "Qualified", color: "bg-sky-100 text-sky-700" },
                    { name: "Nimbus Upgrade", stage: "Proposal", color: "bg-amber-100 text-amber-700" },
                    { name: "Vertex Onboarding", stage: "Won", color: "bg-emerald-100 text-emerald-700" },
                  ].map((row) => (
                    <div key={row.name} className="flex items-center justify-between">
                      <span className="text-xs font-medium text-neutral-700">{row.name}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${row.color}`}>
                        {row.stage}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Floating badges — decorative, part of the same illustration */}
              <div className="absolute -top-4 -right-3 z-10 rotate-3 rounded-full bg-emerald-500 px-3 py-1.5 shadow-lg shadow-emerald-500/30 sm:-right-5">
                <span className="flex items-center gap-1 text-xs font-semibold text-white">
                  <TrendingUpIcon className="h-3.5 w-3.5" />
                  +12% this month
                </span>
              </div>

              <div className="absolute -bottom-4 -left-3 z-10 -rotate-2 rounded-xl bg-white px-3 py-2 shadow-lg ring-1 ring-black/5 sm:-left-6">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-neutral-700">
                  <span className="flex h-4 w-4 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                    <CheckIcon className="h-2.5 w-2.5" />
                  </span>
                  New Lead Added
                </span>
              </div>

              <div className="absolute -bottom-9 -right-3 z-10 rotate-2 rounded-xl bg-white px-3 py-2 shadow-lg ring-1 ring-black/5 sm:-right-6">
                <div className="flex items-center gap-2">
                  <div className="flex -space-x-2">
                    <span className="h-6 w-6 rounded-full border-2 border-white bg-sky-400" />
                    <span className="h-6 w-6 rounded-full border-2 border-white bg-teal-400" />
                    <span className="h-6 w-6 rounded-full border-2 border-white bg-violet-400" />
                  </div>
                  <span className="text-xs font-semibold text-neutral-700">+8 online</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Trusted by */}
        <LogoMarquee />

        {/* Feature highlights */}
        <ScrollFadeIn>
          <section id="features" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-2xl text-center">
              <h2 className="text-3xl font-bold tracking-tight text-neutral-900">
                Everything your sales team needs
              </h2>
              <p className="mt-3 text-base text-neutral-600">
                One platform for leads, pipeline, team, and performance — no more juggling
                spreadsheets and disconnected tools.
              </p>
            </div>

            <div className="mt-14 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => {
                const Icon = feature.icon;
                const accent = ACCENTS[feature.accent];
                const isHighlighted = "highlighted" in feature && feature.highlighted;
                return (
                  <div
                    key={feature.title}
                    className={`group relative flex flex-col rounded-2xl border p-6 transition-all duration-200 hover:-translate-y-1 hover:shadow-lg ${
                      isHighlighted ? "border-sky-300 ring-1 ring-sky-100" : "border-neutral-100 hover:border-sky-200"
                    }`}
                  >
                    {isHighlighted ? (
                      <span className="absolute -top-2.5 right-4 rounded-full bg-sky-600 px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white">
                        Most Used
                      </span>
                    ) : null}
                    <div
                      className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors group-hover:text-white ${accent.icon} ${accent.hover}`}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="mt-4 text-base font-semibold text-neutral-900">{feature.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{feature.description}</p>
                    <Link
                      href="/signup"
                      className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-sky-600 transition-colors hover:text-sky-700"
                    >
                      Learn more
                      <ArrowRightIcon className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                    </Link>
                  </div>
                );
              })}
            </div>
          </section>
        </ScrollFadeIn>

        {/* Testimonials */}
        <ScrollFadeIn>
          <section className="bg-[#F0F6FF] py-20">
            <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
              <div className="mx-auto max-w-2xl text-center">
                <h2 className="text-3xl font-bold tracking-tight text-neutral-900">
                  Sales teams that switched and never looked back
                </h2>
                <p className="mt-3 text-base text-neutral-600">
                  A look at the kind of feedback we build toward.
                </p>
              </div>

              <div className="mt-14">
                <TestimonialCarousel />
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

        {/* Final CTA */}
        <ScrollFadeIn>
          <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:px-8">
            <div className="rounded-3xl bg-gradient-to-br from-sky-600 to-teal-500 px-6 py-14 text-center sm:px-16">
              <h2 className="text-3xl font-bold text-white">Ready to grow your sales pipeline?</h2>
              <p className="mx-auto mt-3 max-w-xl text-base text-sky-50">
                Create your account and start managing your sales activities in minutes.
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
