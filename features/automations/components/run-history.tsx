import { formatRelativeTime } from "@/utils/format";
import type { AutomationRunListItem, AutomationRunStatus } from "@/types/automation";

type RunHistoryProps = {
  runs: AutomationRunListItem[];
  nowMs: number;
  /** Hide the automation name when the list is already scoped to one. */
  showAutomationName?: boolean;
  queue?: { pending: number; dead: number };
};

const STATUS_STYLE: Record<AutomationRunStatus, { label: string; dot: string; text: string }> = {
  succeeded: { label: "Ran", dot: "bg-teal-500", text: "text-teal-700" },
  skipped: { label: "Skipped", dot: "bg-neutral-400", text: "text-neutral-500" },
  failed: { label: "Failed", dot: "bg-red-500", text: "text-red-700" },
  stopped_by_safeguard: { label: "Stopped", dot: "bg-amber-500", text: "text-amber-700" },
};

/**
 * Execution history.
 *
 * EVERY OUTCOME APPEARS HERE, not just the failures — a skip and a
 * safeguard stop are recorded as deliberately as a success, and each
 * carries the specific reason it happened. That is the whole point of
 * this surface: this feature acts when nobody is watching, so the only
 * way an admin can trust it is if it can always account for itself,
 * including for the times it decided to do nothing.
 */
export function RunHistory({ runs, nowMs, showAutomationName = true, queue }: RunHistoryProps) {
  return (
    <div className="flex flex-col gap-3">
      {queue && (queue.pending > 0 || queue.dead > 0) ? (
        <div className="flex flex-wrap gap-4 rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5">
          {queue.pending > 0 ? (
            <p className="text-xs text-neutral-600">
              <span className="font-bold text-neutral-900">{queue.pending}</span> waiting to be processed
            </p>
          ) : null}
          {queue.dead > 0 ? (
            <p className="text-xs text-amber-700">
              <span className="font-bold">{queue.dead}</span> gave up after repeated failures
            </p>
          ) : null}
        </div>
      ) : null}

      {runs.length === 0 ? (
        <div className="rounded-2xl bg-white px-4 py-10 text-center shadow-sm ring-1 ring-black/5">
          <p className="text-sm text-neutral-500">
            Nothing has run yet. Once an automation is switched on, every run it makes shows up here.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-neutral-100 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          {runs.map((run) => {
            const style = STATUS_STYLE[run.status];
            // stop_reason for a skip or a safeguard stop, error_detail
            // for a failure — never both, and never neither for the two
            // statuses that are meaningless without one.
            const reason = run.stop_reason ?? run.error_detail;

            return (
              <li key={run.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-1.5 text-sm">
                    <span className={`font-semibold ${style.text}`}>{style.label}</span>
                    {showAutomationName ? (
                      <span className="truncate font-semibold text-neutral-900">{run.automation_name}</span>
                    ) : null}
                    <span className="text-xs text-neutral-400">v{run.version}</span>
                    {run.actions_executed > 0 ? (
                      <span className="text-xs text-neutral-500">
                        · {run.actions_executed} action{run.actions_executed === 1 ? "" : "s"}
                      </span>
                    ) : null}
                  </p>
                  {reason ? <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">{reason}</p> : null}
                </div>
                <span className="shrink-0 text-xs text-neutral-400">
                  {formatRelativeTime(run.started_at, nowMs)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
