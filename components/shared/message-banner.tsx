import type { ReactNode } from "react";

type MessageBannerProps = {
  tone: "success" | "error" | "warning";
  children: ReactNode;
};

const TONE_CLASSES: Record<MessageBannerProps["tone"], string> = {
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  error: "bg-red-50 text-red-700 ring-red-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
};

/**
 * Reusable success/error/warning banner shared across auth and marketing
 * forms — used both for inline form feedback and for messages driven by
 * a redirect's query param (e.g. /login?message=password_reset).
 */
export function MessageBanner({ tone, children }: MessageBannerProps) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`mb-5 w-full rounded-lg px-4 py-3 text-sm ring-1 ${TONE_CLASSES[tone]}`}
    >
      {children}
    </div>
  );
}
