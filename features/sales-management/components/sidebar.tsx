"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type SVGProps } from "react";
import {
  AutomationsIcon,
  BuildingIcon,
  CatalogIcon,
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
  { label: "Lead Capture", icon: LeadCaptureIcon },
  { label: "Automations", icon: AutomationsIcon },
  { label: "Catalog", icon: CatalogIcon },
  { label: "Contacts", icon: ContactsIcon },
  { label: "Tasks", icon: TasksIcon },
  { label: "Team", icon: TeamIcon },
  { label: "Forecast", icon: ForecastIcon },
  { label: "Meeting Notes", icon: MeetingNotesIcon },
];

const SETTINGS_ITEMS: LinkedNavItem[] = [
  { label: "Company Information", icon: BuildingIcon, href: "/settings/company-information" },
  { label: "Add User", icon: UserPlusIcon, href: "/settings/add-user" },
  { label: "Profile", icon: ContactsIcon, href: "/settings/profile" },
];

const navLinkClass = (isActive: boolean) =>
  `relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-200 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none ${
    isActive
      ? "bg-sky-50 font-semibold text-sky-700 ring-1 ring-sky-100"
      : "font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
  }`;

type SidebarProps = {
  customerName: string;
  userEmail: string;
  userAvatarUrl: string | null;
  onNavigate?: () => void;
};

export function Sidebar({ customerName, userEmail, userAvatarUrl, onNavigate }: SidebarProps) {
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
    <div className="flex h-dvh flex-col bg-white">
      <div className="flex shrink-0 items-center gap-2.5 border-b border-neutral-100 px-5 py-5">
        <Image
          src="/techmatrix-logo.png"
          alt="Techmatrix"
          width={516}
          height={387}
          className="h-8 w-auto shrink-0"
        />
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-bold text-neutral-900">Techmatrix</p>
          <p className="truncate text-[10px] font-semibold uppercase tracking-wide text-sky-600">
            Sales Management
          </p>
        </div>
      </div>

      <p className="shrink-0 truncate px-5 pt-4 pb-1 text-xs font-medium text-neutral-400" title={customerName}>
        {customerName}
      </p>

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
                  <span className="flex cursor-not-allowed items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-neutral-400">
                    <span className="flex items-center gap-2.5">
                      <Icon className="h-4.5 w-4.5" />
                      {item.label}
                    </span>
                    <span className="rounded-full bg-neutral-100 px-2.5 py-1 text-[10px] font-semibold tracking-wider text-neutral-400 uppercase ring-1 ring-neutral-200/60">
                      Soon
                    </span>
                  </span>
                </li>
              );
            }

            return (
              <li key={item.label}>
                <Link href={item.href} onClick={onNavigate} aria-current={isActive ? "page" : undefined} className={navLinkClass(isActive)}>
                  {isActive ? (
                    <span className="absolute inset-y-1 left-0 w-1 rounded-full bg-sky-600" aria-hidden="true" />
                  ) : null}
                  <Icon className="h-4.5 w-4.5" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>

        <div className="mt-6 border-t border-neutral-100 pt-4">
          <p className="px-3 pb-2 text-[10px] font-semibold tracking-wider text-neutral-400 uppercase">Settings</p>

          <button
            type="button"
            onClick={() => setSettingsOpen((open) => !open)}
            aria-expanded={settingsOpen}
            aria-controls="sidebar-settings-menu"
            className={`relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none ${
              isSettingsRoute
                ? "bg-sky-50 text-sky-700 ring-1 ring-sky-100"
                : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
            }`}
          >
            {isSettingsRoute ? (
              <span className="absolute inset-y-1 left-0 w-1 rounded-full bg-sky-600" aria-hidden="true" />
            ) : null}
            <SettingsIcon className="h-4.5 w-4.5" />
            Settings
          </button>

          {settingsOpen ? (
            <div className="relative mt-1 ml-[1.15rem] pl-4">
              <span className="absolute top-0 bottom-0 left-0 w-px bg-neutral-200" aria-hidden="true" />
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
                        className={navLinkClass(isActive)}
                      >
                        {isActive ? (
                          <span className="absolute inset-y-1 left-0 w-1 rounded-full bg-sky-600" aria-hidden="true" />
                        ) : null}
                        <Icon className="h-4.5 w-4.5" />
                        {item.label}
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
      <div className="shrink-0 border-t border-neutral-100 p-3">
        <Link
          href="/settings/profile"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-lg p-2 transition-colors duration-150 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-neutral-900 text-xs font-semibold text-white">
            {userAvatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- arbitrary user-uploaded Storage URL, not a build-time-known image domain
              <img src={userAvatarUrl} alt="" className="h-full w-full object-cover" />
            ) : (
              userEmail.charAt(0).toUpperCase()
            )}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-600">{userEmail}</span>
          <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
