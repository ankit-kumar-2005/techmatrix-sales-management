"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps, type Edge } from "@xyflow/react";

export type InsertableEdgeData = {
  /** Screen-position anchor for the insert popover — the same shape
   *  WorkflowNodeCard's open-output "+" chip hands the builder, so both
   *  paths feed one insertion handler. Never persisted: edge `data` is
   *  not part of the stored definition (see automation-builder's
   *  fromFlow, which reads only id/source/target/sourceHandle). */
  onRequestInsert?: (edgeId: string, anchor: { x: number; y: number }) => void;
  [key: string]: unknown;
};

export type InsertableEdge = Edge<InsertableEdgeData, "insertable">;

/**
 * An edge with a "+" at its own midpoint — what lets an admin splice a
 * new step into the MIDDLE of an existing connection, not just append
 * one at the end. automation-builder.tsx owns what clicking it actually
 * does (see handleInsert's "edge" branch): this component only draws
 * the button and reports where it was clicked.
 */
export function InsertableEdgeType({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
  selected,
  label,
}: EdgeProps<InsertableEdge>) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={{ ...style, strokeWidth: selected ? 2.5 : 1.5 }} />
      {/* The branch this edge leaves its source from — "yes"/"no" for a
          condition, an outcome's own name (or "otherwise") for a
          decision — carried on the edge itself (see labelForBranch in
          automation-builder.tsx) rather than listed inside the source
          node, so the label sits on the actual line it describes. Purely
          informational: never the pointerEvents:"all" treatment the "+"
          button needs, so it never competes for a click. */}
      {typeof label === "string" && label ? (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 18}px)`,
              pointerEvents: "none",
            }}
            className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-neutral-500 shadow-sm ring-1 ring-black/5"
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      ) : null}
      {data?.onRequestInsert ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              data.onRequestInsert?.(id, { x: event.clientX, y: event.clientY });
            }}
            title="Insert a step here"
            aria-label="Insert a step here"
            style={{
              position: "absolute",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: "all",
            }}
            // nodrag nopan — REQUIRED, not decorative. EdgeLabelRenderer's
            // portal has pointer-events:none by default specifically so it
            // never steals the canvas's own pan/drag gestures; React Flow's
            // own docs are explicit that an interactive element inside it
            // needs BOTH pointerEvents:"all" (above) AND the `nopan` class,
            // or a click here is swallowed by the pane's pan-gesture
            // handling before it ever reaches this button's onClick — which
            // is exactly the bug this comment is here to stop someone from
            // reintroducing (see the follow-up that caught it: the "+" was
            // visibly rendered and completely unresponsive to a real click).
            //
            // DELIBERATELY NO hover:scale-* AND NO transition on transform
            // here (unlike an ordinary button) — this element's `transform`
            // is a JS-computed inline style (labelX/labelY, above), and a
            // hover-triggered CSS scale genuinely changes its rendered
            // screen position while animating, not just its size (verified
            // with a real Chromium press-and-hold: the button visibly
            // drifted out from under a stationary cursor over the
            // transition's duration, so a real human's click — which is
            // never instantaneous — could land after the target had
            // already moved). A plain color/opacity hover is enough
            // feedback without moving the hit target under the cursor.
            className="nodrag nopan flex h-5 w-5 items-center justify-center rounded-full border-2 border-white bg-neutral-400 text-white opacity-70 shadow-sm hover:bg-sky-600 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-sky-500/50 focus-visible:outline-none"
          >
            <PlusIcon />
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth={3}>
      <path d="M10 4v12M4 10h12" strokeLinecap="round" />
    </svg>
  );
}
