"use client";

import { useEffect, useState, useTransition } from "react";
import { Modal } from "@/components/shared/modal";
import { MessageBanner } from "@/components/shared/message-banner";
import { MailIcon, MoreVerticalIcon, PauseCircleIcon } from "@/features/sales-management/components/icons";
import { cancelInvitationAction, resendInvitationAction } from "../actions";
import type { InvitationListItem } from "../lib/get-invitations";

/** Mirrors RESEND_COOLDOWN_SECONDS in features/invitations/actions.ts.
 *  This copy drives the countdown LABEL only — the server re-reads
 *  last_sent_at from the database on every resend and refuses early
 *  ones itself, so a stale or tampered client can slow this display
 *  down but can never send sooner. */
const RESEND_COOLDOWN_SECONDS = 60;

/** Seconds still owed before this invitation may be resent, derived
 *  from the SERVER's own last_sent_at rather than a local countdown —
 *  which is what makes refreshing the browser (or opening a second tab)
 *  show the real remaining time instead of restarting it at 60. */
function secondsUntilResendAllowed(lastSentAt: string, now: number): number {
  const elapsed = (now - new Date(lastSentAt).getTime()) / 1000;
  return Math.max(0, Math.ceil(RESEND_COOLDOWN_SECONDS - elapsed));
}

type InvitationActionsMenuProps = {
  invitation: InvitationListItem;
  /** Re-fetches the current page of history after a successful action,
   *  preserving search/filter/page — the row's own status and
   *  last_sent_at both come back from the server rather than being
   *  patched in locally. */
  onChanged: () => void;
};

/**
 * Per-row actions. Same local dropdown implementation as
 * CatalogItemActionsMenu (click-outside via an invisible full-screen
 * button, role="menu", keyboard-reachable items) — reused rather than
 * rebuilt, since this project still has no shared dropdown primitive.
 *
 * Which actions exist is driven by effectiveStatus, the same value the
 * status badge shows, so the menu can never offer something the badge
 * contradicts:
 *   PENDING   -> Resend (subject to cooldown) + Cancel
 *   EXPIRED   -> Resend only. The backend's resend refreshes expires_at,
 *                which is what revives an invitation that ran out of
 *                time; cancelling one is pointless, since it already
 *                grants nothing.
 *   ACCEPTED  -> nothing. The membership it produced is managed through
 *                customer_users, not here.
 *   CANCELLED -> nothing. Terminal; invite again instead.
 * Every one of these is re-checked server-side by the actions
 * themselves — this only decides what to render.
 */
export function InvitationActionsMenu({ invitation, onChanged }: InvitationActionsMenuProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isConfirmingCancel, setIsConfirmingCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Only a CLOCK lives in state; the countdown itself is derived during
  // render from the server's last_sent_at. That ordering matters twice
  // over: the number shown is always recomputed from the server's
  // timestamp (so a backgrounded tab whose interval drifted still shows
  // the truth), and there is no setState in an effect body to get out of
  // sync with props — the same "derive during render" discipline used
  // throughout this app.
  const [now, setNow] = useState(() => Date.now());
  /** Set only when the SERVER rejects a resend as too early. Its clock
   *  wins over ours if the two disagree. */
  const [serverRetryUntil, setServerRetryUntil] = useState<number | null>(null);

  const canResend = invitation.effectiveStatus === "PENDING" || invitation.effectiveStatus === "EXPIRED";
  const canCancel = invitation.effectiveStatus === "PENDING";
  const hasActions = canResend || canCancel;

  const cooldown = Math.max(
    secondsUntilResendAllowed(invitation.last_sent_at, now),
    serverRetryUntil ? Math.max(0, Math.ceil((serverRetryUntil - now) / 1000)) : 0,
  );

  // Ticks a clock while a cooldown is actually running, then stops
  // itself. Depends on last_sent_at (stable) rather than on the derived
  // countdown, so the interval is created once per cooldown instead of
  // being torn down and rebuilt every second.
  useEffect(() => {
    if (!canResend) return;

    // Whichever runs longer: our own reading of last_sent_at, or a
    // deadline the server handed back when it refused an early resend.
    const localUntil = new Date(invitation.last_sent_at).getTime() + RESEND_COOLDOWN_SECONDS * 1000;
    const until = Math.max(localUntil, serverRetryUntil ?? 0);
    if (Date.now() >= until) return;

    const timer = setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      if (tick >= until) {
        clearInterval(timer);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, [canResend, invitation.last_sent_at, serverRetryUntil]);

  function handleResend() {
    setError(null);
    startTransition(async () => {
      const result = await resendInvitationAction(invitation.id);
      if (!result.success) {
        // Includes the server's own cooldown rejection, which carries
        // retryAfterSeconds — displayed as-is rather than second-guessed,
        // since the server's clock is the authority.
        setError(result.error ?? "Unable to resend this invitation. Please try again.");
        if (result.retryAfterSeconds) {
          const until = Date.now() + result.retryAfterSeconds * 1000;
          setServerRetryUntil(until);
          setNow(Date.now());
        }
        return;
      }
      setIsMenuOpen(false);
      onChanged();
    });
  }

  function handleCancel() {
    setError(null);
    startTransition(async () => {
      const result = await cancelInvitationAction(invitation.id);
      if (!result.success) {
        setError(result.error ?? "Unable to cancel this invitation. Please try again.");
        return;
      }
      setIsConfirmingCancel(false);
      setIsMenuOpen(false);
      onChanged();
    });
  }

  if (!hasActions) {
    // Nothing actionable — render a stable, inert placeholder so rows
    // keep the same column width instead of the table shifting per row.
    return <span className="inline-block h-8 w-8" aria-hidden="true" />;
  }

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setIsMenuOpen((open) => !open)}
        disabled={isPending}
        aria-haspopup="menu"
        aria-expanded={isMenuOpen}
        aria-label={`Actions for ${invitation.full_name}`}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 transition-colors hover:bg-neutral-200 hover:text-neutral-900 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <MoreVerticalIcon className="h-4 w-4" />
      </button>

      {isMenuOpen ? (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setIsMenuOpen(false)}
            className="fixed inset-0 z-10 cursor-default"
          />
          <div
            role="menu"
            aria-label={`Actions for ${invitation.full_name}`}
            className="absolute top-full right-0 z-20 mt-1 w-56 rounded-xl bg-white p-1.5 shadow-lg ring-1 ring-black/5"
          >
            {canResend ? (
              <button
                type="button"
                role="menuitem"
                onClick={handleResend}
                disabled={isPending || cooldown > 0}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <MailIcon className="h-4 w-4 text-neutral-400" />
                {isPending ? "Resending..." : cooldown > 0 ? `Resend in ${cooldown}s` : "Resend Invitation"}
              </button>
            ) : null}

            {canCancel ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => setIsConfirmingCancel(true)}
                disabled={isPending}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <PauseCircleIcon className="h-4 w-4 text-neutral-400" />
                Cancel Invitation
              </button>
            ) : null}

            {error ? (
              <p role="alert" className="px-3 pt-1.5 pb-1 text-xs text-red-600">
                {error}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {isConfirmingCancel ? (
        <Modal
          title="Cancel this invitation?"
          subtitle={`${invitation.full_name} will no longer be able to use their invitation link.`}
          onClose={() => setIsConfirmingCancel(false)}
        >
          <div className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-neutral-600">
              The invitation stays in your history as cancelled — nothing is deleted. You can invite{" "}
              <strong>{invitation.email}</strong> again afterwards.
            </p>

            {error ? <MessageBanner tone="error">{error}</MessageBanner> : null}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsConfirmingCancel(false)}
                disabled={isPending}
                className="min-h-11 rounded-full border border-neutral-300 px-5 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                Keep Invitation
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={isPending}
                className="min-h-11 rounded-full bg-red-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPending ? "Cancelling..." : "Confirm Cancellation"}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
