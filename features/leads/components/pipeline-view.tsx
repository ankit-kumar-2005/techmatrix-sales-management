"use client";

import { useMemo, useState } from "react";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { LeadStageBadge } from "./lead-stage-badge";
import { EditLeadDialog } from "./edit-lead-dialog";
import {
  SearchIcon,
  LeadCaptureIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  LockIcon,
  PencilIcon,
} from "@/features/sales-management/components/icons";
import { currencyFormatter, dateFormatter } from "@/utils/format";
import { LEAD_SOURCES } from "../schemas";
import { stageDotClass } from "../lib/stage-colors";
import type { CustomerLeadStage, Lead, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

const UNASSIGNED = "unassigned";

const controlClass =
  "h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";

const selectControlClass = `${controlClass} w-full appearance-none pr-9`;

type PipelineViewProps = {
  leads: Lead[];
  /** All of the customer's stages (active and inactive), ordered by
   *  display_order — the filter dropdown narrows to Active ones itself
   *  (see Section 35 of the spec), but List/Board/badges use the full
   *  set so a lead sitting in a since-deactivated stage still resolves
   *  and displays correctly. */
  stages: CustomerLeadStage[];
  owners: TeamDirectoryEntry[];
  role: CustomerRole;
  currentUserEmail: string;
  /** The caller's own customer_users.id — used only to decide, per row,
   *  whether the List View's Edit action is shown at all for a non-admin
   *  (they may only edit a lead they themselves own; matches the
   *  "owners or admins can update a lead" RLS policy exactly). This is a
   *  UX decision only — updateLeadAction re-checks the same rule against
   *  the database regardless. */
  currentUserCustomerUserId: string;
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
export function PipelineView({ leads, stages, owners, role, currentUserEmail, currentUserCustomerUserId }: PipelineViewProps) {
  const [view, setView] = useState<"list" | "board">("list");
  const [search, setSearch] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [editingLead, setEditingLead] = useState<Lead | null>(null);

  const stagesById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);
  const activeStages = useMemo(() => stages.filter((stage) => stage.status === "Active"), [stages]);

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
      if (stageFilter && lead.stage_id !== stageFilter) return false;
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
    <>
    <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
      {/* Below sm: everything stacks full-width (no wrapping concern —
          it's already one column). From sm: up, this becomes a single
          flex-nowrap row: every control except search is flex-shrink-0
          at a fixed width, search is the one flexible/shrinkable element
          (flex-1 with a floor), and if the row's total content still
          can't fit at a given width, this container scrolls horizontally
          rather than letting any control wrap onto a second line or spill
          past the card. */}
      <div className="border-b border-neutral-100 p-4 sm:overflow-x-auto sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-nowrap sm:items-center sm:gap-3">
          <div className="flex shrink-0 gap-1 rounded-full bg-neutral-100 p-1">
            <button
              type="button"
              onClick={() => setView("list")}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition-all duration-200 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none ${
                view === "list" ? "bg-sky-600 text-white shadow-sm" : "text-neutral-500 hover:text-neutral-700"
              }`}
            >
              List
            </button>
            <button
              type="button"
              onClick={() => setView("board")}
              className={`rounded-full px-4 py-2 text-sm font-semibold transition-all duration-200 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none ${
                view === "board" ? "bg-sky-600 text-white shadow-sm" : "text-neutral-500 hover:text-neutral-700"
              }`}
            >
              Pipeline board
            </button>
          </div>

          <div className="group relative w-full sm:min-w-[10rem] sm:flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400 transition-colors group-focus-within:text-sky-500" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search leads or companies..."
              className={`${controlClass} w-full pl-9`}
            />
          </div>

          <div className="relative w-full shrink-0 sm:w-32">
            <select
              value={stageFilter}
              onChange={(event) => setStageFilter(event.target.value)}
              className={`${selectControlClass} truncate`}
            >
              <option value="">All stages</option>
              {activeStages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.stage}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          </div>

          <div className="relative w-full shrink-0 sm:w-32">
            <select
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.target.value)}
              className={`${selectControlClass} truncate`}
            >
              <option value="">All owners</option>
              <option value={UNASSIGNED}>Unassigned</option>
              {owners.map((owner) => (
                <option key={owner.customer_user_id} value={owner.customer_user_id}>
                  {owner.email}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          </div>

          <div className="relative w-full shrink-0 sm:w-32">
            <select
              value={sourceFilter}
              onChange={(event) => setSourceFilter(event.target.value)}
              className={`${selectControlClass} truncate`}
            >
              <option value="">All sources</option>
              {availableSources.map((source) => (
                <option key={source} value={source}>
                  {source}
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" />
          </div>

          <button
            type="button"
            onClick={resetFilters}
            disabled={!hasActiveFilters}
            className="h-10 w-full shrink-0 rounded-lg border border-neutral-300 px-4 text-sm font-semibold text-neutral-500 transition-colors hover:border-neutral-400 hover:bg-neutral-50 hover:text-neutral-700 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
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
        <ListView
          leads={filteredLeads}
          stagesById={stagesById}
          ownerEmailById={ownerEmailById}
          role={role}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onEdit={setEditingLead}
        />
      ) : (
        <BoardView
          leads={filteredLeads}
          // Every active stage gets a column, even an empty one (it's
          // ready to receive a lead) — an Inactive stage only keeps its
          // column while it still has leads in it, so retired stages
          // with no history don't pile up on the board forever, while
          // ones with real historical leads never lose visibility.
          stages={stages.filter(
            (stage) => stage.status === "Active" || filteredLeads.some((lead) => lead.stage_id === stage.id),
          )}
          ownerEmailById={ownerEmailById}
        />
      )}
    </div>

    {editingLead ? (
      <EditLeadDialog
        key={editingLead.id}
        lead={editingLead}
        stages={stages}
        owners={owners}
        role={role}
        currentUserEmail={currentUserEmail}
        onClose={() => setEditingLead(null)}
      />
    ) : null}
    </>
  );
}

type ListViewProps = {
  leads: Lead[];
  stagesById: Map<string, CustomerLeadStage>;
  ownerEmailById: Map<string, string>;
  role: CustomerRole;
  currentUserCustomerUserId: string;
  onEdit: (lead: Lead) => void;
};

/**
 * The List View's actual data table — TanStack Table (useReactTable)
 * over the same already-filtered `leads` array PipelineView has always
 * computed (Search/Stage/Owner/Source filtering is untouched, still
 * plain client-side filtering upstream in PipelineView; this component
 * only owns how the resulting rows are rendered and sorted). Column
 * defs are built with useMemo so cell renderers can close over
 * stagesById/ownerEmailById/role/currentUserCustomerUserId/onEdit
 * without recreating on every render.
 *
 * Note: this still fetches and holds every one of the customer's leads
 * in memory (getLeadsForCustomer has no pagination) — swapping in a
 * real table library doesn't by itself address CLAUDE.md Section O's
 * server-side-pagination guidance for large lead lists; that's a
 * separate, larger change.
 */
function ListView({ leads, stagesById, ownerEmailById, role, currentUserCustomerUserId, onEdit }: ListViewProps) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const columns = useMemo<ColumnDef<Lead>[]>(
    () => [
      {
        id: "lead",
        header: "Lead",
        accessorFn: (lead) => lead.company || lead.contact_name,
        cell: ({ row }) => {
          const lead = row.original;
          return (
            <>
              <p className="flex items-center gap-1.5 font-medium text-neutral-900">
                {lead.closed_at ? (
                  <LockIcon className="h-3 w-3 shrink-0 text-neutral-400" aria-label="Closed — read-only" />
                ) : null}
                {lead.company ?? "—"}
              </p>
              <p className="text-xs text-neutral-500">{lead.contact_name}</p>
            </>
          );
        },
      },
      {
        id: "stage",
        header: "Stage",
        // Sorts by the stage's own display_order — the same order used
        // everywhere else (filter, board, legend) — never by name.
        accessorFn: (lead) => stagesById.get(lead.stage_id)?.display_order ?? Number.MAX_SAFE_INTEGER,
        cell: ({ row }) => {
          const stage = stagesById.get(row.original.stage_id);
          return stage ? <LeadStageBadge stage={stage} /> : "—";
        },
      },
      {
        id: "value",
        header: "Value",
        accessorFn: (lead) => lead.deal_value,
        cell: ({ row }) => {
          const value = row.original.deal_value;
          return (
            <span className="font-medium text-neutral-900">
              {value === null ? <span className="text-neutral-300">—</span> : currencyFormatter.format(value)}
            </span>
          );
        },
      },
      {
        id: "source",
        header: "Source",
        accessorFn: (lead) => lead.source ?? "",
        cell: ({ row }) => (
          <span className="text-neutral-600">{row.original.source ?? <span className="text-neutral-300">—</span>}</span>
        ),
      },
      {
        id: "owner",
        header: "Owner",
        accessorFn: (lead) => (lead.owner_id ? (ownerEmailById.get(lead.owner_id) ?? "") : ""),
        cell: ({ row }) => {
          const lead = row.original;
          const ownerEmail = lead.owner_id ? ownerEmailById.get(lead.owner_id) : undefined;
          const ownerInitial = ownerEmail ? ownerEmail.charAt(0).toUpperCase() : null;
          return ownerEmail ? (
            <span className="flex items-center gap-2">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[10px] font-semibold text-sky-700 shadow-sm ring-1 ring-sky-200/60">
                {ownerInitial}
              </span>
              <span className="max-w-[10rem] truncate text-neutral-700" title={ownerEmail}>
                {ownerEmail}
              </span>
            </span>
          ) : (
            <span className="text-neutral-400">Unassigned</span>
          );
        },
      },
      {
        id: "updated",
        header: "Updated",
        accessorFn: (lead) => lead.updated_at,
        cell: ({ row }) => (
          <span className="text-neutral-500">{dateFormatter.format(new Date(row.original.updated_at))}</span>
        ),
      },
      {
        id: "next_step",
        header: "Next Step",
        accessorFn: (lead) => lead.next_step ?? "",
        cell: ({ row }) => (
          <span className="text-neutral-600">{row.original.next_step ?? <span className="text-neutral-300">—</span>}</span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) => {
          const lead = row.original;
          const isClosed = Boolean(lead.closed_at);
          // Matches the "owners or admins can update a lead" RLS policy
          // exactly — hierarchy-aware SELECT visibility (a manager
          // seeing their team's leads) does NOT imply edit rights over
          // leads they don't themselves own; see 20260906120000's design
          // notes. This is UX only — updateLeadAction re-checks the
          // same rule server-side.
          const canEdit = !isClosed && (role === "ADMIN" || lead.owner_id === currentUserCustomerUserId);

          if (canEdit) {
            return (
              <button
                type="button"
                onClick={() => onEdit(lead)}
                aria-label={`Edit ${lead.contact_name}`}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
              >
                <PencilIcon className="h-3.5 w-3.5" />
              </button>
            );
          }
          if (isClosed) {
            return (
              <span
                title="Closed leads are read-only"
                className="inline-flex h-8 w-8 items-center justify-center text-neutral-300"
              >
                <LockIcon className="h-3.5 w-3.5" />
              </span>
            );
          }
          return null;
        },
      },
    ],
    [stagesById, ownerEmailById, role, currentUserCustomerUserId, onEdit],
  );

  const table = useReactTable({
    data: leads,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-sm">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr
              key={headerGroup.id}
              className="border-b border-neutral-100 bg-neutral-50/60 text-xs font-semibold tracking-wider text-neutral-500 uppercase"
            >
              {headerGroup.headers.map((header, index) => (
                <th
                  key={header.id}
                  className={`py-3 ${index === 0 ? "px-6" : "px-3"} ${header.column.id === "actions" ? "text-right" : ""}`}
                >
                  {header.column.getCanSort() ? (
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className="inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-neutral-700"
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === "asc" ? (
                        <ChevronUpIcon className="h-3 w-3" />
                      ) : header.column.getIsSorted() === "desc" ? (
                        <ChevronDownIcon className="h-3 w-3" />
                      ) : null}
                    </button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-b border-neutral-50 transition-colors hover:bg-neutral-50">
              {row.getVisibleCells().map((cell, index) => (
                <td
                  key={cell.id}
                  className={`py-4 ${index === 0 ? "px-6" : "px-3"} ${cell.column.id === "actions" ? "text-right" : ""}`}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type BoardViewProps = {
  leads: Lead[];
  stages: CustomerLeadStage[];
  ownerEmailById: Map<string, string>;
};

function BoardView({ leads, stages, ownerEmailById }: BoardViewProps) {
  const columns = stages.map((stage) => {
    const stageLeads = leads.filter((lead) => lead.stage_id === stage.id);
    const total = stageLeads.reduce((sum, lead) => sum + Number(lead.deal_value ?? 0), 0);
    return { stage, leads: stageLeads, total };
  });

  return (
    <div className="flex gap-4 overflow-x-auto p-4 sm:p-6">
      {columns.map(({ stage, leads: stageLeads, total }) => (
        <div
          key={stage.id}
          className={`w-72 shrink-0 rounded-2xl p-3 ${stage.is_closed ? "bg-neutral-100/80" : "bg-neutral-50"}`}
        >
          <div className="flex items-center gap-1.5 px-1 text-sm font-semibold text-neutral-900">
            <span className={`h-2 w-2 rounded-full ${stageDotClass(stage)}`} />
            {stage.stage}
            {stage.is_closed ? <LockIcon className="h-3 w-3 text-neutral-400" aria-label="Closed stage" /> : null}
            {stage.status === "Inactive" ? (
              <span className="ml-auto rounded-full bg-neutral-200 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-neutral-500 uppercase">
                Inactive
              </span>
            ) : null}
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
                  <div
                    key={lead.id}
                    className="rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
                  >
                    <p
                      className="flex items-center gap-1.5 truncate text-sm font-semibold text-neutral-900"
                      title={lead.company ?? undefined}
                    >
                      {lead.closed_at ? (
                        <LockIcon className="h-3 w-3 shrink-0 text-neutral-400" aria-label="Closed — read-only" />
                      ) : null}
                      {lead.company ?? "—"}
                    </p>
                    <p className="truncate text-xs text-neutral-500" title={lead.contact_name}>
                      {lead.contact_name}
                    </p>
                    <div className="mt-2.5 flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5">
                        {ownerEmail ? (
                          <span
                            title={ownerEmail}
                            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[9px] font-semibold text-sky-700 shadow-sm ring-1 ring-sky-200/60"
                          >
                            {ownerInitial}
                          </span>
                        ) : null}
                        <span className="text-sm font-semibold text-neutral-900">
                          {lead.deal_value === null ? <span className="text-neutral-300">—</span> : currencyFormatter.format(lead.deal_value)}
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
