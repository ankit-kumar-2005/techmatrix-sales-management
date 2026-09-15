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
type StageColorInput = Pick<CustomerLeadStage, "is_closed" | "is_won" | "display_order">;

/**
 * Whether a closed stage is a WIN rather than a loss.
 *
 * WAS A NAME MATCH, NOW A COLUMN. This used to read
 * `is_closed && stage.trim().toLowerCase() === "won"`, because
 * customer_lead_stages had no is_won column — a documented limitation
 * that quietly mis-classified any tenant who renamed the stage to
 * "Closed Won" or "Contract Signed" as a LOSS. The
 * stage_probability_and_outcome migration adds the real column (backfilled
 * to reproduce that old rule exactly, so no existing tenant's Win Rate
 * moved), and this collapses to reading it.
 *
 * Still a function rather than an inlined `stage.is_won` at each call
 * site, and still the single definition shared by the stage colors here
 * and by the Pipeline page's Win Rate / Avg. Closed-Won Deal KPIs and
 * the Forecast module — so "what counts as won" cannot drift between
 * the numbers and the colors shown for the exact same leads. The
 * database's own CHECK (is_won implies is_closed) is what makes reading
 * one column sufficient.
 */
export function isWonStage(stage: Pick<CustomerLeadStage, "is_won"> | undefined): boolean {
  return Boolean(stage?.is_won);
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
