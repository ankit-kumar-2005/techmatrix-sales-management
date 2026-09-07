import type { Lead, LeadStage } from "@/types/lead";
import { LEAD_STAGES } from "../schemas";

const STAGE_DOT_COLORS: Record<LeadStage, string> = {
  New: "bg-neutral-400",
  Contacted: "bg-sky-500",
  Qualified: "bg-amber-500",
  Proposal: "bg-violet-500",
  Won: "bg-emerald-500",
  Lost: "bg-red-500",
};

type LeadsByStageProps = {
  leads: Lead[];
};

/**
 * Deliberately built from `leads` directly (not a fixed set of counts) so
 * it can never drift from real data. Driven entirely by LEAD_STAGES, the
 * single source of truth shared with the Create Lead Stage dropdown and
 * the Pipeline Board columns — so "Lost" (now a real, CHECK-allowed
 * stage) appears here automatically, with no separate list to keep in
 * sync.
 */
export function LeadsByStage({ leads }: LeadsByStageProps) {
  const total = leads.length;
  const stageCounts = LEAD_STAGES.map((stage) => ({
    stage,
    count: leads.filter((lead) => lead.stage === stage).length,
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
        {stageCounts.map(({ stage, count }) =>
          count === 0 ? null : (
            <div
              key={stage}
              className={`rounded-full transition-[width] duration-300 ease-out ${STAGE_DOT_COLORS[stage]}`}
              style={{ width: `${(count / total) * 100}%` }}
            />
          ),
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2.5">
        {stageCounts.map(({ stage, count }) => (
          <div
            key={stage}
            className="flex items-center gap-2 rounded-md px-1.5 py-0.5 text-sm transition-colors hover:bg-neutral-50"
          >
            <span
              className={`h-2.5 w-2.5 shrink-0 rounded-full shadow-sm ${count === 0 ? "opacity-40" : ""} ${STAGE_DOT_COLORS[stage]}`}
            />
            <span className={count === 0 ? "text-neutral-400" : "text-neutral-600"}>{stage}</span>
            <span className={`font-semibold ${count === 0 ? "text-neutral-300" : "text-neutral-900"}`}>{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
