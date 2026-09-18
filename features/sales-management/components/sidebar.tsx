"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type SVGProps } from "react";
import {
  AutomationsIcon,
  BuildingIcon,
  CatalogIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ContactsIcon,
  ForecastIcon,
  LeadCaptureIcon,
  MeetingNotesIcon,
  PipelineIcon,
  SettingsIcon,
  TasksIcon,
  TeamIcon,
  UserPlusIcon,
} from "./icons";

type NavItem = {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Omitted for modules not built yet in this phase — rendered as a
   *  disabled row with a "Soon" badge instead of a dead link. */
  href?: string;
};

type LinkedNavItem = {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  href: string;
};

const NAV_ITEMS: NavItem[] = [
  { label: "Pipeline", icon: PipelineIcon, href: "/sales-management" },
  { label: "Lead Capture", icon: LeadCaptureIcon, href: "/lead-capture" },
  { label: "Automations", icon: AutomationsIcon },
  { label: "Catalog", icon: CatalogIcon, href: "/catalog" },
  { label: "Contacts", icon: ContactsIcon, href: "/contacts" },
  { label: "Tasks", icon: TasksIcon, href: "/tasks" },
  { label: "Team", icon: TeamIcon },
  { label: "Forecast", icon: ForecastIcon, href: "/forecast" },
  { label: "Meeting Notes", icon: MeetingNotesIcon, href: "/meeting-notes" },
];

const SETTINGS_ITEMS: LinkedNavItem[] = [
  { label: "Company Information", icon: BuildingIcon, href: "/settings/company-information" },
  { label: "Add User", icon: UserPlusIcon, href: "/settings/add-user" },
  { label: "Profile", icon: ContactsIcon, href: "/settings/profile" },
];

// collapsed is a separate arg (not folded into the class string via a
// ternary on top of the base padding classes) because Tailwind utilities
// like `px-3` and `px-0` set the same CSS property — whichever one wins
// depends on the order Tailwind emits them in its generated stylesheet,
// not the order they appear in the class attribute, so naively appending
// an override class at the end of the string is not reliable.
const navLinkClass = (isActive: boolean, collapsed: boolean) =>
  `relative flex items-center rounded-lg text-sm transition-all duration-200 focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:outline-none ${
    collapsed ? "justify-center px-0 py-2.5" : "gap-2.5 px-3 py-2"
  } ${
    isActive
      ? "bg-gradient-to-r from-blue-600 to-violet-600 font-semibold text-white shadow-lg shadow-blue-900/40"
      : "font-medium text-slate-300 hover:bg-white/10 hover:text-white"
  }`;

type SidebarProps = {
  customerName: string;
  userEmail: string;
  userAvatarUrl: string | null;
  onNavigate?: () => void;
  /** Icon-only narrow layout — driven entirely by the parent (AppShell),
   *  which owns the collapsed/expanded state and its localStorage
   *  persistence. Defaults to false so the mobile drawer's own Sidebar
   *  instance (which never passes this prop) always renders expanded,
   *  regardless of the desktop preference. */
  collapsed?: boolean;
  /** Only passed by the desktop instance in AppShell — its mere presence
   *  is what makes the collapse toggle button render at all, which is
   *  how the mobile drawer instance ends up with no toggle of its own
   *  without needing a separate "is this mobile" flag. */
  onToggleCollapse?: () => void;
};

export function Sidebar({
  customerName,
  userEmail,
  userAvatarUrl,
  onNavigate,
  collapsed = false,
  onToggleCollapse,
}: SidebarProps) {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith("/settings");
  const [settingsOpen, setSettingsOpen] = useState(isSettingsRoute);

  return (
    // h-dvh (dynamic viewport height), not h-full/h-screen — on mobile
    // browsers, 100vh includes space currently covered by the collapsing
    // address bar, so a plain vh-based height can be taller than what's
    // actually visible, pushing the pinned footer below the fold. dvh is
    // the unit built specifically to track the real visible viewport.
    // Sizing itself this way directly (rather than via h-full cascading
    // from a parent) means this component's height is correct regardless
    // of which wrapper (desktop sticky aside, mobile off-canvas drawer)
    // it's rendered inside.
    <div className="flex h-dvh flex-col bg-gradient-to-b from-slate-900 to-indigo-950">
      <div className="relative shrink-0 overflow-hidden">
        {/* Purely decorative depth glow behind the header — static, low
            opacity, clipped to this wrapper so it can never bleed into
            the scrolling nav list below or cause overflow elsewhere. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-12 -left-10 h-40 w-40 rounded-full bg-blue-600/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-8 right-0 h-32 w-32 rounded-full bg-violet-600/20 blur-3xl"
        />

        <div
          className={`relative flex ${
            collapsed ? "flex-col items-center gap-2.5 px-2 py-4" : "items-center gap-2.5 px-5 py-5"
          }`}
        >
          {/* Same asset the home page's shared Logo component uses
              (components/shared/logo.tsx) — techmatrix-mark.png, the
              cloud icon cropped down from the full wordmark, rather than
              this sidebar's own separate wordmark image. Still an opaque
              RGB PNG (no alpha channel, no image-editing tool available
              in this environment to add one), so it keeps the same
              intentional rounded white badge treatment — the crop is
              much tighter around the mark than the full wordmark was,
              so only its four corners are white now, not a whole
              rectangle. Not swapped in as the shared <Logo> component
              itself: that component hardcodes light-theme text colors
              (neutral-900/sky-600), which would be unreadable against
              this sidebar's dark gradient — the dark-theme text labels
              here stay hand-rolled. */}
          <div className="flex shrink-0 items-center justify-center rounded-xl bg-white p-2 shadow-lg shadow-black/20 ring-1 ring-white/20">
            <Image
              src="/techmatrix-mark.png"
              alt="Techmatrix"
              width={122}
              height={72}
              className="h-7 w-auto"
            />
          </div>
          {!collapsed ? (
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm font-bold text-white">Techmatrix</p>
              <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-sky-400">
                Sales Management
              </p>
            </div>
          ) : null}
          {onToggleCollapse ? (
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-slate-300 ring-1 ring-white/10 transition-all duration-200 hover:bg-white/20 hover:text-white focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:outline-none"
            >
              <ChevronLeftIcon className={`h-3.5 w-3.5 transition-transform duration-200 ${collapsed ? "rotate-180" : ""}`} />
            </button>
          ) : null}
        </div>

        {/* Soft gradient-fade divider instead of a flat solid line. */}
        <div
          aria-hidden="true"
          className="relative h-px w-full bg-gradient-to-r from-transparent via-white/10 to-transparent"
        />
      </div>

      {!collapsed ? (
        <p className="shrink-0 truncate px-5 pt-4 pb-1 text-xs font-medium text-slate-400" title={customerName}>
          {customerName}
        </p>
      ) : null}

      {/* min-h-0 is load-bearing here: a flex child with overflow-y-auto
          still won't actually scroll internally without it — by default
          it refuses to shrink below its content's height, which pushes
          the pinned footer below past the viewport instead of letting
          this list scroll on its own. The Settings group lives inside
          this same scrollable area (styled like a normal nav section,
          not a separate pinned block) — only the account row at the very
          bottom is its own pinned footer, so it can never collide with
          nav text again. */}
      <nav className="sidebar-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3" aria-label="Primary">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = item.href ? pathname === item.href : false;
            const Icon = item.icon;

            if (!item.href) {
              return (
                <li key={item.label}>
                  <span
                    title={collapsed ? `${item.label} (Soon)` : undefined}
                    aria-label={collapsed ? `${item.label} (coming soon)` : undefined}
                    className={`flex cursor-not-allowed items-center rounded-lg text-sm text-slate-500 ${
                      collapsed ? "justify-center px-0 py-2.5" : "justify-between gap-2 px-3 py-2"
                    }`}
                  >
                    <span className={`flex items-center ${collapsed ? "" : "gap-2.5"}`}>
                      <Icon className="h-4.5 w-4.5 shrink-0" />
                      {!collapsed ? item.label : null}
                    </span>
                    {!collapsed ? (
                      <span className="rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-semibold tracking-wider text-slate-300 uppercase ring-1 ring-white/10">
                        Soon
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            }

            return (
              <li key={item.label}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={isActive ? "page" : undefined}
                  title={collapsed ? item.label : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  className={navLinkClass(isActive, collapsed)}
                >
                  <Icon className="h-4.5 w-4.5 shrink-0" />
                  {!collapsed ? item.label : null}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 border-t border-white/10 pt-4">
          {!collapsed ? (
            <p className="px-3 pb-2 text-[10px] font-semibold tracking-wider text-slate-400 uppercase">Settings</p>
          ) : null}

          {!collapsed ? (
            <button
              type="button"
              onClick={() => setSettingsOpen((open) => !open)}
              aria-expanded={settingsOpen}
              aria-controls="sidebar-settings-menu"
              className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:outline-none ${
                isSettingsRoute
                  ? "bg-gradient-to-r from-blue-600 to-violet-600 text-white shadow-lg shadow-blue-900/40"
                  : "text-slate-300 hover:bg-white/10 hover:text-white"
              }`}
            >
              <SettingsIcon className="h-4.5 w-4.5 shrink-0" />
              Settings
            </button>
          ) : null}

          {/* Collapsed: no room for an indented flyout, so the Settings
              parent toggle disappears and its sub-items render directly
              as their own icon-only rows instead — still reachable,
              still consistent with the main nav's collapsed treatment,
              just flattened rather than nested. settingsOpen itself is
              untouched so the nested layout comes back exactly as it was
              once expanded again. */}
          {collapsed || settingsOpen ? (
            <div className={collapsed ? "mt-1" : "relative mt-1 ml-[1.15rem] pl-4"}>
              {!collapsed ? (
                <span className="absolute top-0 bottom-0 left-0 w-px bg-white/10" aria-hidden="true" />
              ) : null}
              <ul id="sidebar-settings-menu" className="flex flex-col gap-1">
                {SETTINGS_ITEMS.map((item) => {
                  const isActive = pathname === item.href;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={onNavigate}
                        aria-current={isActive ? "page" : undefined}
                        title={collapsed ? item.label : undefined}
                        aria-label={collapsed ? item.label : undefined}
                        className={navLinkClass(isActive, collapsed)}
                      >
                        <Icon className="h-4.5 w-4.5 shrink-0" />
                        {!collapsed ? item.label : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      </nav>

      {/* Pinned account row — its own zone, visually separated by the
          border above, so it can never overlap the Settings sub-items. */}
      <div className="shrink-0 border-t border-white/10 bg-white/5 p-3">
        <Link
          href="/settings/profile"
          onClick={onNavigate}
          title={collapsed ? userEmail : undefined}
          aria-label={collapsed ? `Account settings for ${userEmail}` : undefined}
          className={`flex items-center rounded-lg p-2 transition-colors duration-150 hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:outline-none ${
            collapsed ? "justify-center" : "gap-2.5"
          }`}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-xs font-semibold text-white">
            {userAvatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary user-uploaded Storage URL, not a build-time-known image domain
              <img src={userAvatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              userEmail.charAt(0).toUpperCase()
            )}
          </span>
          {!collapsed ? (
            <>
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">{userEmail}</span>
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden="true" />
            </>
          ) : null}
        </Link>
      </div>
    </div>
  );
}
