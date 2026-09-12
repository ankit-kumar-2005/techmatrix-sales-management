"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ColumnDef,
  type PaginationState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  DndContext,
  DragOverlay,
  KeyboardCode,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { LeadStageBadge } from "./lead-stage-badge";
import { EditLeadDialog } from "./edit-lead-dialog";
// The Tasks module's own creation dialog, reused as-is — see Section 26
// of the Tasks spec / the "Create Task from Lead Activity Icon" task.
// leads=[lead] preselects (and, since it's the only option, effectively
// locks) the Lead field, the same trick already used inside
// EditLeadDialog's own "Add Task" trigger — no new "locked lead" mode
// was added to TaskFormFields for this.
import { AddTaskDialog } from "@/features/tasks/components/add-task-dialog";
import { formatLeadLabel } from "@/features/leads/lib/get-lead-labels";
import type { PipelineLead } from "@/features/leads/lib/get-leads";
import { MessageBanner } from "@/components/shared/message-banner";
import {
  SearchIcon,
  LeadCaptureIcon,
  ChevronDownIcon,
  ClockIcon,
  LockIcon,
  PencilIcon,
} from "@/features/sales-management/components/icons";
import { currencyFormatter, dateFormatter } from "@/utils/format";
import { LEAD_SOURCES } from "../schemas";
import { stageDotClass } from "../lib/stage-colors";
import { getOwnerAvatarColor, getOwnerDisplayLabels, getOwnerInitials, getOwnerTooltip } from "../lib/owner-display";
import { moveLeadStageAction } from "../actions";
import type { CustomerLeadStage, TeamDirectoryEntry } from "@/types/lead";
import type { CustomerRole } from "@/types/customer";

const UNASSIGNED = "unassigned";

const controlClass =
  "h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";

const selectControlClass = `${controlClass} w-full appearance-none pr-9`;

// One shared copy of the closed-lead lock tooltip, used at both places
// this icon appears (the Lead cell and the Actions cell), so they can
// never drift into two different-sounding explanations of the same
// signal.
const CLOSED_LEAD_TOOLTIP = "This lead is closed and read-only";

// Same signal as CLOSED_LEAD_TOOLTIP, worded for the board's drag
// interaction specifically — shown on the Pipeline board's drag handle
// area, which the List view's row lock icon has no equivalent of.
const BOARD_LOCKED_CARD_TOOLTIP = "This lead is closed and can't be moved";

/** Whether the current user is allowed to change this lead at all —
 *  matches the "owners or admins can update a lead" RLS policy exactly
 *  (ADMIN, or the lead's own current owner; never a manager over their
 *  team's leads just from hierarchy-aware visibility) and the existing
 *  closed-lead lock. Shared by the List view's Edit action and the
 *  Pipeline board's drag handle so the two can never silently diverge —
 *  both are UX-only conveniences either way: updateLeadAction and
 *  moveLeadStageAction each re-check the same rule server-side. */
function canManageLead(lead: PipelineLead, role: CustomerRole, currentUserCustomerUserId: string): boolean {
  return !lead.closed_at && (role === "ADMIN" || lead.owner_id === currentUserCustomerUserId);
}

/**
 * Shared by ListView's Actions column and the Pipeline board's lead
 * cards. No lead-activity/history feature exists anywhere in this
 * codebase, so with no `onClick` this stays the genuinely disabled
 * placeholder it always was (same tooltip, same disabled state) — the
 * Pipeline board's own usage never passes one, so it's completely
 * unaffected by the branch below. When `onClick` IS provided (ListView's
 * Actions cell, wired to open the Create Task dialog for that row), the
 * icon becomes a real enabled button instead — same visual treatment,
 * different affordance, because it now does something.
 *
 * `locked` overrides the tooltip/label to the same CLOSED_LEAD_TOOLTIP
 * wording the pencil/edit icon already uses for a closed lead — passed
 * (with no `onClick`) by ListView's Actions cell for a closed lead
 * instead of wrapping this in an AddTaskDialog trigger, and by the
 * Pipeline board's card for the same lead, so a locked lead's activity
 * icon reads as "locked" specifically rather than the generic
 * "not available yet" every OTHER disabled case here still shows.
 */
function LeadActivityButton({
  contactName,
  onClick,
  locked,
}: {
  contactName: string;
  onClick?: () => void;
  locked?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={!onClick}
      onClick={onClick}
      title={locked ? CLOSED_LEAD_TOOLTIP : onClick ? undefined : "Lead activity history is not available yet"}
      aria-label={
        locked ? CLOSED_LEAD_TOOLTIP : onClick ? `Create task for ${contactName}` : `View activity for ${contactName}`
      }
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 text-neutral-400 transition-colors enabled:hover:border-neutral-300 enabled:hover:bg-neutral-50 enabled:hover:text-neutral-700 disabled:cursor-not-allowed"
    >
      <ClockIcon className="h-3.5 w-3.5" />
    </button>
  );
}

/** Everything a cell needs to render one owner, computed once per
 *  `owners` array (see PipelineView) rather than re-derived per row. */
type OwnerDisplay = { label: string; initials: string; tooltip: string };

type PipelineViewProps = {
  leads: PipelineLead[];
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
  const [editingLead, setEditingLead] = useState<PipelineLead | null>(null);

  // A local, mutable mirror of the `leads` prop — needed so the Pipeline
  // board's drag-and-drop can move a card the instant it's dropped
  // (optimistic update) rather than waiting for moveLeadStageAction's
  // round trip. Resynced from the prop whenever it changes — which is
  // exactly when it changes: revalidatePath("/sales-management") inside
  // moveLeadStageAction/updateLeadAction causes this page's Server
  // Component to refetch and hand back a new `leads` array once the
  // action actually resolves, at which point this becomes the source of
  // truth again (self-healing if the optimistic guess and the real
  // server state ever differ). List and Board views both read from this
  // same array, exactly like they already both read from one shared
  // `leads` prop — a drag on the board is instantly visible in List too.
  const [boardLeads, setBoardLeads] = useState(leads);
  // Adjust-state-during-render (React's own recommended pattern for
  // "reset state when a prop changes"), not a useEffect — this is
  // PipelineView's own state being kept in sync with its own prop, the
  // same safe case NewCatalogItemDialog's close-on-success check is
  // (see its own comment), not the unsafe case of nudging a PARENT's
  // state during a child's render.
  const [syncedLeadsProp, setSyncedLeadsProp] = useState(leads);
  if (leads !== syncedLeadsProp) {
    setSyncedLeadsProp(leads);
    setBoardLeads(leads);
  }

  const [dragError, setDragError] = useState<string | null>(null);
  useEffect(() => {
    if (!dragError) return;
    const timer = setTimeout(() => setDragError(null), 5000);
    return () => clearTimeout(timer);
  }, [dragError]);

  const stagesById = useMemo(() => new Map(stages.map((stage) => [stage.id, stage])), [stages]);
  const activeStages = useMemo(() => stages.filter((stage) => stage.status === "Active"), [stages]);

  // Computed once here (not re-derived per row/cell) and threaded down
  // to ListView/BoardView and the "All owners" filter below — the one
  // shared source for owner labels/initials/tooltips across every
  // place this component surfaces an owner.
  const ownerDisplayById = useMemo(() => {
    const labels = getOwnerDisplayLabels(owners);
    const map = new Map<string, OwnerDisplay>();
    for (const owner of owners) {
      map.set(owner.customer_user_id, {
        label: labels.get(owner.customer_user_id) ?? owner.email,
        initials: getOwnerInitials(owner),
        tooltip: getOwnerTooltip(owner),
      });
    }
    return map;
  }, [owners]);

  // Always offers the same curated list as the Create Lead form, plus any
  // real source already on a lead that falls outside it (source has no
  // CHECK constraint, so that's possible) — never fewer options than the
  // curated list, and never a source in the data that can't be filtered on.
  const availableSources = useMemo(() => {
    const extras = new Set<string>();
    for (const lead of boardLeads) {
      if (lead.source && !LEAD_SOURCES.includes(lead.source)) {
        extras.add(lead.source);
      }
    }
    return [...LEAD_SOURCES, ...Array.from(extras).sort((a, b) => a.localeCompare(b))];
  }, [boardLeads]);

  const hasActiveFilters = Boolean(search || stageFilter || ownerFilter || sourceFilter);

  const filteredLeads = useMemo(() => {
    const query = search.trim().toLowerCase();
    return boardLeads.filter((lead) => {
      if (stageFilter && lead.stage_id !== stageFilter) return false;
      if (ownerFilter === UNASSIGNED && lead.owner_id) return false;
      if (ownerFilter && ownerFilter !== UNASSIGNED && lead.owner_id !== ownerFilter) return false;
      if (sourceFilter && (lead.source ?? "") !== sourceFilter) return false;
      if (query && !`${lead.company ?? ""} ${lead.contact_name}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [boardLeads, search, stageFilter, ownerFilter, sourceFilter]);

  function resetFilters() {
    setSearch("");
    setStageFilter("");
    setOwnerFilter("");
    setSourceFilter("");
  }

  /**
   * Called by the Pipeline board on a successful drop. Optimistic:
   * moves the card (and, if the target stage is closed, mirrors the
   * closed_at the database trigger is about to set) immediately, then
   * calls moveLeadStageAction — the same authorization/validation rules
   * as updateLeadAction, just scoped to stage_id (see actions.ts) — and
   * rolls the card back to exactly where it was, with a toast, if that
   * fails for any reason (permission, a since-deactivated stage, a
   * closed-in-the-meantime lead, ...).
   */
  async function handleMoveLead(leadId: string, newStageId: string) {
    const lead = boardLeads.find((candidate) => candidate.id === leadId);
    if (!lead || lead.stage_id === newStageId) return;

    const previousStageId = lead.stage_id;
    const previousClosedAt = lead.closed_at;
    const targetStage = stagesById.get(newStageId);
    const optimisticClosedAt = targetStage?.is_closed ? new Date().toISOString() : null;

    setBoardLeads((current) =>
      current.map((candidate) =>
        candidate.id === leadId
          ? { ...candidate, stage_id: newStageId, closed_at: optimisticClosedAt }
          : candidate,
      ),
    );

    const result = await moveLeadStageAction(leadId, newStageId);
    if (!result.success) {
      setBoardLeads((current) =>
        current.map((candidate) =>
          candidate.id === leadId
            ? { ...candidate, stage_id: previousStageId, closed_at: previousClosedAt }
            : candidate,
        ),
      );
      setDragError(result.error ?? "Something went wrong moving this lead. Please try again.");
    }
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
                  {ownerDisplayById.get(owner.customer_user_id)?.label ?? owner.email}
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
          {boardLeads.length === 0 ? (
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
          ownerDisplayById={ownerDisplayById}
          role={role}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onEdit={setEditingLead}
          assignableUsers={owners}
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
          ownerDisplayById={ownerDisplayById}
          role={role}
          currentUserCustomerUserId={currentUserCustomerUserId}
          onMoveLead={handleMoveLead}
        />
      )}
    </div>

    {dragError ? (
      <div className="fixed right-6 bottom-6 z-[1100] w-full max-w-xs shadow-lg">
        <MessageBanner tone="error">{dragError}</MessageBanner>
      </div>
    ) : null}

    {editingLead ? (
      <EditLeadDialog
        key={editingLead.id}
        lead={editingLead}
        stages={stages}
        owners={owners}
        role={role}
        currentUserEmail={currentUserEmail}
        currentUserCustomerUserId={currentUserCustomerUserId}
        onClose={() => setEditingLead(null)}
      />
    ) : null}
    </>
  );
}

type ListViewProps = {
  leads: PipelineLead[];
  stagesById: Map<string, CustomerLeadStage>;
  ownerDisplayById: Map<string, OwnerDisplay>;
  role: CustomerRole;
  currentUserCustomerUserId: string;
  onEdit: (lead: PipelineLead) => void;
  /** The caller's own hierarchy-visible teammates
   *  (getVisibleTeamDirectory) — passed straight through to each row's
   *  embedded AddTaskDialog as its Assign picker's options, the exact
   *  same list/source EditLeadDialog's own "Add Task" trigger already
   *  uses (PipelineView's own `owners` prop). */
  assignableUsers: TeamDirectoryEntry[];
};

/**
 * The List View's actual data table — TanStack Table (useReactTable)
 * over the same already-filtered `leads` array PipelineView has always
 * computed (Search/Stage/Owner/Source filtering is untouched, still
 * plain client-side filtering upstream in PipelineView; this component
 * only owns how the resulting rows are rendered, sorted, and paginated).
 * Column defs are built with useMemo so cell renderers can close over
 * stagesById/ownerDisplayById/role/currentUserCustomerUserId/onEdit
 * without recreating on every render.
 *
 * Owner display now prefers name over email (see
 * features/leads/lib/owner-display.ts) — both team-directory RPCs were
 * extended to return customer_users.name, closing the gap this file
 * used to flag here as a known, out-of-scope-at-the-time limitation.
 *
 * Note: this still fetches and holds every one of the customer's leads
 * in memory (getLeadsForCustomer has no pagination) — swapping in a
 * real table library doesn't by itself address CLAUDE.md Section O's
 * server-side-pagination guidance for large lead lists; pagination here
 * is client-side over an already-fully-fetched array, a separate,
 * larger change from adding real server-side pagination.
 */
function ListView({
  leads,
  stagesById,
  ownerDisplayById,
  role,
  currentUserCustomerUserId,
  onEdit,
  assignableUsers,
}: ListViewProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });

  // Explicit reset rather than relying on TanStack Table's own
  // autoResetPageIndex default — landing on an empty page after a
  // search/filter/sort change is exactly what this guards against, and
  // being explicit here means it holds regardless of library defaults.
  useEffect(() => {
    setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
  }, [leads, sorting]);

  const columns = useMemo<ColumnDef<PipelineLead>[]>(
    () => [
      {
        id: "lead",
        header: "Lead",
        // Contact name is the bold/primary line in this app's version of
        // this column (a deliberate swap from a reference design that
        // had company on top) — sorts on that same primary text.
        accessorFn: (lead) => lead.contact_name || lead.company || "",
        cell: ({ row }) => {
          const lead = row.original;
          return (
            <>
              <p className="font-medium text-neutral-900">{lead.contact_name}</p>
              {lead.company ? <p className="text-xs text-neutral-500">{lead.company}</p> : null}
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
        accessorFn: (lead) => (lead.owner_id ? (ownerDisplayById.get(lead.owner_id)?.label ?? "") : ""),
        cell: ({ row }) => {
          const lead = row.original;
          const owner = lead.owner_id ? ownerDisplayById.get(lead.owner_id) : undefined;
          return owner && lead.owner_id ? (
            <span className="inline-flex items-center gap-2">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white shadow-sm ${getOwnerAvatarColor(lead.owner_id)}`}
              >
                {owner.initials}
              </span>
              <span className="max-w-[10rem] truncate text-neutral-700" title={owner.tooltip}>
                {owner.label}
              </span>
            </span>
          ) : (
            <span className="text-neutral-400">Unassigned</span>
          );
        },
      },
      {
        id: "updated",
        header: "Last Activity",
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
        // Activity + Edit merged into one column/cell. Edit keeps its
        // exact original handler (onEdit) and the exact original
        // isClosed/canEdit conditions — only relocated, not re-derived.
        // Activity opens the existing Create Task dialog (AddTaskDialog)
        // for an open lead, preselected to this row's own lead — mounted
        // once per row here (each instance owns its own isOpen, the same
        // self-contained pattern AddTaskDialog already uses everywhere
        // else), not a shared/global dialog, so there is nothing that
        // could carry Lead A's context into a click on Lead B's button.
        // For a CLOSED lead, both icons are locked: Activity renders the
        // same disabled LeadActivityButton the Pipeline board already
        // uses for this, not wrapped in AddTaskDialog at all (so there's
        // nothing to open), and Edit keeps its own pre-existing lock
        // branch below — both now show the identical CLOSED_LEAD_TOOLTIP.
        cell: ({ row }) => {
          const lead = row.original;
          const isClosed = Boolean(lead.closed_at);
          const canEdit = canManageLead(lead, role, currentUserCustomerUserId);

          return (
            <span className="inline-flex items-center gap-2">
              {isClosed ? (
                <LeadActivityButton contactName={lead.contact_name} locked />
              ) : (
                <AddTaskDialog
                  assignableUsers={assignableUsers}
                  currentUserCustomerUserId={currentUserCustomerUserId}
                  defaultLead={{ id: lead.id, label: formatLeadLabel(lead) }}
                  title={`Create task for ${lead.contact_name}`}
                  renderTrigger={(open) => <LeadActivityButton contactName={lead.contact_name} onClick={open} />}
                />
              )}
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => onEdit(lead)}
                  aria-label={`Edit ${lead.contact_name}`}
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                >
                  <PencilIcon className="h-3.5 w-3.5" />
                </button>
              ) : isClosed ? (
                <span
                  title={CLOSED_LEAD_TOOLTIP}
                  aria-label={CLOSED_LEAD_TOOLTIP}
                  className="inline-flex h-8 w-8 cursor-not-allowed items-center justify-center rounded-lg text-neutral-400 opacity-70"
                >
                  <LockIcon className="h-3.5 w-3.5" />
                </span>
              ) : null}
            </span>
          );
        },
      },
    ],
    [stagesById, ownerDisplayById, role, currentUserCustomerUserId, onEdit, assignableUsers],
  );

  const table = useReactTable({
    data: leads,
    columns,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  const pageCount = Math.max(table.getPageCount(), 1);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr
                key={headerGroup.id}
                className="border-b border-neutral-100 bg-neutral-50/60 text-xs font-bold tracking-wider text-neutral-700 uppercase"
              >
                {headerGroup.headers.map((header, index) => {
                  const sortDirection = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      aria-sort={
                        !header.column.getCanSort()
                          ? undefined
                          : sortDirection === "asc"
                            ? "ascending"
                            : sortDirection === "desc"
                              ? "descending"
                              : "none"
                      }
                      className={`py-3 text-center ${index === 0 ? "px-6" : "px-3"}`}
                    >
                      {header.column.getCanSort() ? (
                        // Sort icons removed per design — the header text
                        // itself stays clickable (getToggleSortingHandler
                        // is untouched) so sorting still works, aria-sort
                        // above still announces the current direction for
                        // assistive tech; only the visual chevrons are gone.
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="uppercase tracking-wider transition-colors hover:text-neutral-900 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-b border-neutral-50 transition-colors hover:bg-neutral-50">
                {row.getVisibleCells().map((cell, index) => (
                  <td
                    key={cell.id}
                    className={`py-4 text-center align-top ${index === 0 ? "px-6" : "px-3"}`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col items-center justify-between gap-3 border-t border-neutral-100 px-6 py-4 sm:flex-row">
        <div className="flex items-center gap-2 text-xs text-neutral-500">
          <label htmlFor="lead-rows-per-page">Rows per page</label>
          <select
            id="lead-rows-per-page"
            value={pagination.pageSize}
            onChange={(event) =>
              setPagination((current) => ({ ...current, pageIndex: 0, pageSize: Number(event.target.value) }))
            }
            className="h-8 rounded-lg border border-neutral-300 bg-white px-2 text-xs text-neutral-700 outline-none transition-colors hover:border-neutral-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
          >
            {[10, 15, 20].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3">
          <p className="text-xs font-medium text-neutral-600">
            Page {pagination.pageIndex + 1} of {pageCount}
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
              className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
              className="h-8 rounded-lg border border-neutral-300 px-3 text-xs font-semibold text-neutral-700 transition-colors hover:border-neutral-400 hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type BoardViewProps = {
  leads: PipelineLead[];
  stages: CustomerLeadStage[];
  ownerDisplayById: Map<string, OwnerDisplay>;
  role: CustomerRole;
  currentUserCustomerUserId: string;
  /** Called once, after a drop lands on a different column than the
   *  card's current stage — PipelineView owns the optimistic-update /
   *  rollback logic and the actual moveLeadStageAction call (see its own
   *  docstring); this component only owns the drag interaction itself. */
  onMoveLead: (leadId: string, newStageId: string) => void;
};

/**
 * Jumps between COLUMN centers on ArrowLeft/ArrowRight instead of
 * @dnd-kit/core's own default keyboard coordinate getter, which only
 * nudges the virtual drag position by 25px per key press — nowhere near
 * enough to cross a ~288px-wide Kanban column in one press, which made
 * keyboard drag-and-drop between columns effectively unusable even
 * though the sensor itself was wired up correctly. ArrowUp/ArrowDown are
 * deliberately no-ops (return undefined): columns lay out horizontally
 * only, there's no vertical column structure to move a virtual cursor
 * through, so the default vertical-nudge behavior would only produce
 * confusing dead movement.
 */
const boardKeyboardCoordinateGetter: KeyboardCoordinateGetter = (event, { context, currentCoordinates }) => {
  if (event.code !== KeyboardCode.Right && event.code !== KeyboardCode.Left) {
    return undefined;
  }

  const columnRects = context.droppableContainers
    .getEnabled()
    .map((container) => context.droppableRects.get(container.id))
    .filter((rect): rect is NonNullable<typeof rect> => Boolean(rect))
    .sort((a, b) => a.left - b.left);

  if (columnRects.length === 0) return undefined;

  const currentIndex = columnRects.findIndex(
    (rect) => currentCoordinates.x >= rect.left && currentCoordinates.x <= rect.left + rect.width,
  );
  const nearestIndex =
    currentIndex !== -1
      ? currentIndex
      : columnRects.reduce(
          (closest, rect, index) =>
            Math.abs(rect.left - currentCoordinates.x) < Math.abs(columnRects[closest].left - currentCoordinates.x)
              ? index
              : closest,
          0,
        );

  const targetIndex = event.code === KeyboardCode.Right ? nearestIndex + 1 : nearestIndex - 1;
  const targetColumn = columnRects[targetIndex];
  if (!targetColumn) return undefined;

  return {
    x: targetColumn.left + targetColumn.width / 2,
    y: targetColumn.top + targetColumn.height / 2,
  };
};

/**
 * The Pipeline board — one @dnd-kit/core DndContext wrapping a column
 * per stage (each a useDroppable drop target) and one draggable card per
 * lead (each a useDraggable drag source, disabled for any lead
 * !canManageLead — a closed lead, or one this user isn't allowed to
 * edit). Deliberately plain @dnd-kit/core, not @dnd-kit/sortable: the
 * only requirement is moving a card to a different column, not smooth
 * reordering within one, so sortable's extra machinery isn't needed.
 *
 * THE WHOLE CARD is the drag source (not a small corner handle, as an
 * earlier version of this board used) — dragging is activated by a
 * DELAY (250ms) + small movement tolerance, not a distance threshold, on
 * a single PointerSensor (which already covers both mouse and modern
 * touch — @dnd-kit's own guidance is that PointerSensor and TouchSensor
 * shouldn't normally be combined, since they'd both try to claim the
 * same pointerdown/touchstart and can behave inconsistently). A delay
 * lets an ordinary fast swipe across a card fall through to the
 * browser's native horizontal scroll — the board's scroll container is
 * untouched — while a deliberate press-and-hold-then-move is what
 * starts a drag; the card's `touch-action: manipulation` (not `none`)
 * is what leaves that native scroll gesture available at all. A
 * distance-only constraint (what an earlier version of this board used)
 * would instead hijack any swipe over 8px as a drag immediately, which
 * is what broke horizontal scrolling on touch in the first place.
 * KeyboardSensor uses a custom coordinateGetter (above) so arrow keys
 * actually jump between column centers instead of nudging 25px at a
 * time. The lifted-card visual lives entirely in <DragOverlay> (a
 * floating clone that tracks the pointer/keyboard focus); the original
 * card just fades via isDragging, it never moves itself — mixing both
 * would show two competing "moving" visuals.
 */
// Below this, a column reads as too cramped to be useful (barely more
// than its own header) — a floor under the viewport-measured height so
// a very short browser window still gets a workable column rather than
// one that's technically "fills the remaining space" but unusable.
const MIN_COLUMN_HEIGHT_PX = 320;
// Breathing room below the board before the viewport edge — without
// this the column's bottom edge (and its scrollbar) would sit flush
// against the very bottom of the browser window.
const COLUMN_BOTTOM_MARGIN_PX = 24;
// Matches BoardColumn's own pre-measurement fallback height (see its
// h-[34rem] class) — used as the *starting* state here too, so the
// very first paint (before the measurement effect below has run) isn't
// bound to a different, momentarily-wrong height that then jumps.
const FALLBACK_COLUMN_HEIGHT_PX = 544;

function BoardView({ leads, stages, ownerDisplayById, role, currentUserCustomerUserId, onMoveLead }: BoardViewProps) {
  const [activeLeadId, setActiveLeadId] = useState<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [columnHeightPx, setColumnHeightPx] = useState(FALLBACK_COLUMN_HEIGHT_PX);

  // Viewport-aware column height: measured from the board's own top edge
  // down to the bottom of the browser window, not a flat guess — a
  // short laptop screen gets shorter columns, a tall monitor gets taller
  // ones, and every column still shares the exact same height (see
  // BoardColumn). This has to live in an effect (not derived during
  // render) because it depends on the real DOM layout and
  // window.innerHeight, neither of which exists during SSR or can be
  // computed from props/state alone — the one legitimate case for
  // synchronizing React state with an external system (the browser's
  // own viewport/layout), which is exactly what useEffect is for.
  useEffect(() => {
    function measure() {
      const top = boardRef.current?.getBoundingClientRect().top;
      if (top == null) return;
      const available = window.innerHeight - top - COLUMN_BOTTOM_MARGIN_PX;
      setColumnHeightPx(Math.max(MIN_COLUMN_HEIGHT_PX, available));
    }

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinateGetter }),
  );

  const columns = stages.map((stage) => {
    const stageLeads = leads.filter((lead) => lead.stage_id === stage.id);
    const total = stageLeads.reduce((sum, lead) => sum + Number(lead.deal_value ?? 0), 0);
    return { stage, leads: stageLeads, total };
  });

  const activeLead = activeLeadId ? (leads.find((lead) => lead.id === activeLeadId) ?? null) : null;
  const activeOwner = activeLead?.owner_id ? ownerDisplayById.get(activeLead.owner_id) : undefined;

  function handleDragStart(event: DragStartEvent) {
    setActiveLeadId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveLeadId(null);
    const { active, over } = event;
    if (!over) return;
    onMoveLead(String(active.id), String(over.id));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveLeadId(null)}
    >
      <div ref={boardRef} className="flex gap-4 overflow-x-auto p-4 sm:p-6">
        {columns.map(({ stage, leads: stageLeads, total }) => (
          <BoardColumn
            key={stage.id}
            stage={stage}
            leads={stageLeads}
            total={total}
            ownerDisplayById={ownerDisplayById}
            role={role}
            currentUserCustomerUserId={currentUserCustomerUserId}
            heightPx={columnHeightPx}
          />
        ))}
      </div>

      <DragOverlay>
        {activeLead ? (
          <div className="w-64 scale-105 cursor-grabbing rounded-xl bg-white p-3.5 shadow-xl ring-1 ring-black/5">
            <LeadCardContent lead={activeLead} owner={activeOwner} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

type BoardColumnProps = {
  stage: CustomerLeadStage;
  leads: PipelineLead[];
  total: number;
  ownerDisplayById: Map<string, OwnerDisplay>;
  role: CustomerRole;
  currentUserCustomerUserId: string;
  /** Computed once in BoardView from the real viewport height (see its
   *  own comment) and passed to every column identically, so all
   *  columns share one height regardless of how many leads each has. */
  heightPx: number;
};

/**
 * ROOT CAUSE of the old vertical-scrolling behavior: this column was a
 * plain block container (no `flex flex-col`) with no height of its own —
 * only its card list had a `max-h-[32rem]` CEILING. That meant a column
 * with a handful of cards rendered much shorter than one with many
 * (Tailwind's `max-h` only caps growth, it doesn't establish a shared
 * height), so columns never lined up consistently, and nothing kept the
 * card area anchored to "whatever space is actually left under the
 * header" — it just grew until its own cap, independent of its
 * siblings. The board wrapper's default flex `align-items: stretch`
 * could stretch each column's OUTER box to match its tallest sibling,
 * but since the header/count/card-list were plain stacked block
 * children (not a flex column themselves), that stretch had nothing to
 * distribute into — the card list stayed at its own content height
 * regardless, leaving dead space rather than more scrollable room.
 *
 * FIX: the column is a flex column whose height is set from
 * BoardView's own viewport measurement (`heightPx`), not a flat guess —
 * it shrinks on a short screen and grows on a tall one, while every
 * column still shares that exact same value so they line up with each
 * other. The header block is `shrink-0` (never compressed), and the
 * card list is `flex-1 min-h-0 overflow-y-auto` — `min-h-0` is required
 * because a flex child's default `min-height` is `auto`, which refuses
 * to shrink below its own content's natural height; without it,
 * `flex-1` alone cannot make the list stop growing and start scrolling.
 * An empty stage still renders at the full measured column height (a
 * real, generously sized drop target), and its card list shows no
 * scrollbar at all — `overflow-y: auto` (via `.board-column-scroll`,
 * the same slim/rounded-thumb technique as the sidebar's own
 * `.sidebar-scroll`, just recolored for a light background) only draws
 * one when content actually overflows. Each column's scroll position is
 * ordinary native DOM scroll state, preserved automatically as long as
 * React doesn't remount the node — it doesn't, since `key={stage.id}`
 * keeps the same element across re-renders. useDroppable's setNodeRef
 * stays on this exact same outer element — only its CSS layout changed,
 * not what dnd-kit measures or how useDraggable/touch-action work on
 * the cards inside it.
 */
function BoardColumn({
  stage,
  leads,
  total,
  ownerDisplayById,
  role,
  currentUserCustomerUserId,
  heightPx,
}: BoardColumnProps) {
  // Every stage — including a closed one — stays a valid drop target;
  // only whether a card already inside it can be dragged back OUT
  // differs (see DraggableLeadCard's own `disabled`). isOver is combined
  // into a single class string (never layered on top of the base
  // background as a separate class) so the two never fight over which
  // wins in Tailwind's generated stylesheet order.
  const { isOver, setNodeRef } = useDroppable({ id: stage.id });
  const columnBg = isOver
    ? "bg-sky-50 ring-2 ring-sky-300 ring-inset"
    : `${stage.is_closed ? "bg-neutral-100/80" : "bg-neutral-50"} ring-2 ring-transparent`;

  return (
    <div
      ref={setNodeRef}
      style={{ height: heightPx }}
      className={`flex w-72 shrink-0 flex-col rounded-2xl p-3 transition-colors duration-150 ${columnBg}`}
    >
      <div className="shrink-0">
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
          {leads.length} · {currencyFormatter.format(total)}
        </p>
      </div>

      <div className="board-column-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto pr-1">
        {leads.length === 0 ? (
          <p className="px-1 py-4 text-center text-xs text-neutral-400">No leads at this stage</p>
        ) : (
          leads.map((lead) => (
            <DraggableLeadCard
              key={lead.id}
              lead={lead}
              owner={lead.owner_id ? ownerDisplayById.get(lead.owner_id) : undefined}
              canDrag={canManageLead(lead, role, currentUserCustomerUserId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

type DraggableLeadCardProps = {
  lead: PipelineLead;
  owner?: OwnerDisplay;
  /** False either because the lead is closed (a real, permanent lock)
   *  or because this user isn't its owner/an admin (the same rule
   *  ListView's Edit action already hides for) — either way, no drag
   *  listeners are attached, so there's nothing to pick up via mouse,
   *  touch, or keyboard. This is a UX convenience only, same as
   *  everywhere else this rule appears: moveLeadStageAction re-checks it
   *  server-side regardless. */
  canDrag: boolean;
};

/**
 * The whole card is the drag source — attributes/listeners go on the
 * same node as setNodeRef, not a separate corner handle. An earlier
 * version of this board used a small dedicated handle specifically to
 * keep touch-action: none scoped away from the rest of the card, but
 * that meant grabbing the card itself (the natural, expected gesture —
 * "pick up the card and drag it") did nothing at all, which is what
 * actually made drag-and-drop appear broken. The delay-based
 * PointerSensor activation constraint (see BoardView) is what protects
 * horizontal scrolling instead, so the whole card can safely be the
 * draggable surface again.
 */
function DraggableLeadCard({ lead, owner, canDrag }: DraggableLeadCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: lead.id,
    disabled: !canDrag,
  });

  return (
    <div
      ref={setNodeRef}
      {...(canDrag ? attributes : null)}
      {...(canDrag ? listeners : null)}
      aria-label={canDrag ? `Drag ${lead.contact_name} to a different stage` : undefined}
      title={!canDrag && lead.closed_at ? BOARD_LOCKED_CARD_TOOLTIP : undefined}
      className={`touch-manipulation rounded-xl bg-white p-3.5 shadow-sm ring-1 ring-black/5 transition-all duration-200 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none ${
        isDragging
          ? "opacity-40"
          : canDrag
            ? "cursor-grab hover:-translate-y-0.5 hover:shadow-md active:cursor-grabbing"
            : "cursor-default"
      }`}
    >
      <LeadCardContent lead={lead} owner={owner} />
    </div>
  );
}

/** The card's visible content, shared between the in-column
 *  DraggableLeadCard and the DragOverlay's floating clone — so the
 *  "lifted" card the user sees following their pointer/focus is exactly
 *  the same content, not a re-derived approximation of it. */
function LeadCardContent({ lead, owner }: { lead: PipelineLead; owner?: OwnerDisplay }) {
  return (
    <>
      <p
        className="flex items-center gap-1.5 truncate text-sm font-semibold text-neutral-900"
        title={lead.contact_name}
      >
        {lead.closed_at ? (
          <LockIcon className="h-3 w-3 shrink-0 text-neutral-400" aria-label={BOARD_LOCKED_CARD_TOOLTIP} />
        ) : null}
        {lead.contact_name}
      </p>
      {lead.company ? (
        <p className="truncate text-xs text-neutral-500" title={lead.company}>
          {lead.company}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          {owner && lead.owner_id ? (
            <span
              title={owner.tooltip}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-semibold text-white shadow-sm ${getOwnerAvatarColor(lead.owner_id)}`}
            >
              {owner.initials}
            </span>
          ) : null}
          <span className="text-sm font-semibold text-neutral-900">
            {lead.deal_value === null ? (
              <span className="text-neutral-300">—</span>
            ) : (
              currencyFormatter.format(lead.deal_value)
            )}
          </span>
        </span>
        <LeadActivityButton contactName={lead.contact_name} locked={Boolean(lead.closed_at)} />
      </div>
      {lead.source ? (
        <p className="mt-2 text-[10px] font-semibold tracking-wide text-neutral-400 uppercase">{lead.source}</p>
      ) : null}
    </>
  );
}
