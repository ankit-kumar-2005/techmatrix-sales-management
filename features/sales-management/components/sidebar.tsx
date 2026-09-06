"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type SVGProps } from "react";
import {
  AutomationsIcon,
  CatalogIcon,
  ContactsIcon,
  ForecastIcon,
  LeadCaptureIcon,
  MeetingNotesIcon,
  PipelineIcon,
  SettingsIcon,
  TasksIcon,
  TeamIcon,
} from "./icons";

type NavItem = {
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Omitted for modules not built yet in this phase — rendered as a
   *  disabled row with a "Soon" badge instead of a dead link. */
  href?: string;
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

const SETTINGS_ITEMS = [
  { label: "Company Information", href: "/settings/company-information" },
  { label: "Add User", href: "/settings/add-user" },
  { label: "Profile", href: "/settings/profile" },
];

type SidebarProps = {
  customerName: string;
  onNavigate?: () => void;
};

export function Sidebar({ customerName, onNavigate }: SidebarProps) {
  const pathname = usePathname();
  const isSettingsRoute = pathname.startsWith("/settings");
  const [settingsOpen, setSettingsOpen] = useState(isSettingsRoute);

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center gap-2.5 border-b border-neutral-100 px-5 py-5">
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

      <p className="truncate px-5 pt-4 text-xs font-medium text-neutral-400" title={customerName}>
        {customerName}
      </p>

      <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Primary">
        <ul className="flex flex-col gap-1">
          {NAV_ITEMS.map((item) => {
            const isActive = item.href ? pathname === item.href : false;
            const Icon = item.icon;

            if (!item.href) {
              return (
                <li key={item.label}>
                  <span className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm text-neutral-400">
                    <span className="flex items-center gap-2.5">
                      <Icon className="h-4.5 w-4.5" />
                      {item.label}
                    </span>
                    <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                      Soon
                    </span>
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
                  className={`relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                    isActive
                      ? "bg-sky-50 font-semibold text-sky-700"
                      : "font-medium text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
                  }`}
                >
                  {isActive ? (
                    <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-sky-600" aria-hidden="true" />
                  ) : null}
                  <Icon className="h-4.5 w-4.5" />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-neutral-100 px-3 py-4">
        <button
          type="button"
          onClick={() => setSettingsOpen((open) => !open)}
          aria-expanded={settingsOpen}
          aria-controls="sidebar-settings-menu"
          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
            isSettingsRoute
              ? "bg-sky-50 text-sky-700"
              : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900"
          }`}
        >
          <SettingsIcon className="h-4.5 w-4.5" />
          Settings
        </button>

        {settingsOpen ? (
          <ul id="sidebar-settings-menu" className="mt-1 flex flex-col gap-1 pl-9">
            {SETTINGS_ITEMS.map((item) => {
              const isActive = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={isActive ? "page" : undefined}
                    className={`block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                      isActive ? "font-semibold text-sky-700" : "text-neutral-500 hover:text-neutral-900"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
