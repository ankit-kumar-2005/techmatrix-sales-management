import type { LeadStage } from "@/types/lead";

const STAGE_STYLES: Record<LeadStage, string> = {
  New: "bg-neutral-100 text-neutral-700",
  Contacted: "bg-sky-50 text-sky-700",
  Qualified: "bg-amber-50 text-amber-700",
  Proposal: "bg-violet-50 text-violet-700",
  Won: "bg-emerald-50 text-emerald-700",
  Lost: "bg-red-50 text-red-700",
};

export function LeadStageBadge({ stage }: { stage: LeadStage }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STAGE_STYLES[stage]}`}>
      {stage}
    </span>
  );
}
