import Link from "next/link";
import { SiteHeader } from "@/features/marketing/components/site-header";
import { SiteFooter } from "@/features/marketing/components/site-footer";
import { ScrollFadeIn } from "@/features/marketing/components/scroll-fade-in";
import { ContactForm } from "@/features/marketing/components/contact-form";
import { ClockIcon, LocationIcon, MailIcon, PhoneIcon } from "@/features/sales-management/components/icons";

const CONTACT_EMAIL = "techmatrixsalesmanagment@gmail.com";

const CONTACT_INFO = [
  {
    icon: MailIcon,
    accent: "bg-sky-50 text-sky-600",
    label: "Email",
    value: CONTACT_EMAIL,
    href: `mailto:${CONTACT_EMAIL}`,
  },
  {
    icon: PhoneIcon,
    accent: "bg-teal-50 text-teal-600",
    label: "Phone",
    value: "Available on request",
    href: undefined,
  },
  {
    icon: LocationIcon,
    accent: "bg-amber-50 text-amber-600",
    label: "Office",
    value: "Remote-first — serving customers globally",
    href: undefined,
  },
  {
    icon: ClockIcon,
    accent: "bg-sky-50 text-sky-600",
    label: "Business Hours",
    value: "Monday – Friday, 9:00 AM – 6:00 PM",
    href: undefined,
  },
] as const;

export default function ContactPage() {
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
            className="pointer-events-none absolute -top-24 right-1/3 -z-10 h-72 w-72 rounded-full bg-sky-200/40 blur-3xl sm:h-96 sm:w-96"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -top-16 left-0 -z-10 h-64 w-64 -translate-x-1/4 rounded-full bg-teal-200/30 blur-3xl sm:h-80 sm:w-80"
          />
          <div className="relative mx-auto max-w-2xl px-4 py-16 text-center sm:px-6 sm:py-20 lg:px-8">
            <span className="rounded-full bg-sky-100 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-sky-700">
              Contact Us
            </span>
            <h1 className="mt-5 text-4xl font-bold tracking-tight text-neutral-900 sm:text-5xl">
              Let&apos;s Talk
            </h1>
            <p className="mt-4 text-lg leading-relaxed text-neutral-600">
              Have a question about Techmatrix Sales Management? We&apos;re happy to help — reach
              out any time and we&apos;ll get back to you.
            </p>
          </div>
        </section>

        {/* Form + info */}
        <ScrollFadeIn>
          <section id="contact-form" className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
            <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-[1.2fr_1fr] lg:gap-10">
              <ContactForm />

              <div className="flex flex-col gap-5">
                {CONTACT_INFO.map((info) => {
                  const Icon = info.icon;
                  const content = (
                    <>
                      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${info.accent}`}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                          {info.label}
                        </p>
                        <p className="mt-1 text-sm font-semibold break-words text-neutral-900">{info.value}</p>
                      </div>
                    </>
                  );

                  return info.href ? (
                    <a
                      key={info.label}
                      href={info.href}
                      className="flex items-start gap-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md"
                    >
                      {content}
                    </a>
                  ) : (
                    <div
                      key={info.label}
                      className="flex items-start gap-4 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5"
                    >
                      {content}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </ScrollFadeIn>

        {/* CTA strip */}
        <ScrollFadeIn>
          <section className="bg-[#F0F6FF]">
            <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 px-4 py-14 text-center sm:px-6 lg:px-8">
              <h2 className="text-2xl font-bold tracking-tight text-neutral-900">
                Prefer a live demo instead?
              </h2>
              <p className="max-w-md text-base text-neutral-600">
                Talk to our team and see Techmatrix Sales Management in action.
              </p>
              <Link
                href="#contact-form"
                className="min-h-12 rounded-full bg-sky-600 px-8 py-3 text-base font-semibold text-white shadow-sm transition-colors hover:bg-sky-700"
              >
                Book a Demo
              </Link>
            </div>
          </section>
        </ScrollFadeIn>
      </main>

      <SiteFooter />
    </div>
  );
}
