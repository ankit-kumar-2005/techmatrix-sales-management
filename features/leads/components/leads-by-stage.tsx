import type { CustomerLeadStage } from "@/types/lead";
import type { PipelineLead } from "../lib/get-leads";
import { stageDotClass } from "../lib/stage-colors";

type LeadsByStageProps = {
  leads: PipelineLead[];
  /** All of the customer's stages (active and inactive), already
   *  ordered by display_order — the same order the Create Lead
   *  dropdown, stage filter, and Pipeline Board columns use, so this
   *  section can never drift out of sync with the rest of the page. */
  stages: CustomerLeadStage[];
};

/**
 * Deliberately built from `leads` directly (not a fixed set of counts)
 * so it can never drift from real data, and from the customer's actual
 * configured stages (not a hardcoded list) so an arbitrary number of
 * customer-defined stages — "Prospecting", "Dealer Technical
 * Inspection", anything — show up here automatically, in the order the
 * customer configured, with zero code changes.
 */
export function LeadsByStage({ leads, stages }: LeadsByStageProps) {
  const total = leads.length;
  const stageCounts = stages.map((stage) => ({
    stage,
    count: leads.filter((lead) => lead.stage_id === stage.id).length,
  }));

  return (
    <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-neutral-900">Leads by stage</h2>
        <span className="text-xs font-medium text-neutral-500">
          {total} total lead{total === 1 ? "" : "s"}
        </span>
      </div>

      <div className="mt-5 flex h-3 w-full gap-[3px] rounded-full bg-neutral-100 p-[3px]">
        {total === 0
          ? null
          : stageCounts.map(({ stage, count }) =>
              count === 0 ? null : (
                <div
                  key={stage.id}
                  className={`rounded-full transition-[width] duration-300 ease-out ${stageDotClass(stage)}`}
                  style={{ width: `${(count / total) * 100}%` }}
                />
              ),
            )}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2.5">
        {stageCounts.map(({ stage, count }) => (
          <div
            key={stage.id}
            className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-sm transition-colors hover:bg-neutral-50"
          >
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full shadow-sm ${count === 0 ? "opacity-40" : ""} ${stageDotClass(stage)}`}
            />
            <span className={count === 0 ? "text-neutral-400" : "text-neutral-600"}>{stage.stage}</span>
            <span className={`font-semibold ${count === 0 ? "text-neutral-300" : "text-neutral-900"}`}>{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
