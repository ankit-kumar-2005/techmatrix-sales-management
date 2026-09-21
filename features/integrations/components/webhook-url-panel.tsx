"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import {
  CheckIcon,
  CloseIcon,
  EyeIcon,
  EyeOffIcon,
  RefreshIcon,
  ShieldCheckIcon,
} from "@/features/sales-management/components/icons";
import { regenerateWebhookTokenAction } from "../actions";
import { initialIntegrationFormState } from "../form-state";

type WebhookUrlPanelProps = {
  integrationId: string;
  /** Built SERVER-side from APP_URL so it is the origin the source will
   *  actually be posting to, not whatever host the admin's browser
   *  happens to be on. This is the REAL, full, unmasked value — the one
   *  thing that must never itself be truncated or altered here, since
   *  Copy always sends exactly this. */
  webhookUrl: string;
  /** From the Phase 1 source-metadata registry — the ONLY place this
   *  component's copy names a vendor. */
  sourceName: string;
};

const MASK_CHAR = "•";
const MASK_LENGTH = 12;
const VISIBLE_TAIL_LENGTH = 4;

/**
 * The masked display form of the webhook URL — path context plus a
 * FIXED-length run of bullets plus the token's last 4 characters.
 *
 * FIXED length, not one-bullet-per-actual-character: a proportional
 * mask would leak the token's real length (64 hex characters, by
 * construction — see the migration), which is itself information a
 * masked value shouldn't hand out. A constant-width mask reveals
 * nothing but "there is a token here."
 *
 * Kept to the last two path segments before the token (e.g.
 * "leads/IndiaMART") rather than the whole path — enough to recognize
 * which webhook this is without the display crowding the reveal/copy
 * controls at narrow widths.
 */
function maskWebhookUrl(url: string): string {
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/").filter(Boolean);
  } catch {
    return url;
  }
  const token = segments.at(-1) ?? "";
  const visiblePath = segments.slice(-3, -1).join("/");
  const tail = token.slice(-VISIBLE_TAIL_LENGTH);
  return `.../${visiblePath}/${MASK_CHAR.repeat(MASK_LENGTH)}${tail}`;
}

function RegenerateButton() {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Regenerating..." : "Regenerate URL"}
    </button>
  );
}

/** Test Connection's inline result — a pass/fail STATE, not just a
 *  string, so the message can carry its own icon and color instead of
 *  reading as an undifferentiated line of gray text (see Phase 4's
 *  "clear, immediate pass/fail state, not just a silent request"). */
type TestOutcome = { ok: boolean; message: string };

/**
 * The webhook URL, how to install it in a source's own dashboard, and
 * the two actions an admin needs: copy, and regenerate.
 *
 * NO "SYNC NOW". A push-based source posts to us; there is no remote
 * list to pull, so a sync button would be a control that cannot do
 * anything.
 */
export function WebhookUrlPanel({ integrationId, webhookUrl, sourceName }: WebhookUrlPanelProps) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [testResult, setTestResult] = useState<TestOutcome | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [state, formAction] = useActionState(regenerateWebhookTokenAction, initialIntegrationFormState);

  async function handleCopy() {
    try {
      // Always the real prop — never the masked display value, and
      // never conditioned on `revealed`. Copy must work identically
      // whether or not the admin has ever clicked the eye toggle.
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access can be refused (permissions, an insecure
      // origin, an embedded webview). The URL is already on screen and
      // selectable once revealed, so the honest move is to say so
      // rather than to pretend the copy worked.
      setTestResult({ ok: false, message: "Couldn't copy automatically — reveal the URL above and copy it manually." });
    }
  }

  async function handleTest() {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(webhookUrl, { method: "GET" });
      setTestResult(
        res.ok
          ? {
              ok: true,
              message: `This URL is reachable and ready. Send a dummy lead from ${sourceName} to confirm everything arrives correctly.`,
            }
          : {
              ok: false,
              message: `This URL isn't responding as expected (status ${res.status}). Try regenerating it, or double-check it was pasted in full.`,
            },
      );
    } catch {
      setTestResult({
        ok: false,
        message:
          "Couldn't reach this URL from your browser. If you're testing locally, this check won't work until the app is deployed publicly.",
      });
    } finally {
      setIsTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-neutral-700">Webhook Listener URL</span>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* MASKED BY DEFAULT — this is the fix for the panel
              previously saying "treat this as a secret" directly above
              the secret shown in full cleartext. A read-only input
              rather than a <code> block: it stays selectable, keyboard-
              reachable, and scrolls horizontally on a phone instead of
              forcing the card wider. */}
          <div className="relative min-w-0 flex-1">
            <input
              type="text"
              readOnly
              value={revealed ? webhookUrl : maskWebhookUrl(webhookUrl)}
              aria-label={revealed ? "Webhook listener URL" : "Webhook listener URL, hidden"}
              onFocus={(event) => event.currentTarget.select()}
              className="w-full rounded-lg border border-transparent bg-neutral-100 py-2.5 pr-10 pl-3.5 font-mono text-xs text-neutral-700 outline-none focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30"
            />
            {/* Same reveal-toggle visual language as PasswordField —
                absolutely positioned inside the field's right edge, eye/
                eye-off swap, identical hover color. */}
            <button
              type="button"
              onClick={() => setRevealed((value) => !value)}
              aria-label={revealed ? "Hide webhook URL" : "Show webhook URL"}
              aria-pressed={revealed}
              className="absolute inset-y-0 right-0 flex items-center rounded-r-lg px-3 text-neutral-400 transition-colors hover:text-sky-600"
            >
              {revealed ? <EyeOffIcon className="h-[18px] w-[18px]" /> : <EyeIcon className="h-[18px] w-[18px]" />}
            </button>
          </div>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-4 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all hover:from-blue-700 hover:to-violet-700"
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : null}
            {copied ? "Copied" : "Copy URL"}
          </button>
        </div>
        <p className="text-xs text-neutral-400">
          This URL is hidden by default because anyone who has it can create leads in your organization. Reveal it
          only when you need to check or copy it.
        </p>
      </div>

      {/* SETUP STEPS INLINE, next to the URL — the admin is going to
          alt-tab to the source's own dashboard with this URL on the
          clipboard, and nothing is more annoying than having to go find
          the steps. Numbered as small gradient circles rather than the
          browser's default list markers — no numbered-step component
          existed anywhere else in this app to reuse (checked), so this
          is a new, small pattern built entirely from primitives already
          used elsewhere (the same gradient every badge/button in this
          app already uses, at a smaller size). */}
      <div className="rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
        <p className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-neutral-500 uppercase">
          <ShieldCheckIcon className="h-3.5 w-3.5" />
          Set this up in {sourceName}
        </p>
        <ol className="mt-3 flex flex-col gap-3">
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-[11px] font-bold text-white shadow-sm shadow-blue-600/20">
              1
            </span>
            <p className="pt-0.5 text-sm leading-relaxed text-neutral-600">
              In your {sourceName} seller account, go to{" "}
              <span className="font-semibold text-neutral-800">Lead Manager</span> →{" "}
              <span className="font-semibold text-neutral-800">Import/Export Leads</span> →{" "}
              <span className="font-semibold text-neutral-800">Push API</span>.
            </p>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-[11px] font-bold text-white shadow-sm shadow-blue-600/20">
              2
            </span>
            <p className="pt-0.5 text-sm leading-relaxed text-neutral-600">
              Select your CRM platform from the dropdown, or choose{" "}
              <span className="font-semibold text-neutral-800">Other</span> if it is not listed.
            </p>
          </li>
          <li className="flex gap-3">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-[11px] font-bold text-white shadow-sm shadow-blue-600/20">
              3
            </span>
            <p className="pt-0.5 text-sm leading-relaxed text-neutral-600">
              Enter a platform name — for example{" "}
              <span className="font-semibold text-neutral-800">TechMatrix CRM</span> — and paste the URL above as
              the <span className="font-semibold text-neutral-800">Webhook Listener URL</span>.
            </p>
          </li>
        </ol>
        <p className="mt-3 text-xs text-neutral-500">
          {sourceName}&rsquo;s own test/dummy-lead tool on that page is the quickest way to confirm the connection —
          a test lead will appear under Recently captured below.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleTest}
          disabled={isTesting}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-neutral-600 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isTesting ? "Testing..." : "Test connection"}
        </button>

        <button
          type="button"
          onClick={() => setConfirmingRegenerate(true)}
          className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-neutral-600 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
        >
          <RefreshIcon className="h-3.5 w-3.5" />
          Regenerate URL
        </button>
      </div>

      {/* A CLEAR, IMMEDIATE PASS/FAIL STATE, not a plain line of gray
          text — the same small icon-chip-plus-message shape this app
          already uses for "Task created" and similar inline
          confirmations, reused here rather than invented fresh. */}
      {testResult ? (
        <p
          className={`flex items-start gap-1.5 text-sm ${testResult.ok ? "text-emerald-700" : "text-amber-700"}`}
        >
          <span
            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
              testResult.ok ? "bg-emerald-100" : "bg-amber-100"
            }`}
          >
            {testResult.ok ? <CheckIcon className="h-2.5 w-2.5" /> : <CloseIcon className="h-2.5 w-2.5" />}
          </span>
          {testResult.message}
        </p>
      ) : null}

      {/* A REAL DIALOG, not a raw browser confirm() and no longer an
          inline amber box either — regeneration is destructive enough
          (it breaks a URL already pasted into a third party's
          dashboard) to deserve the same focus-trapped, Escape-to-close
          treatment every other confirmation surface in this app uses. */}
      {confirmingRegenerate ? (
        <Modal
          title="Regenerate the webhook URL?"
          subtitle="The current URL stops working immediately."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-amber-100">
              <RefreshIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setConfirmingRegenerate(false)}
        >
          <form action={formAction} className="flex flex-col gap-4">
            <input type="hidden" name="integration_id" value={integrationId} />
            <p className="text-sm leading-relaxed text-neutral-600">
              {sourceName} will keep posting to the old URL and those leads will be rejected until you paste the new
              one into {sourceName}&rsquo;s Push API page. Only do this if the current URL may have been exposed.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmingRegenerate(false)}
                className="min-h-10 rounded-full px-4 text-sm font-semibold text-neutral-600 transition-colors hover:bg-neutral-100"
              >
                Cancel
              </button>
              <RegenerateButton />
            </div>
          </form>
        </Modal>
      ) : null}

      {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}
      {state.success && state.message ? <MessageBanner tone="success">{state.message}</MessageBanner> : null}
    </div>
  );
}
