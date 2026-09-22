"use client";

import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import {
  ACTION_CONTACT_CREATE,
  ACTION_CONTACT_DEACTIVATE,
  ACTION_CONTACT_UPDATE,
  ACTION_TASK_DEACTIVATE,
  ACTION_TASK_UPDATE,
  DECISION_DEFAULT_BRANCH,
  getRegistryEntry,
  type DecisionOutcome,
} from "../registry/definitions";
import type { AutomationNodeKind } from "@/types/automation";

/** One of a node's outputs with no outgoing edge yet — what draws the
 *  contextual "+" chip at that exact handle. `branch` is null for a
 *  plain single-output kind (trigger/assignment/action) and the branch
 *  id (e.g. "true", or a decision outcome's own id / "default") for a
 *  branching kind. */
export type OpenOutput = { branch: string | null; top: string };

/**
 * React Flow requires node data to be an index-signature record, so the
 * signature is widened here rather than at every call site. The named
 * fields are what this app actually reads.
 */
export type BuilderNodeData = {
  kind: AutomationNodeKind;
  type: string;
  config: Record<string, unknown>;
  /** Set by the builder from the live validation result, so a node that
   *  is the reason Save is blocked is visibly the reason. */
  hasIssue: boolean;
  /** This node's outputs that currently lead nowhere — computed by the
   *  builder from its own edges. Empty on a node the builder has not
   *  decorated yet (e.g. mid-render). */
  openOutputs?: OpenOutput[];
  /** Clicking an open-output "+" chip. Screen coordinates so the
   *  builder can position its insertion popover without this component
   *  knowing anything about that popover. Carried as a function on node
   *  data — never persisted, since only id/kind/type/config/position
   *  reach the stored definition (see automation-builder's fromFlow). */
  onRequestInsert?: (branch: string | null, anchor: { x: number; y: number }) => void;
  [key: string]: unknown;
};

export type BuilderNode = Node<BuilderNodeData, "automation">;

// ---------------------------------------------------------------------
// The End marker — a PURE CANVAS AFFORDANCE, never a WorkflowNode
// ---------------------------------------------------------------------
//
// Salesforce's flow diagrams always show an explicit End box; this is
// the same idea, reinterpreted for a canvas where "the engine can only
// execute what the registry backs" is a hard rule (see the design brief
// that governs this whole feature). An End marker has no registry
// entry, no config, and nothing to validate or run — it is deliberately
// NOT a `kind` in `AutomationNodeKind`, which stays exactly
// trigger/condition/decision/assignment/action, untouched. It exists
// only in React Flow's own node/edge state, and automation-builder's
// fromFlow() strips it (and any edge touching it) before that state
// ever becomes the WorkflowDefinition that gets validated, saved, or
// executed. Deleting one, or never adding one, changes nothing about
// what a workflow does — it only changes what the canvas looks like
// while building it.

/** The React Flow node "type" string for an End marker — distinct from
 *  "automation" so NODE_TYPES can route it to EndNodeCard instead of
 *  WorkflowNodeCard. */
export const AUTOMATION_END_TYPE = "automation-end";

export type EndNodeData = { kind: "end" };
export type EndFlowNode = Node<EndNodeData, "automation-end">;

/** Everything that can appear in the canvas's own node array — a real,
 *  persistable node, or the purely-visual End marker. */
export type CanvasNode = BuilderNode | EndFlowNode;

export function isEndNode(node: CanvasNode): node is EndFlowNode {
  return node.type === AUTOMATION_END_TYPE;
}

/** The terminal marker itself — a small pill, deliberately styled
 *  UNLIKE a real step (dashed border, no coloured kind badge, no
 *  outputs) so it reads as "this is where a path currently stops", not
 *  as a fifth kind of step sitting alongside trigger/condition/action. */
export function EndNodeCard({ selected }: NodeProps<EndFlowNode>) {
  return (
    <div
      className={`flex w-32 items-center justify-center gap-1.5 rounded-full border-2 border-dashed px-3 py-2 text-[11px] font-bold tracking-wide uppercase transition-colors ${
        selected ? "border-sky-400 bg-sky-50 text-sky-700" : "border-neutral-300 bg-neutral-50 text-neutral-400"
      }`}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <EndDotIcon />
      End
    </div>
  );
}

function EndDotIcon() {
  return (
    <svg viewBox="0 0 12 12" fill="currentColor" className="h-2.5 w-2.5">
      <circle cx="6" cy="6" r="5" />
    </svg>
  );
}

/** One visual identity per node kind, reusing colours this app already
 *  assigns meaning to: the brand gradient for the thing that starts a
 *  workflow, amber for a decision, violet for a temporary value, teal
 *  for something that actually happens. */
const KIND_STYLE: Record<AutomationNodeKind, { badge: string; ring: string; stroke: string; label: string }> = {
  trigger: {
    badge: "bg-gradient-to-br from-blue-600 to-violet-600 text-white",
    ring: "ring-blue-200",
    stroke: "#bfdbfe", // blue-200 — the Decision diamond's SVG outline can't use a Tailwind class (see its own note)
    label: "WHEN",
  },
  condition: { badge: "bg-amber-100 text-amber-800", ring: "ring-amber-200", stroke: "#fde68a", label: "ONLY IF" },
  decision: { badge: "bg-orange-100 text-orange-800", ring: "ring-orange-200", stroke: "#fed7aa", label: "DECIDE" },
  assignment: { badge: "bg-violet-100 text-violet-800", ring: "ring-violet-200", stroke: "#ddd6fe", label: "SET" },
  action: { badge: "bg-teal-100 text-teal-800", ring: "ring-teal-200", stroke: "#99f6e4", label: "THEN" },
};

/** Fixed hex equivalents of the two other outline colours a node can be
 *  in (selected / has a validation issue) — needed alongside
 *  `KIND_STYLE.stroke` because the Decision diamond strokes an SVG
 *  polygon, and an SVG `stroke` attribute cannot reference a Tailwind
 *  class the way `border-*`/`ring-*` can elsewhere in this file. */
const DECISION_STROKE_SELECTED = "#0ea5e9"; // sky-500
const DECISION_STROKE_ISSUE = "#fca5a5"; // red-300

/** Shared handle styling — a visible, touch-sized target. React Flow's
 *  default is 6px, which is very hard to hit on a laptop trackpad and
 *  impossible on a touchscreen. */
const HANDLE_CLASS = "!h-3 !w-3 !border-2 !border-white !bg-neutral-400";

/** Evenly-spaced vertical percentages for N output handles, kept inside
 *  a band so the topmost/bottommost handle is never flush with the
 *  node's rounded corner. Two handles reuse the exact 38%/68% split the
 *  original yes/no condition always used, so that shape is unchanged. */
export function handlePositions(count: number): string[] {
  if (count <= 1) return ["50%"];
  const top = 22;
  const bottom = 84;
  const step = (bottom - top) / (count - 1);
  return Array.from({ length: count }, (_, i) => `${Math.round(top + step * i)}%`);
}

/** Where a handle sits on the DECISION DIAMOND's own silhouette, for a
 *  given vertical percentage from `handlePositions` (reused as the
 *  fraction of the way down the diamond's RIGHT-hand outline, top vertex
 *  to bottom vertex — not a plain y-coordinate). A plain rectangle's
 *  right edge is a vertical line, so "handle N is Y% down, flush right"
 *  is enough; a diamond's right side is two sloped edges meeting at a
 *  single rightmost point, so a handle anywhere except the exact
 *  vertical centre needs its OWN x position too, or it renders floating
 *  outside the visible shape. */
function diamondHandlePoint(topPercent: string): { left: string; top: string } {
  const t = Number.parseFloat(topPercent) / 100;
  const x = t <= 0.5 ? 50 + 100 * t : 150 - 100 * t;
  return { left: `${x}%`, top: `${100 * t}%` };
}

/**
 * A node on the canvas.
 *
 * Reads its label and summary from the REGISTRY, not from stored text —
 * so renaming a capability updates every existing workflow that uses it
 * without a migration, and a node whose type is no longer registered
 * says so on the canvas instead of rendering as a blank box.
 */
export function WorkflowNodeCard({ data, selected }: NodeProps<BuilderNode>) {
  const entry = getRegistryEntry(data.type);
  const style = KIND_STYLE[data.kind];
  const openOutputs = data.openOutputs ?? [];

  function requestInsert(event: ReactMouseEvent<HTMLButtonElement>, branch: string | null) {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    data.onRequestInsert?.(branch, { x: rect.right, y: rect.top + rect.height / 2 });
  }

  const outputs = outputHandles(data);
  const isDecision = data.kind === "decision";

  // The "+" chip is identical for both shapes — only WHERE it sits
  // (a plain right-flush top%, or a point on the diamond's own outline)
  // differs, so it is built once here and placed by whichever shape
  // below actually renders.
  const plusChip = (open: OpenOutput, style_: CSSProperties) =>
    data.onRequestInsert ? (
      <button
        key={open.branch ?? "out"}
        type="button"
        onClick={(event) => requestInsert(event, open.branch)}
        title="Add the next step"
        aria-label="Add the next step"
        style={style_}
        // nodrag nopan — REQUIRED: this button sits inside a
        // draggable React Flow node, and without `nodrag` a click
        // here is consumed as the start of a node-drag gesture
        // instead of reaching onClick (the exact bug the edge "+"
        // button shipped with — see its own note in
        // insertable-edge.tsx). Deliberately no hover:scale/
        // transition-transform, for the same reason that one has
        // none: this button's position is set via a live inline
        // `top` (from `open.top`, recomputed every render), and a
        // hover-triggered scale was confirmed elsewhere in this file
        // to visibly shift a similarly-positioned button out from
        // under a held-down cursor before the click completed.
        className="nodrag nopan absolute z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-sky-600 text-white shadow-sm hover:bg-sky-700 focus-visible:ring-2 focus-visible:ring-sky-500/50 focus-visible:outline-none"
      >
        <PlusIcon />
      </button>
    ) : null;

  if (isDecision) {
    // A DIAMOND, not a rectangle — a shape/layout convention only (see
    // this file's own history for why): two stacked divs, a decorative
    // rhombus silhouette behind (clip-path, no rotation math needed) and
    // the real content in front, inset far enough that text never
    // reaches the clipped corners. Each outcome's own label now lives on
    // ITS OWN EDGE (see insertable-edge.tsx) rather than as a list inside
    // the shape — there is no room for a list inside a diamond, and a
    // label sitting on the actual branch line it belongs to is more
    // legible than a list that requires matching colours/order back to
    // handles by eye.
    const strokeColor = selected ? DECISION_STROKE_SELECTED : data.hasIssue ? DECISION_STROKE_ISSUE : style.stroke;

    return (
      <div className="relative" style={{ width: 300, height: 190 }}>
        {/*
          An SVG polygon, not a `clip-path`'d div — `clip-path` (and
          `ring`/box-shadow before it, tried first) only clips whatever
          was ALREADY PAINTED for the original rectangular box, which
          means a border or shadow drawn along that rectangle's straight
          sides survives clipping only as four near-invisible slivers at
          the points where the diamond happens to touch the rectangle
          (confirmed by screenshotting a real render: both attempts were
          simply invisible). An SVG `<polygon>`'s `stroke` is drawn ALONG
          the polygon's own path, not clipped from something else, so it
          traces the diamond's actual outline correctly.
        */}
        <svg
          className="absolute inset-0 drop-shadow-sm"
          width={300}
          height={190}
          viewBox="0 0 300 190"
          aria-hidden="true"
        >
          <polygon points="150,2 298,95 150,188 2,95" fill="white" stroke={strokeColor} strokeWidth={2} />
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center px-16 py-9 text-center">
          <div className="flex items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide ${style.badge}`}>
              {style.label}
            </span>
            {data.hasIssue ? (
              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[8px] font-bold tracking-wide text-red-700">
                NEEDS ATTENTION
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 line-clamp-2 text-sm font-semibold text-neutral-900">{entry?.label ?? data.type}</p>
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-neutral-500">
            {entry ? summarise(data) : "This step is no longer available in this app."}
          </p>
        </div>

        <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />

        {outputs.map((output, index) => {
          const point = diamondHandlePoint(handlePositions(outputs.length)[index]);
          return (
            <Handle
              key={output.branch ?? "out"}
              type="source"
              id={output.branch ?? undefined}
              position={Position.Right}
              style={point}
              className={`${HANDLE_CLASS} ${output.color ?? ""}`}
            />
          );
        })}

        {openOutputs.map((open) => {
          const point = diamondHandlePoint(open.top);
          return plusChip(open, { left: point.left, top: point.top, transform: "translate(4px, -50%)" });
        })}
      </div>
    );
  }

  return (
    <div
      className={`relative w-60 rounded-xl bg-white p-3 shadow-sm ring-1 transition-shadow ${
        selected ? "ring-2 ring-sky-500" : data.hasIssue ? "ring-2 ring-red-300" : `ring-black/5 ${style.ring}`
      }`}
    >
      {/* Trigger has no input: nothing can lead into the start of a
          workflow, and validateWorkflow() refuses any edge that tries. */}
      {data.kind !== "trigger" ? (
        <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      ) : null}

      <div className="flex items-center gap-2">
        <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold tracking-wide ${style.badge}`}>
          {style.label}
        </span>
        {data.hasIssue ? (
          <span className="rounded bg-red-50 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-red-700">
            NEEDS ATTENTION
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 text-sm font-semibold text-neutral-900">{entry?.label ?? data.type}</p>
      <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-neutral-500">
        {entry ? summarise(data) : "This step is no longer available in this app."}
      </p>

      {outputs.length > 1 ? (
        <div className="mt-2 flex flex-col gap-0.5 text-[9px] font-bold tracking-wide text-neutral-400">
          {outputs.map((output) => (
            <div key={output.branch ?? "out"} className="truncate" title={output.label}>
              &rarr; {output.label}
            </div>
          ))}
        </div>
      ) : null}

      {outputs.map((output, index) => (
        <Handle
          key={output.branch ?? "out"}
          type="source"
          id={output.branch ?? undefined}
          position={Position.Right}
          style={outputs.length > 1 ? { top: handlePositions(outputs.length)[index] } : undefined}
          className={`${HANDLE_CLASS} ${output.color ?? ""}`}
        />
      ))}

      {/* Contextual "+" — one per output currently leading nowhere, at
          the same vertical position as that output's own handle. This
          is what lets an admin extend the workflow without dragging a
          connection by hand. */}
      {openOutputs.map((open) => plusChip(open, { top: open.top, right: "-0.75rem", transform: "translateY(-50%)" }))}
    </div>
  );
}

export type OutputHandle = { branch: string | null; label: string; color?: string };

/** What outputs this node actually has, by kind — the single place that
 *  decides "how many handles, with which ids" so the canvas rendering,
 *  the open-output computation in automation-builder, and
 *  validateWorkflow's branch rules can never quietly disagree about the
 *  shape of one node's outputs. */
export function outputHandles(data: BuilderNodeData): OutputHandle[] {
  if (data.kind === "condition") {
    return [
      { branch: "true", label: "YES", color: "!bg-teal-500" },
      { branch: "false", label: "NO", color: "!bg-neutral-400" },
    ];
  }
  if (data.kind === "decision") {
    const outcomes = Array.isArray(data.config.outcomes) ? (data.config.outcomes as DecisionOutcome[]) : [];
    return [
      ...outcomes.map((outcome) => ({ branch: outcome.id, label: outcome.name || "Outcome", color: "!bg-orange-500" })),
      { branch: DECISION_DEFAULT_BRANCH, label: "Otherwise", color: "!bg-neutral-400" },
    ];
  }
  // trigger, assignment, action: exactly one, unbranched output.
  return [{ branch: null, label: "Next" }];
}

/** A one-line description of what this node is configured to do, built
 *  from its own config. Falls back to the registry's generic
 *  description when nothing has been configured yet. */
function summarise(data: BuilderNodeData): string {
  const entry = getRegistryEntry(data.type);
  const config = data.config;

  if (data.kind === "trigger") {
    // Read the "Run when" option's own label rather than re-deriving it —
    // Task/Contact triggers give that field object-correct labels ("A
    // task is created") by mapping over the same EVENT_TYPE_OPTIONS Lead
    // uses, so reusing it here (instead of hardcoding "lead") is what
    // keeps this summary in sync with whichever object this trigger
    // actually watches.
    const eventTypeField = entry?.fields.find((field) => field.name === "eventType");
    const eventLabel = eventTypeField?.options?.find((option) => option.value === config.eventType)?.label ?? "Runs";
    const hasEntryCondition = config.entryCondition && typeof config.entryCondition === "object";
    return `${eventLabel}${hasEntryCondition ? ", matching your entry condition" : ""}`;
  }

  if (data.kind === "decision") {
    const outcomes = Array.isArray(config.outcomes) ? (config.outcomes as DecisionOutcome[]) : [];
    return outcomes.length > 0
      ? `${outcomes.length} outcome${outcomes.length === 1 ? "" : "s"}, plus Otherwise`
      : "No outcomes configured yet";
  }

  if (data.kind === "assignment") {
    const list = Array.isArray(config.assignments) ? (config.assignments as Array<{ variable?: string }>) : [];
    const names = list.map((entryValue) => entryValue.variable).filter(Boolean);
    return names.length > 0 ? `Sets ${names.join(", ")}` : "No variables configured yet";
  }

  if (data.kind === "condition") {
    if (Array.isArray(config.sources)) {
      const sources = config.sources as string[];
      return sources.length > 0 ? `Source is ${sources.join(" or ")}` : "Pick at least one source";
    }
    if (typeof config.expected === "string") {
      return config.expected === "yes" ? "The lead already has an owner" : "The lead has no owner yet";
    }
    if (config.root && typeof config.root === "object") {
      const root = config.root as { match?: string; rules?: unknown[] };
      const count = Array.isArray(root.rules) ? root.rules.length : 0;
      return count > 0
        ? `${count} condition${count === 1 ? "" : "s"}, matching ${root.match === "any" ? "any" : "all"}`
        : "No conditions configured yet";
    }
  }

  if (data.kind === "action") {
    if (data.type === ACTION_TASK_DEACTIVATE || data.type === ACTION_CONTACT_DEACTIVATE) {
      return typeof config.sourceNodeId === "string" && config.sourceNodeId ? "Deactivates the record from an earlier step" : "Pick which step's record to deactivate";
    }

    if (data.type === ACTION_TASK_UPDATE || data.type === ACTION_CONTACT_UPDATE) {
      const fieldKeys = data.type === ACTION_TASK_UPDATE ? ["subject", "description", "priority", "due_date", "type", "status"] : ["name", "company", "title", "email", "phone"];
      const changed = fieldKeys.filter((key) => typeof config[key] === "string" && config[key]);
      const changes = [...changed, config.assignmentMode !== "None" && config.assignmentMode !== undefined ? "owner" : null].filter(Boolean);
      if (!config.sourceNodeId) return "Pick which step's record to update";
      return changes.length > 0 ? `Updates ${changes.join(", ")}` : "No fields configured yet";
    }

    if (data.type === ACTION_CONTACT_CREATE) {
      const mode = config.assignmentMode === "RoundRobin" ? "round-robin" : "a fixed person";
      return typeof config.name === "string" && config.name ? `"${config.name}" — to ${mode}` : "Pick a name and an assignee";
    }

    if (typeof config.subject === "string" && config.subject) {
      const mode = config.assignmentMode === "RoundRobin" ? "round-robin" : "a fixed person";
      return `"${config.subject}" — to ${mode}`;
    }
    if (config.assignmentMode !== undefined) {
      // lead.update's own shape — assignmentMode is present even when
      // nothing has been configured, unlike task.create's subject.
      const changes = [
        typeof config.nextStep === "string" && config.nextStep ? "next step" : null,
        typeof config.dealValue === "string" && config.dealValue ? "deal value" : null,
        typeof config.status === "string" && config.status ? "status" : null,
        config.assignmentMode !== "None" ? "owner" : null,
      ].filter(Boolean);
      return changes.length > 0 ? `Updates ${changes.join(", ")}` : "No fields configured yet";
    }
  }

  return entry?.description ?? "";
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth={2.5}>
      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
    </svg>
  );
}
