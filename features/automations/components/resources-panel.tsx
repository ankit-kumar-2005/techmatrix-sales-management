"use client";

import {
  ACTION_GET_RECORDS,
  ACTION_LOOP,
  ASSIGNMENT_SET_VARIABLE,
  getRegistryEntry,
} from "../registry/definitions";
import type { BuilderNode } from "./workflow-node";
import type { AutomationNodeKind } from "@/types/automation";

type ResourcesPanelProps = {
  nodes: BuilderNode[];
  onSelectNode: (nodeId: string) => void;
  onAdd: (kind: AutomationNodeKind, type: string) => void;
  disabled: boolean;
};

type ResourceRow = {
  name: string;
  kind: "Scalar" | "Collection" | "Record (per iteration)";
  detail: string;
  nodeId: string;
  nodeLabel: string;
};

/**
 * THE RESOURCES PANEL — organizational UI over what Phase 2 already
 * built, not a new place variables actually live. Every row here is
 * read STRAIGHT from a real node's own config (an Assignment's
 * `assignments[].variable`, a Get Records' `resultVariable`, a Loop's
 * `itemVariable`) — there is no separate "variable" record anywhere,
 * stored or otherwise, matching this app's own long-standing rule that
 * a workflow variable never leaves the canvas it is defined on. Rename
 * or delete the node that owns a row, and the row is simply gone next
 * render — this panel has nothing of its own to keep in sync.
 *
 * "Create a new one directly from this panel" (the one genuinely new
 * capability here) is the SAME node-creation `onAdd` the sidebar
 * palette already calls — a plain, unconnected add — scoped to just the
 * three node kinds that can ever produce a variable, so an admin who
 * thinks in terms of "I need a variable" has a direct path to it
 * without first learning that a variable is really a side effect of a
 * Set a Variable, Get Records, or Loop step.
 */
export function ResourcesPanel({ nodes, onSelectNode, onAdd, disabled }: ResourcesPanelProps) {
  const rows: ResourceRow[] = [];

  for (const node of nodes) {
    const nodeLabel = getRegistryEntry(node.data.type)?.label ?? node.data.type;

    if (node.data.type === ASSIGNMENT_SET_VARIABLE) {
      const assignments = Array.isArray(node.data.config.assignments) ? (node.data.config.assignments as Array<{ variable?: string }>) : [];
      for (const assignment of assignments) {
        if (!assignment.variable) continue;
        rows.push({
          name: assignment.variable,
          kind: "Scalar",
          detail: `{{var.${assignment.variable}}}`,
          nodeId: node.id,
          nodeLabel,
        });
      }
    }

    if (node.data.type === ACTION_GET_RECORDS) {
      const resultVariable = typeof node.data.config.resultVariable === "string" ? node.data.config.resultVariable : "";
      const object = typeof node.data.config.object === "string" ? node.data.config.object : "record";
      if (resultVariable) {
        rows.push({
          name: resultVariable,
          kind: "Collection",
          detail: `Every matching ${object}, for a Loop to go through`,
          nodeId: node.id,
          nodeLabel,
        });
      }
    }

    if (node.data.type === ACTION_LOOP) {
      const itemVariable = typeof node.data.config.itemVariable === "string" ? node.data.config.itemVariable : "";
      const collectionVariable = typeof node.data.config.collectionVariable === "string" ? node.data.config.collectionVariable : "";
      if (itemVariable) {
        rows.push({
          name: itemVariable,
          kind: "Record (per iteration)",
          detail: `{{${itemVariable}.fieldName}} — the current item from "${collectionVariable || "…"}"`,
          nodeId: node.id,
          nodeLabel,
        });
      }
    }
  }

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-y-auto p-3">
      <section>
        <h3 className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">Resources</h3>
        <p className="mt-0.5 text-[11px] leading-relaxed text-neutral-400">
          Every named variable this workflow currently defines, wherever it was set.
        </p>

        {rows.length === 0 ? (
          <p className="mt-3 rounded-lg bg-neutral-50 p-3 text-[11px] leading-relaxed text-neutral-400">
            Nothing yet. Add a step below, or use &ldquo;Set a variable&rdquo; / &ldquo;Get records&rdquo; /
            &ldquo;Loop through records&rdquo; from the palette.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {rows.map((row, index) => (
              <li key={`${row.nodeId}-${row.name}-${index}`}>
                <button
                  type="button"
                  onClick={() => onSelectNode(row.nodeId)}
                  className="w-full rounded-lg border border-neutral-200 bg-white px-2.5 py-2 text-left transition-colors hover:border-sky-400 hover:bg-sky-50/50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs font-semibold text-neutral-800">{row.name}</span>
                    <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-neutral-500 uppercase">
                      {row.kind}
                    </span>
                  </div>
                  <span className="mt-0.5 block truncate text-[11px] leading-snug text-neutral-500">{row.detail}</span>
                  <span className="mt-0.5 block text-[10px] text-neutral-400">Set by &ldquo;{row.nodeLabel}&rdquo;</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3 className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">Create a new one</h3>
        <ul className="mt-2 flex flex-col gap-1.5">
          {(
            [
              { kind: "assignment" as const, type: ASSIGNMENT_SET_VARIABLE, help: "A scalar value from a lead field or typed text." },
              { kind: "action" as const, type: ACTION_GET_RECORDS, help: "A collection of matching Lead/Task/Contact records." },
              { kind: "action" as const, type: ACTION_LOOP, help: "Go through a collection one item at a time." },
            ] as const
          ).map((option) => {
            const entry = getRegistryEntry(option.type);
            if (!entry) return null;
            return (
              <li key={option.type}>
                <button
                  type="button"
                  onClick={() => onAdd(option.kind, option.type)}
                  disabled={disabled}
                  title={option.help}
                  className="w-full rounded-lg border border-dashed border-neutral-300 px-2.5 py-2 text-left transition-colors hover:border-sky-400 hover:bg-sky-50/50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <span className="block text-xs font-semibold text-sky-700">+ {entry.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-neutral-500">{option.help}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
