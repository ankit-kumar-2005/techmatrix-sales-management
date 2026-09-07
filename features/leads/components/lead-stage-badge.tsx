import type { CustomerLeadStage } from "@/types/lead";
import { stageBadgeClasses } from "../lib/stage-colors";
import { LockIcon } from "@/features/sales-management/components/icons";

type LeadStageBadgeProps = {
  stage: Pick<CustomerLeadStage, "stage" | "is_closed" | "display_order">;
  /** Shows a small lock glyph — used on the lead's own badge (not the
   *  stage-config list) to make a closed/locked lead visually obvious
   *  in List/Board views, per "closed leads should be read-only" /
   *  "closed stages should be visually identifiable." */
  showLockedIndicator?: boolean;
};

export function LeadStageBadge({ stage, showLockedIndicator = false }: LeadStageBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ring-black/5 ${stageBadgeClasses(stage)}`}
    >
      {showLockedIndicator && stage.is_closed ? <LockIcon className="h-2.5 w-2.5" /> : null}
      {stage.stage}
    </span>
  );
}
