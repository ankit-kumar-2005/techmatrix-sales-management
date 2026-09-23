import { formatRelativeTime } from "@/utils/format";
import { ProcessQueueNowButton } from "./process-queue-now-button";
import {
  AlertTriangleIcon,
  CheckIcon,
  CloseIcon,
  MinusCircleIcon,
} from "@/features/sales-management/components/icons";
import type { AutomationRunListItem, AutomationRunStatus } from "@/types/automation";

type RunHistoryProps = {
  /** This section's own heading — read by this component, not a
   *  sibling <h2> above it, so the queue/dev-tools toolbar can sit in
   *  the same header row rather than as its own separate box. Two
   *  different callers, two different headings ("Execution history"
   *  on the list page, "This automation's runs" on the detail page). */
  title: string;
  runs: AutomationRunListItem[];
  nowMs: number;
  /** Hide the automation name when the list is already scoped to one. */
  showAutomationName?: boolean;
  queue?: { pending: number; dead: number };
  /** Set by the page from `NODE_ENV`, never guessed here — shows the
   *  dev-only manual "process now" trigger. See ProcessQueueNowButton
   *  for why this exists: local `next dev` has no cron equivalent. */
  devMode?: boolean;
};

/**
 * Each real status gets its own icon AND color, not just a tinted dot —
 * shape carries the distinction now, not hue alone (so it still reads
 * for a colorblind admin, and so "Skipped" and "Stopped" can never be
 * mistaken for shades of the same thing at a glance). stoppedBySafeguard
 * is deliberately the odd one out: a bigger icon and a ring, because a
 * safety limit actually firing is a real event worth a second look, not
 * routine the way a skip is.
 */
const STATUS_STYLE: Record<
  AutomationRunStatus,
  { label: string; icon: typeof CheckIcon; chip: string; text: string; emphasize?: boolean }
> = {
  succeeded: { label: "Ran", icon: CheckIcon, chip: "bg-teal-50 text-teal-600", text: "text-teal-700" },
  skipped: { label: "Skipped", icon: MinusCircleIcon, chip: "bg-neutral-100 text-neutral-400", text: "text-neutral-500" },
  failed: { label: "Failed", icon: CloseIcon, chip: "bg-red-50 text-red-600", text: "text-red-700" },
  stopped_by_safeguard: {
    label: "Stopped — safety limit",
    icon: AlertTriangleIcon,
    chip: "bg-amber-50 text-amber-600 ring-2 ring-amber-200",
    text: "text-amber-700",
    emphasize: true,
  },
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
export function RunHistory({ title, runs, nowMs, showAutomationName = true, queue, devMode = false }: RunHistoryProps) {
  const hasToolbar = Boolean((queue && (queue.pending > 0 || queue.dead > 0)) || devMode);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">{title}</h2>
        {hasToolbar ? (
          <div className="flex flex-wrap items-center gap-2">
            {queue && queue.pending > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-semibold text-neutral-600 ring-1 ring-inset ring-neutral-200">
                <span className="font-bold text-neutral-900">{queue.pending}</span> waiting
              </span>
            ) : null}
            {queue && queue.dead > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-100">
                <span className="font-bold">{queue.dead}</span> gave up
              </span>
            ) : null}
            {devMode ? <ProcessQueueNowButton /> : null}
          </div>
        ) : null}
      </div>

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
            const Icon = style.icon;
            // stop_reason for a skip or a safeguard stop, error_detail
            // for a failure — never both, and never neither for the two
            // statuses that are meaningless without one.
            const reason = run.stop_reason ?? run.error_detail;

            return (
              <li key={run.id} className="flex flex-wrap items-start gap-3 px-4 py-3">
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex shrink-0 items-center justify-center rounded-full ${style.chip} ${
                    style.emphasize ? "h-7 w-7" : "h-6 w-6"
                  }`}
                >
                  <Icon className={style.emphasize ? "h-4 w-4" : "h-3.5 w-3.5"} />
                </span>
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
