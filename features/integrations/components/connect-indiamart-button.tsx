"use client";

import { useState, useTransition } from "react";
import { MessageBanner } from "@/components/shared/message-banner";
import { connectIndiamartAction } from "../actions";

type ConnectIndiamartButtonProps = {
  /** From the Phase 1 source-metadata registry — the label is the only
   *  thing about this button that varies by source. The ACTION it
   *  calls is still IndiaMART-specific (connectIndiamartAction), which
   *  is a deliberately separate, larger, still-deferred piece of work —
   *  see source-metadata.ts's own note on what a generic connect
   *  action would need. */
  sourceName: string;
};

/**
 * Creating the integration is an explicit act, because it mints a live
 * webhook token — a tenant that has never set this up should not end up
 * with a working ingest URL just because somebody opened this page.
 *
 * A BUTTON AND useTransition, not a <form> and useActionState. This
 * operation has no inputs at all: everything it needs (customer_id,
 * the caller's role) is derived server-side from the session, and the
 * token comes from a column default. A form would mean an action with
 * (prevState, formData) parameters that are both ignored, which this
 * project's eslint config correctly flags as unused — the ceremony was
 * buying nothing.
 */
export function ConnectIndiamartButton({ sourceName }: ConnectIndiamartButtonProps) {
  const [isPending, startTransition] = useTransition();
  const [formError, setFormError] = useState<string | null>(null);

  function handleConnect() {
    setFormError(null);
    startTransition(async () => {
      const result = await connectIndiamartAction();
      // On success the action revalidates /lead-capture, so this
      // component is replaced by the configured panels — there is no
      // success state to render here.
      if (result.formError) {
        setFormError(result.formError);
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        onClick={handleConnect}
        disabled={isPending}
        className="min-h-11 self-start rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isPending ? "Connecting..." : `Connect ${sourceName}`}
      </button>
      {formError ? <MessageBanner tone="error">{formError}</MessageBanner> : null}
    </div>
  );
}
