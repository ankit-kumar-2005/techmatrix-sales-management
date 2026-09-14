import type { CustomerLeadStage } from "@/types/lead";

/**
 * One shared source of stage color logic for every UI surface that
 * colors a stage (badges, the Leads-by-stage legend/bar, Pipeline Board
 * column headers, the List View's stage pill). Open stages are colored
 * entirely from display_order — never from a stage's name, since names
 * are arbitrary customer data — so a customer who renames, reorders, or
 * adds stages still gets a distinct, sensible color with zero code
 * changes. The one exception is closed stages: see isWonStage below.
 */
type StageColorInput = Pick<CustomerLeadStage, "is_closed" | "display_order" | "stage">;

/**
 * There is no is_won (or equivalent) column in customer_lead_stages
 * (deliberately not added — see the dynamic_lead_stages_and_closed_locking
 * migration's design notes), so a closed stage can't be resolved to
 * "won" vs. "lost" from data alone. This is the one place in the color
 * system that falls back to a name comparison: a closed stage whose
 * name matches "Won" case-insensitively (the seeded default, and
 * anything a customer renames to match it) is treated as won; every
 * other closed stage is treated as lost. Same known, documented
 * limitation already accepted for the Sales Pipeline page's Win Rate /
 * Avg. Closed-Won Deal KPIs — this just reuses that one function so the
 * "what counts as won" definition can't drift between the KPI numbers
 * and the colors shown for the exact same leads.
 */
export function isWonStage(stage: Pick<CustomerLeadStage, "is_closed" | "stage"> | undefined): boolean {
  return Boolean(stage?.is_closed) && stage!.stage.trim().toLowerCase() === "won";
}

// Indexed by display_order % length. Index 0 is the wrap-around slot
// (only reached by a 7th+ open stage, or a customer whose lowest
// display_order happens to be a multiple of 6) — for the seeded default
// order (New=1, Contacted=2, Qualified=3, Proposal=4, Won=5, Lost=6),
// this lines up as New=blue, Contacted=sky, Qualified=violet,
// Proposal=amber, with Won/Lost never reaching this array at all
// (is_closed is checked first).
const OPEN_BADGE_PALETTE = [
  "bg-teal-100 text-teal-700",
  "bg-blue-100 text-blue-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-indigo-100 text-indigo-700",
];

const OPEN_DOT_PALETTE = [
  "bg-teal-500",
  "bg-blue-500",
  "bg-sky-500",
  "bg-violet-500",
  "bg-amber-500",
  "bg-indigo-500",
];

// Same palette as OPEN_DOT_PALETTE, as border-color utilities instead of
// background-color ones — for the Pipeline board card's left-border
// accent (see stageBorderClass below). Kept as its own literal array
// (not derived from OPEN_DOT_PALETTE by string manipulation) so
// Tailwind's class scanner can find every one of these exact strings at
// build time — a computed "bg-*" -> "border-l-*" replacement wouldn't
// be visible to the scanner and would silently produce no styles.
const OPEN_BORDER_PALETTE = [
  "border-l-teal-500",
  "border-l-blue-500",
  "border-l-sky-500",
  "border-l-violet-500",
  "border-l-amber-500",
  "border-l-indigo-500",
];

export function stageBadgeClasses(stage: StageColorInput): string {
  if (stage.is_closed) {
    return isWonStage(stage) ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700";
  }
  return OPEN_BADGE_PALETTE[stage.display_order % OPEN_BADGE_PALETTE.length];
}

export function stageDotClass(stage: StageColorInput): string {
  if (stage.is_closed) {
    return isWonStage(stage) ? "bg-emerald-600" : "bg-rose-600";
  }
  return OPEN_DOT_PALETTE[stage.display_order % OPEN_DOT_PALETTE.length];
}

/** A lead card's left-border accent — same color assigned to that
 *  lead's current stage everywhere else (the Leads-by-stage bar,
 *  column-header dot): New = blue, Contacted = sky, Qualified =
 *  violet, Proposal = amber, Won = emerald, Lost = rose, for the
 *  default seeded stage set — driven by the same display_order-based
 *  palette as stageDotClass, not a hardcoded name match, so a
 *  customer's renamed/reordered/added stages stay correctly colored
 *  here too. */
export function stageBorderClass(stage: StageColorInput): string {
  if (stage.is_closed) {
    return isWonStage(stage) ? "border-l-emerald-500" : "border-l-rose-500";
  }
  return OPEN_BORDER_PALETTE[stage.display_order % OPEN_BORDER_PALETTE.length];
}
