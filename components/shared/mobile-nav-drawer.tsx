"use client";

import Link from "next/link";
import { useState } from "react";
import { Logo } from "@/components/shared/logo";
import { ChevronRightIcon, CloseIcon } from "@/features/sales-management/components/icons";

type MobileNavDrawerProps = {
  links?: { label: string; href: string }[];
};

const DEFAULT_LINKS = [
  { label: "Home", href: "/" },
  { label: "About Us", href: "/about" },
  { label: "Contact Us", href: "/contact" },
];

/**
 * Reusable nav header (hamburger + compact logo + Get Started) for the
 * auth pages (login, signup) — these pages have no full desktop nav bar
 * of their own, so this header (and its off-canvas drawer: dark overlay,
 * panel sliding in from the left, close (X) button beside the logo, link
 * rows with a chevron and a divider) is shown at every breakpoint, not
 * just mobile. Self-contained: owns its own open/close state. Defaults
 * to the same Home/About Us/Contact Us menu used by the public marketing
 * header (SiteHeader); pass `links` to override.
 */
export function MobileNavDrawer({ links = DEFAULT_LINKS }: MobileNavDrawerProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-neutral-100 bg-white px-4 py-3 sm:px-6 lg:px-12">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsOpen(true)}
            aria-label="Open menu"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black transition-opacity hover:opacity-90"
          >
            <span className="flex flex-col items-center gap-1.5">
              <span className="h-1 w-5 rounded-full bg-white" />
              <span className="h-1 w-5 rounded-full bg-white" />
              <span className="h-1 w-5 rounded-full bg-white" />
            </span>
          </button>
          <Logo iconClassName="h-8 w-auto" showText={false} />
        </div>
        <Link
          href="/signup"
          className="shrink-0 rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-sky-700 hover:shadow-md"
        >
          Get Started
        </Link>
      </header>

      <div className={`fixed inset-0 z-[999] ${isOpen ? "" : "invisible"}`} aria-hidden={!isOpen}>
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setIsOpen(false)}
          tabIndex={isOpen ? 0 : -1}
          className={`absolute inset-0 bg-black/40 transition-opacity duration-300 ease-out ${
            isOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <nav
          aria-label="Mobile"
          className={`relative z-[1000] h-full w-[280px] max-w-[80vw] overflow-y-auto bg-white shadow-xl transition-transform duration-300 ease-out ${
            isOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center gap-3 border-b border-neutral-100 px-5 py-4">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              aria-label="Close menu"
              tabIndex={isOpen ? 0 : -1}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black text-white transition-opacity hover:opacity-90"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
            <Logo iconClassName="h-8 w-auto" showText={false} />
          </div>

          <ul className="m-0 list-none p-0">
            {links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setIsOpen(false)}
                  tabIndex={isOpen ? 0 : -1}
                  className="flex items-center justify-between border-b border-neutral-100 px-5 py-[18px] text-base font-semibold text-[#0B1F3A] transition-colors hover:bg-neutral-50"
                >
                  {link.label}
                  <ChevronRightIcon className="h-5 w-5 text-neutral-400" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </>
  );
}
