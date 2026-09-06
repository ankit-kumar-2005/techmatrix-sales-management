"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "@/components/shared/logo";
import { CloseIcon } from "@/features/sales-management/components/icons";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About Us" },
  { href: "/contact", label: "Contact Us" },
];

/**
 * Public marketing nav — Home / About Us / Contact Us / Login / Get
 * Started, per the design brief. Every link is an existing route; this
 * component adds no new functionality, only presentation.
 */
export function SiteHeader() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    function handleScroll() {
      setIsScrolled(window.scrollY > 8);
    }
    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header
      className={`sticky top-0 z-30 bg-white/90 backdrop-blur-md transition-shadow duration-300 ${
        isScrolled ? "shadow-[0_1px_3px_rgba(0,0,0,0.06)]" : "shadow-none"
      }`}
    >
      <div
        className={`mx-auto flex max-w-6xl items-center justify-between px-4 transition-[padding] duration-300 sm:px-8 lg:px-12 ${
          isScrolled ? "py-2.5" : "py-4"
        }`}
      >
        <Logo />

        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {NAV_LINKS.map((link) => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive ? "page" : undefined}
                className={`rounded-full px-4 py-2 text-sm font-medium transition-colors duration-200 ${
                  isActive ? "bg-sky-50 text-sky-700" : "text-neutral-600 hover:bg-sky-50 hover:text-sky-700"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            href="/login"
            className="rounded-full px-4 py-2 text-sm font-semibold text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            Login
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:bg-sky-700 hover:shadow-md"
          >
            Get Started
          </Link>
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen((open) => !open)}
          aria-expanded={mobileOpen}
          aria-label={mobileOpen ? "Close menu" : "Open menu"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black transition-opacity hover:opacity-90 md:hidden"
        >
          {mobileOpen ? (
            <CloseIcon className="h-5 w-5 text-white" />
          ) : (
            <span className="flex flex-col items-center gap-1.5">
              <span className="h-1 w-5 rounded-full bg-white" />
              <span className="h-1 w-5 rounded-full bg-white" />
              <span className="h-1 w-5 rounded-full bg-white" />
            </span>
          )}
        </button>
      </div>

      <div
        className={`grid overflow-hidden bg-white transition-[grid-template-rows] duration-300 ease-out md:hidden ${
          mobileOpen ? "grid-rows-[1fr] border-t border-neutral-100" : "grid-rows-[0fr] border-t border-transparent"
        }`}
        inert={!mobileOpen}
      >
        <div className="overflow-hidden">
          <nav className="flex flex-col gap-1 px-4 pt-2" aria-label="Primary">
            {NAV_LINKS.map((link) => {
              const isActive = pathname === link.href;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  aria-current={isActive ? "page" : undefined}
                  className={`rounded-lg px-3 py-2.5 text-sm font-medium ${
                    isActive ? "bg-sky-50 text-sky-700" : "text-neutral-700 hover:bg-sky-50 hover:text-sky-700"
                  }`}
                >
                  {link.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-3 flex flex-col gap-2 border-t border-neutral-100 px-4 pt-3 pb-4">
            <Link
              href="/login"
              onClick={() => setMobileOpen(false)}
              className="min-h-11 rounded-full border border-neutral-300 px-4 py-2.5 text-center text-sm font-semibold text-neutral-700"
            >
              Login
            </Link>
            <Link
              href="/signup"
              onClick={() => setMobileOpen(false)}
              className="min-h-11 rounded-full bg-sky-600 px-4 py-2.5 text-center text-sm font-semibold text-white"
            >
              Get Started
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
