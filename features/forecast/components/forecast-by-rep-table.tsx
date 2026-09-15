import { currencyFormatter } from "@/utils/format";
import { getOwnerAvatarColor, getOwnerDisplayLabels, getOwnerInitials } from "@/features/leads/lib/owner-display";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { ForecastRepRow } from "../lib/get-forecast";

type ForecastByRepTableProps = {
  rows: ForecastRepRow[];
  /** From the existing get_visible_team_directory() RPC — the same
   *  array the Pipeline page already passes around. Used only to put a
   *  name on an owner_id; it never decides which rows exist. */
  owners: TeamDirectoryEntry[];
};

/**
 * Forecast by rep: open deal count, best case, weighted forecast, per
 * deal owner.
 *
 * WHO SEES WHICH ROWS IS NOT DECIDED HERE — and that is the point.
 * get_forecast_by_owner() is SECURITY INVOKER, so
 * "hierarchy-aware lead visibility" groups only the leads the caller can
 * already see:
 *   ADMIN              every rep in the customer, plus Unassigned
 *   MANAGER / SENIOR   themselves plus their recursive reports
 *   SALES_REP          one row — their own
 *
 * THIS TABLE IS RENDERED FOR EVERY ROLE, WITH NO ROLE BRANCH. A
 * SALES_REP sees a single row that restates their own totals, which is
 * redundant but truthful, and leaks nothing. The alternative — hiding
 * the section for that one role — would be the first app-level role
 * check on lead data anywhere in this codebase and would contradict the
 * rule the Pipeline page states outright: "No app-level filtering by
 * role is needed here or anywhere else — the database query itself
 * already returned only authorized rows." A second copy of an
 * authorization rule in the UI is exactly how the two drift apart.
 *
 * Names come from getOwnerDisplayLabels/getOwnerInitials/
 * getOwnerAvatarColor, the same helpers behind the Pipeline List view's
 * Owner column, the board's owner avatars and the Tasks module — so one
 * person is called, initialled and colored identically everywhere. The
 * RPC deliberately returns no name or email of its own.
 */
export function ForecastByRepTable({ rows, owners }: ForecastByRepTableProps) {
  const ownerLabelById = getOwnerDisplayLabels(owners);
  const ownerById = new Map(owners.map((owner) => [owner.customer_user_id, owner]));

  const weightedTotal = rows.reduce((total, row) => total + row.weightedForecast, 0);

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pt-6 pb-4">
        <h2 className="text-base font-semibold text-neutral-900">Forecast By Rep</h2>
        <span className="text-xs font-medium text-neutral-500">
          {currencyFormatter.format(weightedTotal)} weighted in total
        </span>
      </div>

      {rows.length === 0 ? (
        <p className="px-6 pb-6 text-sm text-neutral-500">
          No open deals are assigned yet, so there is nothing to roll up by rep.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-y border-neutral-100 bg-neutral-50/70">
                <th
                  scope="col"
                  className="px-6 py-3 text-left text-[11px] font-semibold tracking-wider text-neutral-500 uppercase"
                >
                  Rep
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-right text-[11px] font-semibold tracking-wider text-neutral-500 uppercase"
                >
                  Open Deals
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-right text-[11px] font-semibold tracking-wider text-neutral-500 uppercase"
                >
                  Best Case
                </th>
                <th
                  scope="col"
                  className="px-6 py-3 text-right text-[11px] font-semibold tracking-wider text-neutral-500 uppercase"
                >
                  Weighted Forecast
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const owner = row.ownerId ? ownerById.get(row.ownerId) : undefined;
                // owner_id is null for an unassigned deal (only an ADMIN
                // can see those at all). A non-null id missing from the
                // directory means that membership was deactivated while
                // still owning open deals — worth naming plainly rather
                // than rendering a blank row.
                const label = row.ownerId
                  ? (ownerLabelById.get(row.ownerId) ?? "Former team member")
                  : "Unassigned";

                return (
                  <tr
                    key={row.ownerId ?? "unassigned"}
                    className="border-b border-neutral-100 last:border-0 hover:bg-neutral-50/60"
                  >
                    <td className="px-6 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ${
                            owner ? getOwnerAvatarColor(owner.customer_user_id) : "bg-neutral-400"
                          }`}
                        >
                          {owner ? getOwnerInitials(owner) : "—"}
                        </span>
                        <span className={`truncate font-medium ${owner ? "text-neutral-900" : "text-neutral-500"}`}>
                          {label}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-3.5 text-right tabular-nums text-neutral-700">{row.openDealCount}</td>
                    <td className="px-6 py-3.5 text-right tabular-nums text-neutral-700">
                      {currencyFormatter.format(row.bestCase)}
                    </td>
                    <td className="px-6 py-3.5 text-right font-semibold tabular-nums text-neutral-900">
                      {currencyFormatter.format(row.weightedForecast)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
