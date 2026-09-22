import dagre from "@dagrejs/dagre";
import { isEndNode, type CanvasNode } from "../components/workflow-node";
import type { Edge } from "@xyflow/react";

/**
 * NOMINAL node sizes for the layout algorithm only — dagre needs a
 * width/height per node to place it, and asking it to re-measure real
 * DOM nodes (via a ResizeObserver round trip) would turn "click
 * Auto-layout" into an async, flicker-prone operation for a canvas that
 * is never more than a few dozen nodes. These are deliberately close to,
 * not identical to, each kind's typical rendered size — dagre only needs
 * "roughly this big" to keep nodes from overlapping; a few px of slack
 * is invisible once nodes are drawn.
 */
const DEFAULT_SIZE = { width: 240, height: 110 };
const DECISION_SIZE = { width: 300, height: 190 };
const END_SIZE = { width: 128, height: 40 };

function sizeFor(node: CanvasNode): { width: number; height: number } {
  if (isEndNode(node)) return END_SIZE;
  if (node.data.kind === "decision") return DECISION_SIZE;
  return DEFAULT_SIZE;
}

/**
 * AUTO-LAYOUT — a user-invoked, one-shot rearrangement (the toolbar's
 * "Auto-layout" button), never run silently on every edit. Re-running it
 * always recomputes every node's position from the current edge graph
 * alone; nothing about which nodes exist or how they connect is
 * changed, and a manual drag afterward is not overwritten until the
 * button is clicked again.
 *
 * Left-to-right, matching this app's own existing convention (the
 * trigger starts at column 0, addNode's own heuristic already places
 * later kinds further right) — dagre's `rankdir: "LR"` is that same
 * idea, generalised to actually avoid overlap once a Decision's
 * outcomes diverge and later reconverge, which the old fixed-column
 * placement never had to handle.
 */
export function layoutNodes(nodes: CanvasNode[], edges: Edge[]): CanvasNode[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 56, ranksep: 96, marginx: 24, marginy: 24 });

  for (const node of nodes) {
    graph.setNode(node.id, sizeFor(node));
  }
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue;
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  return nodes.map((node) => {
    const positioned = graph.node(node.id);
    if (!positioned) return node;
    const { width, height } = sizeFor(node);
    // Dagre positions by CENTER; React Flow positions by TOP-LEFT.
    return { ...node, position: { x: Math.round(positioned.x - width / 2), y: Math.round(positioned.y - height / 2) } };
  });
}
