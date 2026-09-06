"use client";

import { useMemo, useState } from "react";
import { LeadStageBadge } from "./lead-stage-badge";
import { SearchIcon, LeadCaptureIcon } from "@/features/sales-management/components/icons";
import { currencyFormatter, dateFormatter } from "@/utils/format";
import { LEAD_SOURCES, LEAD_STAGES } from "../schemas";
import type { Lead, LeadStage } from "@/types/lead";
import type { TeamDirectoryEntry } from "@/types/lead";

const UNASSIGNED = "unassigned";

const controlClass =
  "h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-700 outline-none transition-colors focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";

type PipelineViewProps = {
  leads: Lead[];
  owners: TeamDirectoryEntry[];
};

/**
 * Owns the List/Pipeline board toggle and the search/stage/owner/source
 * filters, and applies them to one shared, in-memory `leads` array (this
 * page already fetches its customer's full lead set server-side — see
 * getLeadsForCustomer — so filtering client-side over that same array,
 * rather than re-querying, is what keeps List and Board perfectly in
 * sync with zero duplicate data-fetching). The KPI cards and "Leads by
 * stage" above this component intentionally use the unfiltered `leads`
 * prop from the page — only this toolbar's own List/Board content reacts
 * to the filters, matching the reference layout.
 */
export function PipelineView({ leads, owners }: PipelineViewProps) {
  const [view, setView] = useState<"list" | "board">("list");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");

  const ownerEmailById = useMemo(
    () => new Map(owners.map((owner) => [owner.customer_user_id, owner.email])),
    [owners],
  );

  // Always offers the same curated list as the Create Lead form, plus any
  // real source already on a lead that falls outside it (source has no
  // CHECK constraint, so that's possible) — never fewer options than the
  // curated list, and never a source in the data that can't be filtered on.
  const availableSources = useMemo(() => {
    const extras = new Set<string>();
    for (const lead of leads) {
      if (lead.source && !LEAD_SOURCES.includes(lead.source)) {
        extras.add(lead.source);
      }
    }
    return [...LEAD_SOURCES, ...Array.from(extras).sort((a, b) => a.localeCompare(b))];
  }, [leads]);

  const hasActiveFilters = Boolean(search || stageFilter || ownerFilter || sourceFilter);

  const filteredLeads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return leads.filter((lead) => {
      if (stageFilter && lead.stage !== stageFilter) return false;
      if (ownerFilter === UNASSIGNED && lead.owner_id) return false;
      if (ownerFilter && ownerFilter !== UNASSIGNED && lead.owner_id !== ownerFilter) return false;
      if (sourceFilter && (lead.source ?? "") !== sourceFilter) return false;
      if (query && !`${lead.company ?? ""} ${lead.contact_name}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [leads, search, stageFilter, ownerFilter, sourceFilter]);

  function resetFilters() {
    setSearch("");
    setStageFilter("");
    setOwnerFilter("");
    setSourceFilter("");
  }

  return (
    <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      <div className="flex flex-col gap-4 border-b border-neutral-100 p-4 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex gap-1 rounded-full bg-neutral-100 p-1">
          <button
            type="button"
            onClick={() => setView("list")}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              view === "list" ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700"
            }`}
          >
            List
          </button>
          <button
            type="button"
            onClick={() => setView("board")}
            className={`rounded-full px-4 py-2 text-sm font-semibold transition-colors ${
              view === "board" ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700"
            }`}
          >
            Pipeline board
          </button>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="relative sm:w-64">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search leads or companies..."
              className={`${controlClass} w-full pl-9`}
            />
          </div>

          <select
            value={stageFilter}
            onChange={(event) => setStageFilter(event.target.value)}
            className={controlClass}
          >
            <option value="">All stages</option>
            {LEAD_STAGES.map((stage) => (
              <option key={stage} value={stage}>
                {stage}
              </option>
            ))}
          </select>

          <select
            value={ownerFilter}
            onChange={(event) => setOwnerFilter(event.target.value)}
            className={controlClass}
          >
            <option value="">All owners</option>
            <option value={UNASSIGNED}>Unassigned</option>
            {owners.map((owner) => (
              <option key={owner.customer_user_id} value={owner.customer_user_id}>
                {owner.email}
              </option>
            ))}
          </select>

          <select
            value={sourceFilter}
            onChange={(event) => setSourceFilter(event.target.value)}
            className={controlClass}
          >
            <option value="">All sources</option>
            {availableSources.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={resetFilters}
            disabled={!hasActiveFilters}
            className="h-10 rounded-lg border border-neutral-300 px-4 text-sm font-semibold text-neutral-600 transition-colors hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reset
          </button>
        </div>
      </div>

      {filteredLeads.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-14 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sky-50 text-sky-600">
            <LeadCaptureIcon className="h-6 w-6" />
          </span>
          {leads.length === 0 ? (
            <div>
              <p className="text-sm font-semibold text-neutral-700">No leads yet</p>
              <p className="mt-1 max-w-xs text-sm text-neutral-500">
                Click &ldquo;New Lead&rdquo; to add your first one.
              </p>
            </div>
          ) : (
            <div>
              <p className="text-sm font-semibold text-neutral-700">No leads match these filters</p>
              <button
                type="button"
                onClick={resetFilters}
                className="mt-1 text-sm font-semibold text-sky-600 hover:text-sky-700"
              >
                Reset filters
              </button>
            </div>
          )}
        </div>
      ) : view === "list" ? (
        <ListView leads={filteredLeads} ownerEmailById={ownerEmailById} />
      ) : (
        <BoardView leads={filteredLeads} ownerEmailById={ownerEmailById} />
      )}
    </div>
  );
}

type ViewProps = {
  leads: Lead[];
  ownerEmailById: Map<string, string>;
};

function ListView({ leads, ownerEmailById }: ViewProps) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          <tr className="border-b border-neutral-100 text-xs font-medium uppercase tracking-wide text-neutral-500">
            <th className="px-6 py-3">Lead</th>
            <th className="px-3 py-3">Stage</th>
            <th className="px-3 py-3">Value</th>
            <th className="px-3 py-3">Source</th>
            <th className="px-3 py-3">Owner</th>
            <th className="px-3 py-3">Updated</th>
            <th className="px-3 py-3">Next Step</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead) => {
            const ownerEmail = lead.owner_id ? ownerEmailById.get(lead.owner_id) : undefined;
            const ownerInitial = ownerEmail ? ownerEmail.charAt(0).toUpperCase() : null;

            return (
              <tr key={lead.id} className="border-b border-neutral-50 transition-colors hover:bg-neutral-50">
                <td className="px-6 py-3.5">
                  <p className="font-medium text-neutral-900">{lead.company ?? "—"}</p>
                  <p className="text-xs text-neutral-500">{lead.contact_name}</p>
                </td>
                <td className="px-3 py-3.5">
                  <LeadStageBadge stage={lead.stage} />
                </td>
                <td className="px-3 py-3.5 font-medium text-neutral-900">
                  {lead.deal_value === null ? "—" : currencyFormatter.format(lead.deal_value)}
                </td>
                <td className="px-3 py-3.5 text-neutral-600">{lead.source ?? "—"}</td>
                <td className="px-3 py-3.5">
                  {ownerEmail ? (
                    <span className="flex items-center gap-2">
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[10px] font-semibold text-sky-700">
                        {ownerInitial}
                      </span>
                      <span className="max-w-[10rem] truncate text-neutral-700">{ownerEmail}</span>
                    </span>
                  ) : (
                    <span className="text-neutral-400">Unassigned</span>
                  )}
                </td>
                <td className="px-3 py-3.5 text-neutral-500">{dateFormatter.format(new Date(lead.updated_at))}</td>
                <td className="px-3 py-3.5 text-neutral-600">{lead.next_step ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const STAGE_DOT_COLORS: Record<LeadStage, string> = {
  New: "bg-neutral-400",
  Contacted: "bg-sky-500",
  Qualified: "bg-amber-500",
  Proposal: "bg-violet-500",
  Won: "bg-emerald-500",
  Lost: "bg-red-500",
};

function BoardView({ leads, ownerEmailById }: ViewProps) {
  const columns = LEAD_STAGES.map((stage) => {
    const stageLeads = leads.filter((lead) => lead.stage === stage);
    const total = stageLeads.reduce((sum, lead) => sum + Number(lead.deal_value ?? 0), 0);
    return { stage, leads: stageLeads, total };
  });

  return (
    <div className="flex gap-4 overflow-x-auto p-4 sm:p-6">
      {columns.map(({ stage, leads: stageLeads, total }) => (
        <div key={stage} className="w-72 shrink-0 rounded-2xl bg-neutral-50 p-3">
          <div className="flex items-center gap-1.5 px-1 text-sm font-semibold text-neutral-900">
            <span className={`h-2 w-2 rounded-full ${STAGE_DOT_COLORS[stage]}`} />
            {stage}
          </div>
          <p className="mb-3 px-1 text-xs text-neutral-500">
            {stageLeads.length} · {currencyFormatter.format(total)}
          </p>

          <div className="flex max-h-[32rem] flex-col gap-2.5 overflow-y-auto">
            {stageLeads.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-neutral-400">No leads at this stage</p>
            ) : (
              stageLeads.map((lead) => {
                const ownerEmail = lead.owner_id ? ownerEmailById.get(lead.owner_id) : undefined;
                const ownerInitial = ownerEmail ? ownerEmail.charAt(0).toUpperCase() : null;

                return (
                  <div key={lead.id} className="rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-black/5 transition-shadow hover:shadow-md">
                    <p className="truncate text-sm font-semibold text-neutral-900">{lead.company ?? "—"}</p>
                    <p className="truncate text-xs text-neutral-500">{lead.contact_name}</p>
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5">
                        {ownerEmail ? (
                          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[9px] font-semibold text-sky-700">
                            {ownerInitial}
                          </span>
                        ) : null}
                        <span className="text-sm font-semibold text-neutral-900">
                          {lead.deal_value === null ? "—" : currencyFormatter.format(lead.deal_value)}
                        </span>
                      </span>
                    </div>
                    {lead.source ? (
                      <p className="mt-2 text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">
                        {lead.source}
                      </p>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
