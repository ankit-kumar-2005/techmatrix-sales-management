import type { ReactNode } from "react";

type MessageBannerProps = {
  tone: "success" | "error";
  children: ReactNode;
};

/**
 * Reusable success/error banner for auth pages — used both for inline
 * form feedback and for messages driven by a redirect's query param
 * (e.g. /login?message=password_reset).
 */
export function MessageBanner({ tone, children }: MessageBannerProps) {
  const isError = tone === "error";

  return (
    <p
      role={isError ? "alert" : "status"}
      className={`mb-5 w-full rounded-lg px-4 py-3 text-sm ring-1 ${
        isError ? "bg-red-50 text-red-700 ring-red-200" : "bg-emerald-50 text-emerald-700 ring-emerald-200"
      }`}
    >
      {children}
    </p>
  );
}
