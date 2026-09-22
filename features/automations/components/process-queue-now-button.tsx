"use client";

import { useState, useTransition } from "react";
import { processQueueNowAction } from "../actions";

/**
 * DEV-ONLY manual trigger for the exact same processing the cron route
 * and the opportunistic `after()` drain both run. Rendered only when
 * the automations page itself decided `NODE_ENV !== "production"` (see
 * app/(app)/automations/page.tsx) — and refused again by
 * processQueueNowAction itself if this ever rendered anywhere else.
 *
 * Exists because local `next dev` has no equivalent of Vercel Cron
 * running in the background: without this, a missed or failed
 * opportunistic drain just sits until another lead happens to nudge it,
 * with no way to retry it on demand while testing locally.
 */
export function ProcessQueueNowButton() {
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          setFeedback(null);
          startTransition(async () => {
            const result = await processQueueNowAction();
            setFeedback({
              tone: result.formError ? "error" : "success",
              text: result.formError ?? result.message ?? "Done.",
            });
          });
        }}
        className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? "Processing…" : "Process queue now (dev only)"}
      </button>
      {feedback ? (
        <p className={`max-w-xs text-xs leading-relaxed ${feedback.tone === "error" ? "text-red-600" : "text-neutral-500"}`}>
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
}
