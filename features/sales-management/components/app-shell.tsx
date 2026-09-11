"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { NavigationProgress } from "@/components/shared/navigation-progress";
import { CloseIcon, MenuIcon } from "./icons";

type AppShellProps = {
  customerName: string;
  userEmail: string;
  userAvatarUrl: string | null;
  children: ReactNode;
};

/** Desktop-only sidebar collapse preference — a per-viewer UI nicety,
 *  not app data, so localStorage is the right (and simplest) place for
 *  it rather than a DB column or cookie. Read back in an effect (not
 *  during the initial render) since localStorage doesn't exist during
 *  SSR: the first paint always assumes expanded, then flips to the
 *  stored value once mounted — the same trade-off every localStorage-
 *  backed UI preference in a server-rendered app makes. */
const SIDEBAR_COLLAPSED_STORAGE_KEY = "techmatrix-sidebar-collapsed";

export function AppShell({ customerName, userEmail, userAvatarUrl, children }: AppShellProps) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      const storedCollapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- window/localStorage don't exist during SSR, so this one-time sync of a persisted UI preference on mount is the standard hydration-safe pattern here, not a perf concern for a single boolean
      setCollapsed(storedCollapsed);
    } catch {
      // localStorage can throw in some browser configurations (private
      // mode, disabled storage) — expanded-by-default is a fine fallback.
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((wasCollapsed) => {
      const nextCollapsed = !wasCollapsed;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(nextCollapsed));
      } catch {
        // Preference just won't persist across reloads — not worth
        // surfacing an error for a non-critical UI nicety.
      }
      return nextCollapsed;
    });
  }

  return (
    <div className="flex min-h-screen bg-neutral-50">
      {/* Desktop sidebar. Only this instance gets collapsed/onToggleCollapse
          — the mobile drawer instance below never receives them, so it
          always renders expanded and never shows the collapse toggle,
          regardless of this desktop preference. */}
      <aside
        className={`hidden shrink-0 border-r border-neutral-200 transition-[width] duration-200 ease-in-out lg:block ${
          collapsed ? "w-[72px]" : "w-64"
        }`}
      >
        <div className="sticky top-0 h-dvh overflow-hidden">
          <Sidebar
            customerName={customerName}
            userEmail={userEmail}
            userAvatarUrl={userAvatarUrl}
            collapsed={collapsed}
            onToggleCollapse={toggleCollapsed}
          />
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
          className={`relative z-50 h-dvh w-72 max-w-[80vw] bg-slate-900 shadow-xl transition-transform duration-200 ${
            mobileNavOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex justify-end p-2">
            <button
              type="button"
              onClick={() => setMobileNavOpen(false)}
              aria-label="Close navigation"
              tabIndex={mobileNavOpen ? 0 : -1}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
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
        {/* First child of the content column, so the bar spans exactly
            this column — starting at the sidebar's right edge on desktop
            (either collapse width) and going full-width below `lg`, where
            the <aside> is `hidden` and this column is the whole viewport.
            Suspense because NavigationProgress reads useSearchParams(). */}
        <Suspense fallback={null}>
          <NavigationProgress />
        </Suspense>

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
