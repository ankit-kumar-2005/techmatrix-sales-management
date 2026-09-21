"use client";

import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { getRegistryEntry } from "../registry/definitions";
import type { AutomationNodeKind } from "@/types/automation";

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
  [key: string]: unknown;
};

export type BuilderNode = Node<BuilderNodeData, "automation">;

/** One visual identity per node kind, reusing colours this app already
 *  assigns meaning to: the brand gradient for the thing that starts a
 *  workflow, amber for a decision, teal for something that actually
 *  happens. */
const KIND_STYLE: Record<AutomationNodeKind, { badge: string; ring: string; label: string }> = {
  trigger: {
    badge: "bg-gradient-to-br from-blue-600 to-violet-600 text-white",
    ring: "ring-blue-200",
    label: "WHEN",
  },
  condition: { badge: "bg-amber-100 text-amber-800", ring: "ring-amber-200", label: "ONLY IF" },
  action: { badge: "bg-teal-100 text-teal-800", ring: "ring-teal-200", label: "THEN" },
};

/** Shared handle styling — a visible, touch-sized target. React Flow's
 *  default is 6px, which is very hard to hit on a laptop trackpad and
 *  impossible on a touchscreen. */
const HANDLE_CLASS = "!h-3 !w-3 !border-2 !border-white !bg-neutral-400";

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

  return (
    <div
      className={`w-60 rounded-xl bg-white p-3 shadow-sm ring-1 transition-shadow ${
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

      {data.kind === "condition" ? (
        <>
          {/* Two labelled outputs. The handle id IS the branch value
              stored on the edge, so there is no mapping table to keep in
              sync between what is drawn and what is executed. */}
          <div className="mt-2 flex justify-between text-[9px] font-bold tracking-wide text-neutral-400">
            <span>YES &uarr;</span>
            <span>&darr; NO</span>
          </div>
          <Handle
            type="source"
            id="true"
            position={Position.Right}
            style={{ top: "38%" }}
            className={`${HANDLE_CLASS} !bg-teal-500`}
          />
          <Handle
            type="source"
            id="false"
            position={Position.Right}
            style={{ top: "68%" }}
            className={`${HANDLE_CLASS} !bg-neutral-400`}
          />
        </>
      ) : (
        <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />
      )}
    </div>
  );
}

/** A one-line description of what this node is configured to do, built
 *  from its own config. Falls back to the registry's generic
 *  description when nothing has been configured yet. */
function summarise(data: BuilderNodeData): string {
  const entry = getRegistryEntry(data.type);
  const config = data.config;

  if (data.kind === "trigger") {
    const sources = Array.isArray(config.sources) ? (config.sources as string[]) : [];
    return sources.length > 0 ? `A new lead from ${sources.join(", ")}` : "A new lead from any source";
  }

  if (data.kind === "condition") {
    if (Array.isArray(config.sources)) {
      const sources = config.sources as string[];
      return sources.length > 0 ? `Source is ${sources.join(" or ")}` : "Pick at least one source";
    }
    if (typeof config.expected === "string") {
      return config.expected === "yes" ? "The lead already has an owner" : "The lead has no owner yet";
    }
  }

  if (data.kind === "action" && typeof config.subject === "string" && config.subject) {
    const mode = config.assignmentMode === "RoundRobin" ? "round-robin" : "a fixed person";
    return `"${config.subject}" — to ${mode}`;
  }

  return entry?.description ?? "";
}
