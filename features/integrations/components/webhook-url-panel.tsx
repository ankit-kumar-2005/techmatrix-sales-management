"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { MessageBanner } from "@/components/shared/message-banner";
import { CheckIcon, RefreshIcon, ShieldCheckIcon } from "@/features/sales-management/components/icons";
import { regenerateWebhookTokenAction } from "../actions";
import { initialIntegrationFormState } from "../form-state";

type WebhookUrlPanelProps = {
  integrationId: string;
  /** Built SERVER-side from APP_URL so it is the origin IndiaMART will
   *  actually be posting to, not whatever host the admin's browser
   *  happens to be on. */
  webhookUrl: string;
};

function RegenerateButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-neutral-600 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <RefreshIcon className="h-3.5 w-3.5" />
      {pending ? "Regenerating..." : "Regenerate"}
    </button>
  );
}

/**
 * The webhook URL, how to install it in IndiaMART, and the two actions
 * an admin needs: copy, and regenerate.
 *
 * NO "SYNC NOW". IndiaMART pushes to us; there is no remote list to
 * pull, so a sync button would be a control that cannot do anything.
 */
export function WebhookUrlPanel({ integrationId, webhookUrl }: WebhookUrlPanelProps) {
  const [copied, setCopied] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [state, formAction] = useActionState(regenerateWebhookTokenAction, initialIntegrationFormState);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (permissions, an insecure
      // origin, an embedded webview). The URL is already on screen and
      // selectable, so the honest move is to say so rather than to
      // pretend the copy worked.
      setTestResult("Couldn't copy automatically — select the URL above and copy it manually.");
    }
  }

  async function handleTest() {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(webhookUrl, { method: "GET" });
      setTestResult(
        res.ok
          ? "The URL is reachable and correctly formed. Send a dummy lead from IndiaMART to confirm end-to-end delivery."
          : `The URL responded with ${res.status}. Regenerate it, or check that it was pasted in full.`,
      );
    } catch {
      setTestResult("Couldn't reach the URL from this browser. Check that the app is publicly reachable.");
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-neutral-700">Webhook Listener URL</span>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* A read-only input rather than a <code> block: it is
              selectable, keyboard-reachable, and scrolls horizontally on
              a phone instead of forcing the card wider. */}
          <input
            type="text"
            readOnly
            value={webhookUrl}
            aria-label="Webhook listener URL"
            onFocus={(event) => event.currentTarget.select()}
            className="w-full min-w-0 flex-1 rounded-lg border border-transparent bg-neutral-100 px-3.5 py-2.5 font-mono text-xs text-neutral-700 outline-none focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30"
          />
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all hover:from-blue-700 hover:to-violet-700"
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : null}
            {copied ? "Copied" : "Copy Webhook URL"}
          </button>
        </div>
        <p className="text-xs text-neutral-400">
          Treat this URL as a secret. Anyone who has it can create leads in your organization.
        </p>
      </div>

      {/* SETUP STEPS INLINE, next to the URL — the admin is going to
          alt-tab to IndiaMART with this URL on the clipboard, and
          nothing is more annoying than having to go find the steps. */}
      <div className="rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
        <p className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-neutral-500 uppercase">
          <ShieldCheckIcon className="h-3.5 w-3.5" />
          Set this up in IndiaMART
        </p>
        <ol className="mt-2.5 flex list-decimal flex-col gap-1.5 pl-4 text-sm leading-relaxed text-neutral-600">
          <li>
            In your IndiaMART seller account, go to <span className="font-semibold text-neutral-800">Lead Manager</span>{" "}
            → <span className="font-semibold text-neutral-800">Import/Export Leads</span> →{" "}
            <span className="font-semibold text-neutral-800">Push API</span>.
          </li>
          <li>
            Select your CRM platform from the dropdown, or choose{" "}
            <span className="font-semibold text-neutral-800">Other</span> if it is not listed.
          </li>
          <li>
            Enter a platform name — for example{" "}
            <span className="font-semibold text-neutral-800">TechMatrix CRM</span> — and paste the URL above as the{" "}
            <span className="font-semibold text-neutral-800">Webhook Listener URL</span>.
          </li>
        </ol>
        <p className="mt-2.5 text-xs text-neutral-500">
          IndiaMART&rsquo;s own test/dummy-lead tool on that page is the quickest way to confirm the connection — a
          test lead will appear under Recently Captured below.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={isTesting}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-neutral-600 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isTesting ? "Testing..." : "Test Connection"}
        </button>

        {confirmingRegenerate ? null : (
          <button
            type="button"
            onClick={() => setConfirmingRegenerate(true)}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-neutral-600 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
          >
            <RefreshIcon className="h-3.5 w-3.5" />
            Regenerate URL
          </button>
        )}
      </div>

      {/* REGENERATION IS DESTRUCTIVE and asks first, in words that say
          what actually breaks. It is not a dialog because this panel is
          already the full-width config surface — an inline confirm keeps
          the URL it is about to invalidate visible above it. */}
      {confirmingRegenerate ? (
        <form action={formAction} className="rounded-xl bg-amber-50 p-4 ring-1 ring-amber-100">
          <input type="hidden" name="integration_id" value={integrationId} />
          <p className="text-sm font-semibold text-amber-900">Regenerate the webhook URL?</p>
          <p className="mt-1 text-sm leading-relaxed text-amber-800">
            The current URL stops working immediately. IndiaMART will keep posting to it and those leads will be
            rejected until you paste the new URL into the Push API page. Only do this if the current URL may have
            been exposed.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <RegenerateButton />
            <button
              type="button"
              onClick={() => setConfirmingRegenerate(false)}
              className="inline-flex min-h-10 items-center rounded-full px-4 text-sm font-semibold text-amber-900 transition-colors hover:bg-amber-100"
            >
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}
      {state.success && state.message ? <MessageBanner tone="success">{state.message}</MessageBanner> : null}
      {testResult ? <p className="text-sm text-neutral-600">{testResult}</p> : null}
    </div>
  );
}
