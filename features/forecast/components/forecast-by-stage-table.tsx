import { currencyFormatter } from "@/utils/format";
import { LeadStageBadge } from "@/features/leads/components/lead-stage-badge";
import type { ForecastStageRow } from "../lib/get-forecast";

type ForecastByStageTableProps = {
  rows: ForecastStageRow[];
};

/**
 * Forecast by stage: probability, open deal count, total value, weighted
 * value — one row per configured stage, in the customer's own
 * display_order.
 *
 * REUSES LeadStageBadge rather than styling a stage pill here, so the
 * color a stage has in the Pipeline board, the List view and the Leads
 * By Stage legend is the same color it has in this table. That component
 * derives its color from display_order (never from the stage's name), so
 * a customer who renames or reorders stages stays consistent across all
 * four surfaces with no change here. The RPC returns display_order,
 * is_closed and is_won precisely so this can happen without a second
 * query against customer_lead_stages.
 *
 * CLOSED STAGES ARE SHOWN, not filtered out. A won stage's total is the
 * Closed-Won figure the KPI card reports, and seeing it in the same
 * table as the open stages is what makes that card checkable. But
 * neither closed kind contributes to Weighted Forecast, so their
 * weighted column is rendered as a muted note rather than a number
 * competing with the open rows: Won is already banked, Lost will never
 * close.
 */
export function ForecastByStageTable({ rows }: ForecastByStageTableProps) {
  const openRows = rows.filter((row) => !row.isClosed);
  const weightedTotal = openRows.reduce((total, row) => total + row.weightedValue, 0);

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pt-6 pb-4">
        <h2 className="text-base font-semibold text-neutral-900">Forecast By Stage</h2>
        <span className="text-xs font-medium text-neutral-500">
          {currencyFormatter.format(weightedTotal)} weighted across open stages
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-6 pb-6 text-sm text-neutral-500">No stages are configured yet.</p>
      ) : (
        /* Horizontally scrollable on narrow screens rather than wrapping
           cells — same treatment the Pipeline List view gives its own
           table, so five numeric columns stay aligned and readable. */
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-y border-neutral-100 bg-neutral-50/70 text-left">
                <Th>Stage</Th>
                <Th align="right">Probability</Th>
                <Th align="right">Open Deals</Th>
                <Th align="right">Total Value</Th>
                <Th align="right">Weighted Value</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.stageId} className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/60">
                  <td className="px-6 py-3.5">
                    <div className="flex items-center gap-2">
                      <LeadStageBadge
                        stage={{
                          stage: row.stage,
                          is_closed: row.isClosed,
                          is_won: row.isWon,
                          display_order: row.displayOrder,
                        }}
                      />
                      {row.status === "Inactive" ? (
                        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-neutral-500 uppercase">
                          Inactive
                        </span>
                      ) : null}
                    </div>
                  </td>

                  <td className="px-6 py-3.5 text-right tabular-nums">
                    {row.isClosed && !row.isWon ? (
                      <span className="text-neutral-400">—</span>
                    ) : (
                      /* A 0% OPEN stage contributes nothing to the
                         forecast and is nearly always an unconfigured
                         stage rather than a deliberate one — flagged
                         here, in the one place a manager is looking at
                         probabilities, with the fix named. */
                      <span
                        className={
                          !row.isClosed && row.probability === 0 ? "font-medium text-amber-600" : "text-neutral-700"
                        }
                        title={
                          !row.isClosed && row.probability === 0
                            ? "This stage has no probability set, so its deals add nothing to the forecast. Set one in Settings → Company Information → Lead Stages."
                            : undefined
                        }
                      >
                        {row.probability}%
                      </span>
                    )}
                  </td>

                  <td className="px-6 py-3.5 text-right tabular-nums text-neutral-700">
                    {row.isClosed ? <span className="text-neutral-400">—</span> : row.openDealCount}
                  </td>

                  <td className="px-6 py-3.5 text-right tabular-nums text-neutral-700">
                    {currencyFormatter.format(row.totalValue)}
                  </td>

                  <td className="px-6 py-3.5 text-right tabular-nums">
                    {/* A won stage shows its real weighted value (which
                        equals its total, since probability is pinned to
                        100) so the Closed-Won To Date card can be checked
                        against this table. A lost stage weighs 0 by
                        definition, and rendering that as "₹0" would read
                        as a missing number rather than an excluded one. */}
                    {row.isClosed && !row.isWon ? (
                      <span className="text-xs text-neutral-400">Not forecast</span>
                    ) : (
                      <span className={row.isClosed ? "font-medium text-neutral-500" : "font-semibold text-neutral-900"}>
                        {currencyFormatter.format(row.weightedValue)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      scope="col"
      className={`px-6 py-3 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {children}
    </th>
  );
}
