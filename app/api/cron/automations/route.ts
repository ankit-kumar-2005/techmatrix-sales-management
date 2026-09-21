import { NextResponse } from "next/server";
import { processAutomationEvents, WorkerNotConfiguredError } from "@/features/automations/lib/engine";

/**
 * GET /api/cron/automations — the durable backstop for the automation
 * outbox.
 *
 * WHAT IT IS FOR, given that features/automations/lib/drain.ts already
 * processes the queue the moment a lead is created: retries of events
 * that failed, recovery of claims left behind by a worker that died
 * mid-run, and anything the opportunistic path missed because the
 * process ended first. Those three cases have no request of their own to
 * ride on, so they need a clock.
 *
 * SCHEDULING, AND AN HONEST LIMITATION. This repository is not linked to
 * a Vercel project (no .vercel directory, APP_URL still points at
 * localhost), so the account's plan could not be inspected and no
 * assumption has been made about it. Vercel's cron minimum interval is
 * once per DAY on Hobby and once per MINUTE on Pro. vercel.json
 * therefore ships with a daily schedule, which is the only value that
 * deploys successfully on every plan — and the feature does not depend
 * on it for latency, because the opportunistic drain is what makes a
 * task appear seconds after a lead arrives. On Pro, change that schedule
 * to `* * * * *`; retries then happen within a minute instead of within
 * a day. Any external scheduler that can issue an authenticated GET
 * works equally well and is the right answer if this is not deployed on
 * Vercel at all.
 *
 * GET, not POST, because that is what Vercel Cron issues.
 */

export const dynamic = "force-dynamic";
// Bounded by EVENT_BATCH_SIZE rather than by this number; raised from
// the 15s default so a full batch of slow RPCs still finishes inside one
// invocation rather than leaving claims for stale recovery to clean up.
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;

  if (secret) {
    // Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
    // automatically. Any external scheduler must send the same header.
    if (request.headers.get("authorization") !== `Bearer ${secret}`) {
      return NextResponse.json({ status: "not_found" }, { status: 404 });
    }
  } else if (process.env.NODE_ENV === "production") {
    // FAIL CLOSED. Without the secret this endpoint would be an
    // unauthenticated trigger for the whole queue — not a data leak (it
    // returns counts only, and every underlying function is separately
    // token-gated), but an open invitation to force work. Refusing is
    // safe: events stay queued, and the opportunistic drain keeps
    // running regardless.
    console.error(
      "[automations] CRON_SECRET is not set. The cron endpoint refuses to run in production without it.",
    );
    return NextResponse.json({ status: "not_configured" }, { status: 503 });
  }

  try {
    const result = await processAutomationEvents();

    if (result.claimed > 0) {
      console.log(
        `[automations] cron: claimed ${result.claimed}, succeeded ${result.succeeded}, ` +
          `skipped ${result.skipped}, stopped ${result.stopped}, failed ${result.failed}, ` +
          `actions ${result.actionsExecuted}.`,
      );
    }

    // Counts only. No tenant id, no lead, no automation name — this
    // response is readable by whoever holds the secret, and it never
    // needs to carry a customer's data to do its job.
    return NextResponse.json({
      status: "ok",
      claimed: result.claimed,
      succeeded: result.succeeded,
      skipped: result.skipped,
      stopped: result.stopped,
      failed: result.failed,
      actions: result.actionsExecuted,
    });
  } catch (error) {
    if (error instanceof WorkerNotConfiguredError) {
      console.error(`[automations] ${error.message}`);
      return NextResponse.json({ status: "not_configured" }, { status: 503 });
    }

    console.error(
      `[automations] cron run failed: ${error instanceof Error ? error.message : "unknown error"}.`,
    );
    // 500 on purpose: a cron target that keeps failing should be visibly
    // failing in the platform's own dashboard, not quietly returning 200.
    return NextResponse.json({ status: "error" }, { status: 500 });
  }
}
