import Image from "next/image";
import Link from "next/link";
import { NewsletterForm } from "./newsletter-form";
import { FacebookIcon, LinkedInIcon, TwitterIcon } from "@/features/sales-management/components/icons";

const CONTACT_EMAIL = "techmatrixsalesmanagment@gmail.com";

/**
 * href="#" links below are pages that don't exist yet (Pricing,
 * Integrations, Updates, Careers, Blog, Privacy, Terms) — placeholders
 * to wire up once those pages are built, not real destinations.
 */
const PRODUCT_LINKS = [
  { label: "Features", href: "/#features" },
  { label: "Pricing", href: "#" },
  { label: "Integrations", href: "#" },
  { label: "Updates", href: "#" },
];

const COMPANY_LINKS = [
  { label: "About Us", href: "/about" },
  { label: "Careers", href: "#" },
  { label: "Contact Us", href: "/contact" },
  { label: "Blog", href: "#" },
];

const LEGAL_LINKS = [
  { label: "Privacy", href: "#" },
  { label: "Terms", href: "#" },
];

const SOCIAL_LINKS = [
  { label: "LinkedIn", icon: LinkedInIcon, hover: "hover:text-sky-400" },
  { label: "Twitter", icon: TwitterIcon, hover: "hover:text-sky-300" },
  { label: "Facebook", icon: FacebookIcon, hover: "hover:text-indigo-400" },
];

export function SiteFooter() {
  return (
    <footer className="relative bg-[#0B1F3A]">
      <div aria-hidden className="h-[3px] w-full bg-gradient-to-r from-sky-500 to-teal-400" />

      <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 sm:gap-10 lg:grid-cols-4">
          {/* Brand */}
          <div className="sm:col-span-2 lg:col-span-1">
            <Link href="/" className="flex items-center gap-2.5">
              <div className="rounded-lg bg-white/95 p-2">
                <Image
                  src="/techmatrix-mark.png"
                  alt="Techmatrix"
                  width={122}
                  height={72}
                  className="h-9 w-auto sm:h-10"
                />
              </div>
              <span className="flex flex-col leading-none">
                <span className="text-base font-bold text-white">Techmatrix</span>
                <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-teal-300">
                  Sales Management
                </span>
              </span>
            </Link>
            <p className="mt-4 max-w-xs text-sm text-slate-300">
              The all-in-one platform for modern sales teams.
            </p>
            <div className="mt-5 flex items-center gap-3">
              {SOCIAL_LINKS.map((social) => {
                const Icon = social.icon;
                return (
                  <a
                    key={social.label}
                    href="#"
                    aria-label={social.label}
                    className={`flex h-9 w-9 items-center justify-center rounded-full bg-white/5 text-slate-300 transition-colors ${social.hover}`}
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                );
              })}
            </div>
          </div>

          {/* Product */}
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-white">Product</h3>
            <ul className="mt-4 flex flex-col gap-2.5">
              {PRODUCT_LINKS.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="inline-block py-1 text-sm text-slate-300 transition-colors hover:text-white"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Company */}
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-white">Company</h3>
            <ul className="mt-4 flex flex-col gap-2.5">
              {COMPANY_LINKS.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="inline-block py-1 text-sm text-slate-300 transition-colors hover:text-white"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Newsletter */}
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wide text-white">Stay Updated</h3>
            <p className="mt-4 text-sm text-slate-300">
              Get product news and sales tips in your inbox, occasionally.
            </p>
            <NewsletterForm />
          </div>
        </div>
      </div>

      <div className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p className="text-xs text-slate-400">
            © {new Date().getFullYear()} Techmatrix Sales Management. All rights reserved.
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {LEGAL_LINKS.map((link) => (
              <Link key={link.label} href={link.href} className="text-xs text-slate-400 transition-colors hover:text-white">
                {link.label}
              </Link>
            ))}
            <a
              href={`mailto:${CONTACT_EMAIL}`}
              className="text-xs break-all text-slate-400 transition-colors hover:text-white"
            >
              {CONTACT_EMAIL}
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
