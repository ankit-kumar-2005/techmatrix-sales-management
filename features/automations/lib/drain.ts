import { processAutomationEvents, WorkerNotConfiguredError } from "./engine";

/**
 * Process the outbox opportunistically, right after the request that
 * filled it has already been answered.
 *
 * WHY THIS EXISTS RATHER THAN RELYING ON CRON ALONE. Vercel's cron
 * frequency is a function of the account's plan — on the Hobby plan the
 * minimum interval is once per DAY, which for this feature would mean a
 * lead captured at 9am gets its follow-up task tomorrow. A design whose
 * only pulse is a daily cron is not an automation product, it is a
 * nightly batch job wearing one.
 *
 * So the cron endpoint is the DURABLE BACKSTOP — it is what retries a
 * failed event, recovers a stale claim, and catches anything this path
 * missed — while this is the LOW-LATENCY PATH: the moment a lead is
 * created, the request that created it also nudges the queue. Together
 * they are correct on every plan, and neither is load-bearing on its own.
 *
 * CALLED FROM next/server's after(), ALWAYS. That is what keeps it off
 * the critical path: the webhook has already returned its 200 to the
 * source before a single line of the engine runs. This matters
 * concretely — IndiaMART deactivates an integration after sustained
 * non-200s, so lead capture must never wait on automation processing,
 * and must never fail because of it.
 *
 * NEVER THROWS. A rejected promise inside after() would surface as an
 * unhandled rejection in a request that has already succeeded, and could
 * mark a healthy deployment unhealthy. Every failure here is a log line;
 * the event is still in the outbox, still `pending`, and the cron
 * backstop will pick it up.
 */
export async function drainAutomationQueue(reason: string): Promise<void> {
  try {
    const result = await processAutomationEvents();

    if (result.claimed > 0) {
      console.log(
        `[automations] drained after ${reason}: claimed ${result.claimed}, succeeded ${result.succeeded}, ` +
          `skipped ${result.skipped}, stopped ${result.stopped}, failed ${result.failed}, ` +
          `actions ${result.actionsExecuted}.`,
      );
    }
  } catch (error) {
    if (error instanceof WorkerNotConfiguredError) {
      // The one failure worth spelling out in full: it is a setup step,
      // not a bug, and the message says exactly how to fix it.
      console.error(`[automations] ${error.message}`);
      return;
    }

    console.error(
      `[automations] opportunistic drain after ${reason} failed: ` +
        `${error instanceof Error ? error.message : "unknown error"}. ` +
        "Events remain queued and the cron backstop will retry them.",
    );
  }
}
