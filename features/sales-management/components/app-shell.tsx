"use client";

import { useState, type ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { CloseIcon, MenuIcon } from "./icons";

type AppShellProps = {
  customerName: string;
  userEmail: string;
  userAvatarUrl: string | null;
  children: ReactNode;
};

export function AppShell({ customerName, userEmail, userAvatarUrl, children }: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-neutral-50">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-neutral-200 lg:block">
        <div className="sticky top-0 h-dvh overflow-hidden">
          <Sidebar customerName={customerName} userEmail={userEmail} userAvatarUrl={userAvatarUrl} />
        </div>
      </aside>

      {/* Mobile off-canvas sidebar — always mounted so the open/close
          transition can actually animate; visibility and interactivity
          still gate entirely on mobileNavOpen, so behavior is unchanged. */}
      <div
        className={`fixed inset-0 z-40 lg:hidden ${mobileNavOpen ? "" : "invisible"}`}
        aria-hidden={!mobileNavOpen}
      >
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
          tabIndex={mobileNavOpen ? 0 : -1}
          className={`absolute inset-0 bg-black/40 transition-opacity duration-200 ${
            mobileNavOpen ? "opacity-100" : "opacity-0"
          }`}
        />
        <div
          className={`relative z-50 h-dvh w-72 max-w-[80vw] bg-white shadow-xl transition-transform duration-200 ${
            mobileNavOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex justify-end p-2">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              aria-label="Close navigation"
              tabIndex={mobileNavOpen ? 0 : -1}
              className="rounded-lg p-2 text-neutral-500 transition-colors hover:bg-neutral-100"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
          <Sidebar
            customerName={customerName}
            userEmail={userEmail}
            userAvatarUrl={userAvatarUrl}
            onNavigate={() => setMobileNavOpen(false)}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-neutral-200 bg-white px-4 py-3 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            className="rounded-lg p-2 text-neutral-600 transition-colors hover:bg-neutral-100"
          >
            <MenuIcon className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold text-neutral-900">Techmatrix Sales Management</span>
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-10 lg:py-8">{children}</main>
      </div>
    </div>
  );
}
