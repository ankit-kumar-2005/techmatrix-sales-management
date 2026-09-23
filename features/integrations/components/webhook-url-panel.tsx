"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  LockIcon,
  RefreshIcon,
  ShieldCheckIcon,
} from "@/features/sales-management/components/icons";
import { regenerateWebhookTokenAction } from "../actions";
import { initialIntegrationFormState } from "../form-state";
import { BRAND_NAME } from "@/lib/brand";

type WebhookUrlPanelProps = {
  integrationId: string;
  /** Built SERVER-side from APP_URL so it is the origin the source will
   *  actually be posting to, not whatever host the admin's browser
   *  happens to be on. This is the REAL, full, unmasked value — the one
   *  thing that must never itself be truncated or altered here, since
   *  Copy always sends exactly this. GENUINELY REAL for a comingSoon
   *  source too — see coming-soon-sources.ts and
   *  ensure-coming-soon-integration.ts: the row and its token exist for
   *  real, ahead of the adapter that will eventually answer on it. */
  webhookUrl: string;
  /** From the Phase 1 source-metadata registry — the ONLY place this
   *  component's copy names a vendor. */
  sourceName: string;
  /** True for JustDial/Website/Meta — a real, stored URL with nothing
   *  listening on the other end yet (no adapter, no registry entry —
   *  see coming-soon-sources.ts's own header). Everything about the URL
   *  itself (masking, Copy, Regenerate) stays fully real and identical
   *  to IndiaMART's own panel; only Test Connection short-circuits to a
   *  friendly, honest "not live yet" message instead of actually
   *  reaching out, and a "Soon" chip stays visible next to "Private" so
   *  the structurally-identical panel never reads as actually live. */
  comingSoon?: boolean;
  /** Draft setup steps for a comingSoon source, in the same voice as
   *  IndiaMART's own hardcoded steps below (reused as-is, not
   *  rewritten, from coming-soon-sources.ts). Ignored when comingSoon
   *  is false — the one real source keeps its existing richer,
   *  hand-formatted steps unchanged. */
  draftSteps?: string[];
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
 * the three actions an admin needs: copy, verify, and regenerate.
 *
 * UI-ONLY REDESIGN (state and behavior unchanged throughout): the URL
 * field and its two icon actions now live inside one bordered
 * "credential card" instead of a bare input with a pill button floating
 * beside it, and the three setup steps — same steps, same wording —
 * moved from a permanently-visible block into a "Setup guide" dialog,
 * so an admin who already knows this or isn't ready yet isn't looking
 * at a third of the card taken up by instructions. Every prop, every
 * piece of state, and every handler (handleCopy, handleTest, the
 * regenerate form action) is identical to before this pass.
 *
 * NO "SYNC NOW". A push-based source posts to us; there is no remote
 * list to pull, so a sync button would be a control that cannot do
 * anything.
 */
export function WebhookUrlPanel({
  integrationId,
  webhookUrl,
  sourceName,
  comingSoon = false,
  draftSteps,
}: WebhookUrlPanelProps) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);
  const [showGuide, setShowGuide] = useState(false);
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
    // NO REAL FETCH FOR A comingSoon SOURCE. We already know,
    // deterministically and ahead of time, that nothing is listening —
    // there is no adapter for this source, so the webhook route 404s
    // any request before it ever reaches a database call (confirmed
    // directly against that route's own code, not assumed). Reusing
    // the real fetch below would just turn that into a confusing "not
    // responding as expected (status 404)" message, which reads as
    // broken when nothing actually is. Saying so plainly, instantly,
    // and without a network round trip is the honest answer here.
    if (comingSoon) {
      setTestResult({
        ok: true,
        message: `${sourceName} isn't processing leads yet — this URL will start working the moment ${sourceName} is connected. Nothing is broken; there's just nothing listening on the other end yet.`,
      });
      return;
    }

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
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-neutral-700">Webhook Listener URL</span>
          <span className="flex items-center gap-1.5">
            {/* Stays visible in the EXPANDED state too, not just on the
                collapsed card — this panel is now structurally
                identical to IndiaMART's real one, so the one thing
                that must never be lost in that resemblance is "this
                isn't live yet." */}
            {comingSoon ? (
              <span className="inline-flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-bold tracking-wide text-neutral-500 uppercase ring-1 ring-inset ring-neutral-200">
                Soon
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-bold tracking-wide text-neutral-500 uppercase">
              <LockIcon className="h-2.5 w-2.5" aria-hidden="true" />
              Private
            </span>
          </span>
        </div>

        {/* One unified "credential card" — the field and its two actions
            grouped inside a single bordered frame instead of a bare grey
            input with a separate pill button floating beside it.
            MASKED BY DEFAULT — anyone with this URL can create leads in
            this organization, so it never shows in cleartext until an
            admin deliberately reveals it. Still a real, read-only
            <input> underneath, not a styled <code> block — it stays
            selectable, keyboard-reachable, and scrolls horizontally on a
            phone instead of forcing the card wider (the exact reason
            this was an input to begin with, unchanged). */}
        <div className="flex items-center gap-1 rounded-xl border border-neutral-200 bg-neutral-50/60 py-1 pr-1.5 pl-1 shadow-sm transition-colors focus-within:border-sky-400 focus-within:bg-white focus-within:ring-2 focus-within:ring-sky-500/20">
          <input
            type="text"
            readOnly
            value={revealed ? webhookUrl : maskWebhookUrl(webhookUrl)}
            aria-label={revealed ? "Webhook listener URL" : "Webhook listener URL, hidden"}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 bg-transparent py-1.5 pl-2.5 font-mono text-[13px] text-neutral-700 outline-none"
          />
          {/* Same reveal-toggle behavior as before — icon swap, aria-pressed —
              just repositioned inside the shared frame instead of absolutely
              positioned over the input's own edge. */}
          <button
            type="button"
            onClick={() => setRevealed((value) => !value)}
            aria-label={revealed ? "Hide webhook URL" : "Show webhook URL"}
            aria-pressed={revealed}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-200/70 hover:text-sky-600"
          >
            {revealed ? <EyeOffIcon className="h-[18px] w-[18px]" /> : <EyeIcon className="h-[18px] w-[18px]" />}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-r from-blue-600 to-violet-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 transition-all hover:from-blue-700 hover:to-violet-700"
          >
            {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <p className="text-xs text-neutral-400">
          Anyone with this link can create leads in your organization — reveal or copy it only when you need to.
        </p>
      </div>

      {/* SETUP STEPS MOVED BEHIND A CLICK, not shown permanently inline —
          the exact same three steps and wording as before (see the Modal
          below), just no longer taking up a third of this card's height
          for an admin who already knows how to do this or isn't ready
          yet. The "Setup guide" button below opens them. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-4">
        <button
          type="button"
          onClick={handleTest}
          disabled={isTesting}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-4 text-xs font-semibold text-neutral-600 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isTesting ? "Testing..." : "Test connection"}
        </button>

        <button
          type="button"
          onClick={() => setShowGuide(true)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-full px-4 text-xs font-semibold text-neutral-600 ring-1 ring-neutral-200 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
        >
          <ShieldCheckIcon className="h-3.5 w-3.5" />
          Setup guide
        </button>

        {/* Pushed to the far right and given a caution-tinted hover — the
            one genuinely destructive action of the three, visually set
            apart rather than sitting flush beside the other two. */}
        <button
          type="button"
          onClick={() => setConfirmingRegenerate(true)}
          className="ml-auto inline-flex min-h-9 items-center gap-1.5 rounded-full px-4 text-xs font-semibold text-neutral-500 ring-1 ring-neutral-200 transition-colors hover:bg-amber-50 hover:text-amber-700 hover:ring-amber-200"
        >
          <RefreshIcon className="h-3.5 w-3.5" />
          Regenerate
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
              {comingSoon ? (
                <>
                  Nothing is using this URL yet, so this is safe to do at any time — just make sure the new one is
                  what gets pasted into {sourceName} once that connection is actually built.
                </>
              ) : (
                <>
                  {sourceName} will keep posting to the old URL and those leads will be rejected until you paste the
                  new one into {sourceName}&rsquo;s Push API page. Only do this if the current URL may have been
                  exposed.
                </>
              )}
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

      {/* IndiaMART's THREE STEPS, SAME WORDING AS BEFORE — moved from a
          permanently-visible block into this dialog, opened by the
          "Setup guide" button above. Numbered as small gradient circles,
          the same small pattern already established here (no numbered-
          step component existed anywhere else in this app to reuse).
          A comingSoon source takes the OTHER branch below instead —
          draftSteps, not this hand-formatted content — so nothing about
          this real, verified copy changes for it. */}
      {showGuide && !comingSoon ? (
        <Modal
          title={`Set this up in ${sourceName}`}
          subtitle="Three steps in your seller account."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-sm shadow-blue-600/20">
              <ShieldCheckIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setShowGuide(false)}
        >
          <ol className="flex flex-col gap-4">
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
                <span className="font-semibold text-neutral-800">{BRAND_NAME} CRM</span> — and paste the URL above as
                the <span className="font-semibold text-neutral-800">Webhook Listener URL</span>.
              </p>
            </li>
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-neutral-500">
            {sourceName}&rsquo;s own test/dummy-lead tool on that page is the quickest way to confirm the
            connection — a test lead will appear under Recently captured below.
          </p>
        </Modal>
      ) : null}

      {/* A comingSoon SOURCE'S OWN DRAFT STEPS — the same best-effort
          content authored for it in coming-soon-sources.ts, reused
          verbatim rather than rewritten here. Numbered in muted grey,
          not the real gradient circles above — a quiet visual signal
          that these are a draft, not verified instructions, on top of
          the "Soon" chip and the subtitle already saying so in words. */}
      {showGuide && comingSoon && draftSteps ? (
        <Modal
          title={`Set this up in ${sourceName} — draft`}
          subtitle="A best-effort guess at what this will look like, not verified instructions."
          icon={
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200">
              <ShieldCheckIcon className="h-5 w-5" />
            </span>
          }
          onClose={() => setShowGuide(false)}
        >
          <ol className="flex flex-col gap-4">
            {draftSteps.map((step, index) => (
              <li key={step} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-300 text-[11px] font-bold text-white">
                  {index + 1}
                </span>
                <p className="pt-0.5 text-sm leading-relaxed text-neutral-600">{step}</p>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs leading-relaxed text-neutral-500">
            {sourceName} isn&rsquo;t connected yet, so none of this is actionable today — the real steps may differ
            once it actually is.
          </p>
        </Modal>
      ) : null}

      {state.formError ? <MessageBanner tone="error">{state.formError}</MessageBanner> : null}
      {state.success && state.message ? <MessageBanner tone="success">{state.message}</MessageBanner> : null}
    </div>
  );
}
