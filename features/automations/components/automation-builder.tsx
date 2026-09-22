"use client";

import "@xyflow/react/dist/style.css";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { FormField } from "@/components/shared/form-field";
import { MessageBanner } from "@/components/shared/message-banner";
import { DECISION_DEFAULT_BRANCH, TRIGGER_LEAD_CREATED, getRegistryEntry, type DecisionOutcome } from "../registry/definitions";
import { MAX_AUTOMATION_DESCRIPTION_LENGTH, MAX_AUTOMATION_NAME_LENGTH } from "../config/safeguards";
import { validateWorkflow } from "../lib/validate-workflow";
import { layoutNodes } from "../lib/auto-layout";
import { saveAutomationAction, setAutomationStatusAction } from "../actions";
import { InsertableEdgeType, type InsertableEdgeData } from "./insertable-edge";
import { NodeInsertMenu } from "./node-insert-menu";
import { NodePalette } from "./node-palette";
import { ResourcesPanel } from "./resources-panel";
import { NodeConfigPanel } from "./node-config-panel";
import { TestModePanel } from "./test-mode-panel";
import {
  AUTOMATION_END_TYPE,
  EndNodeCard,
  WorkflowNodeCard,
  handlePositions,
  isEndNode,
  outputHandles,
  type BuilderNode,
  type BuilderNodeData,
  type CanvasNode,
  type OpenOutput,
} from "./workflow-node";
import type { TeamDirectoryEntry } from "@/types/lead";
import type {
  AutomationNodeKind,
  AutomationOrigin,
  AutomationStatus,
  WorkflowDefinition,
} from "@/types/automation";

type AutomationBuilderProps = {
  automationId: string | null;
  initialName: string;
  initialDescription: string;
  initialDefinition: WorkflowDefinition | null;
  status: AutomationStatus;
  origin: AutomationOrigin;
  /** The version currently running, when one is. Shown so an admin
   *  editing a draft can see what is live underneath them. */
  activeVersion: number | null;
  latestVersion: number;
  team: TeamDirectoryEntry[];
};

/** Registered once, outside the component: React Flow warns (and
 *  remounts every node) if this object identity changes between
 *  renders. */
const NODE_TYPES = { automation: WorkflowNodeCard, [AUTOMATION_END_TYPE]: EndNodeCard };
const EDGE_TYPES = { insertable: InsertableEdgeType };

/** What is being inserted: appended after a specific node's specific
 *  output, or spliced into the middle of an existing edge. Both open
 *  the identical NodeInsertMenu — only what happens on a pick differs. */
type InsertMode = { type: "append"; sourceId: string; branch: string | null } | { type: "edge"; edgeId: string };
type InsertMenuState = { anchor: { x: number; y: number }; mode: InsertMode };

/** What a branch id should be labelled on an edge, read from the SOURCE
 *  node's own kind and config — "yes"/"no" for a condition, an
 *  outcome's own name (or "otherwise") for a decision. One function for
 *  both the stored-definition shape and the live BuilderNode shape,
 *  since both carry the same {kind, config}. */
function labelForBranch(
  source: { kind: AutomationNodeKind | "end"; config?: Record<string, unknown> } | undefined,
  branch: string | null | undefined,
): string | undefined {
  if (!source || !branch) return undefined;
  if (source.kind === "condition") return branch === "true" ? "yes" : "no";
  if (source.kind === "decision") {
    if (branch === DECISION_DEFAULT_BRANCH) return "otherwise";
    const outcomes = Array.isArray(source.config?.outcomes) ? (source.config.outcomes as DecisionOutcome[]) : [];
    return outcomes.find((outcome) => outcome.id === branch)?.name;
  }
  return undefined;
}

/**
 * THE BUILDER. One canvas, reached identically from a blank start and
 * from an AI-generated draft — the AI path hands this component an
 * `initialDefinition` and then has nothing further to do with it. Save,
 * validation, test mode and activation are the same code either way,
 * because there is only one of each.
 */
export function AutomationBuilder(props: AutomationBuilderProps) {
  return (
    // ReactFlowProvider so Controls/MiniMap and the store work; the
    // inner component is where the state lives.
    <ReactFlowProvider>
      <BuilderInner {...props} />
    </ReactFlowProvider>
  );
}

function BuilderInner({
  automationId: initialAutomationId,
  initialName,
  initialDescription,
  initialDefinition,
  status,
  origin,
  activeVersion,
  latestVersion,
  team,
}: AutomationBuilderProps) {
  const router = useRouter();
  const { fitView } = useReactFlow();
  const [isPending, startTransition] = useTransition();

  const [automationId, setAutomationId] = useState(initialAutomationId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<CanvasNode>(
    initialDefinition ? toFlowNodes(initialDefinition) : [],
  );
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>(
    initialDefinition ? toFlowEdges(initialDefinition) : [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Which content the LEFT column shows — the "+" palette (default) or
   *  the Resources panel (Phase 2's record/collection variables,
   *  organized). Purely a view toggle: neither tab holds state of its
   *  own, both just read/act on the SAME nodes array. */
  const [leftTab, setLeftTab] = useState<"palette" | "resources">("palette");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  /** Open when a "+" chip (a dangling output, or an edge's own midpoint)
   *  was just clicked. Null the rest of the time. */
  const [insertMenu, setInsertMenu] = useState<InsertMenuState | null>(null);
  /**
   * READ-ONLY MODE. Not a permission — an admin can always unlock it.
   * It exists because dragging a node by accident while reading a
   * workflow that is currently live is an easy mistake, and this makes
   * "I am just looking" an explicit state. Defaults to on for an Active
   * automation for exactly that reason.
   */
  const [locked, setLocked] = useState(status === "Active");

  const definition = useMemo<WorkflowDefinition>(() => fromFlow(nodes, edges), [nodes, edges]);

  // Live, on every edit — the same validateWorkflow() the save action
  // and the engine run. The builder's copy is a convenience; the
  // server's is the one that decides.
  const validation = useMemo(() => validateWorkflow(definition), [definition]);

  const issueNodeIds = useMemo(
    () => new Set(validation.issues.map((issue) => issue.nodeId).filter((id): id is string => Boolean(id))),
    [validation.issues],
  );

  // The "+" chips (see workflow-node.tsx) are computed here, not stored:
  // an output counts as "open" purely because no live edge currently
  // leaves it, so the chip disappears the instant a connection is drawn
  // or an insertion fills it, with nothing to keep in sync by hand.
  const decoratedNodes = useMemo<CanvasNode[]>(
    () =>
      nodes.map((node) => {
        // The End marker has no outputs, no config, and no issues of its
        // own to decorate — it passes through untouched. See its own
        // note in workflow-node.tsx for why it is not a BuilderNode at
        // all.
        if (isEndNode(node)) return node;

        const openOutputs = locked ? [] : computeOpenOutputs(node, edges);
        return {
          ...node,
          data: {
            ...node.data,
            hasIssue: issueNodeIds.has(node.id),
            openOutputs,
            onRequestInsert: locked
              ? undefined
              : (branch: string | null, anchor: { x: number; y: number }) =>
                  setInsertMenu({ anchor, mode: { type: "append", sourceId: node.id, branch } }),
          },
        };
      }),
    [nodes, edges, issueNodeIds, locked],
  );

  const decoratedEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        ...edge,
        type: "insertable" as const,
        data: {
          ...(edge.data as InsertableEdgeData | undefined),
          onRequestInsert: locked ? undefined : (edgeId: string, anchor: { x: number; y: number }) => setInsertMenu({ anchor, mode: { type: "edge", edgeId } }),
        },
      })),
    [edges, locked],
  );

  const selectedNode = decoratedNodes.find((node) => node.id === selectedId) ?? null;
  const hasTrigger = nodes.some((node) => node.data.kind === "trigger");

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      if (locked) {
        // Selection still has to work in read-only mode — otherwise the
        // config panel could never show anything.
        const selectionOnly = changes.filter((change) => change.type === "select");
        if (selectionOnly.length > 0) onNodesChangeBase(selectionOnly);
        return;
      }
      onNodesChangeBase(changes);
    },
    [locked, onNodesChangeBase],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      if (locked) return;
      onEdgesChangeBase(changes);
    },
    [locked, onEdgesChangeBase],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (locked) return;
      const sourceNode = nodes.find((node) => node.id === connection.source);
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            // A branching node's own handle id IS the branch value, so
            // drawing from a particular output is what makes the stored
            // edge carry that branch. No mapping table — see
            // labelForBranch.
            label: labelForBranch(sourceNode?.data, connection.sourceHandle),
            animated: false,
          },
          current,
        ),
      );
    },
    [locked, setEdges, nodes],
  );

  /** A pick from the insertion menu — either appending a new node after
   *  a specific output, or splicing one into an existing edge. Both end
   *  the same way: the new node exists, is wired in, and is selected so
   *  its config panel opens immediately — an admin never has to hunt for
   *  what they just added. */
  function pickInsert(kind: AutomationNodeKind, type: string) {
    if (!insertMenu) return;
    const entry = getRegistryEntry(type);
    if (!entry) return;

    const id = `n-${crypto.randomUUID().slice(0, 8)}`;
    const newNodeData: BuilderNodeData = { kind, type, config: { ...entry.defaultConfig }, hasIssue: false };

    if (insertMenu.mode.type === "append") {
      const { sourceId, branch } = insertMenu.mode;
      const sourceNode = nodes.find((node) => node.id === sourceId);
      const position = sourceNode ? { x: sourceNode.position.x + 320, y: sourceNode.position.y } : { x: 0, y: 0 };

      setNodes((current) => [...current, { id, type: "automation" as const, position, data: newNodeData }]);
      setEdges((current) => [
        ...current,
        {
          id: `e-${crypto.randomUUID().slice(0, 8)}`,
          source: sourceId,
          target: id,
          sourceHandle: branch ?? undefined,
          label: labelForBranch(sourceNode?.data, branch),
        },
      ]);
    } else {
      const { edgeId } = insertMenu.mode;
      const edge = edges.find((candidate) => candidate.id === edgeId);
      if (!edge) {
        setInsertMenu(null);
        return;
      }
      const sourceNode = nodes.find((node) => node.id === edge.source);
      const targetNode = nodes.find((node) => node.id === edge.target);
      const position =
        sourceNode && targetNode
          ? { x: Math.round((sourceNode.position.x + targetNode.position.x) / 2), y: Math.round((sourceNode.position.y + targetNode.position.y) / 2) }
          : { x: 0, y: 0 };

      // The new node's OWN default output, wired on to the original
      // edge's target — a condition defaults to its "yes" path, a
      // decision to its first outcome, so the workflow stays fully
      // connected the instant it is inserted rather than needing a
      // second manual connection before it is valid.
      const outgoingBranch =
        kind === "condition"
          ? "true"
          : kind === "decision"
            ? ((entry.defaultConfig as { outcomes?: DecisionOutcome[] }).outcomes?.[0]?.id ?? DECISION_DEFAULT_BRANCH)
            : undefined;

      setNodes((current) => [...current, { id, type: "automation" as const, position, data: newNodeData }]);
      setEdges((current) => [
        ...current.filter((candidate) => candidate.id !== edgeId),
        { id: `e-${crypto.randomUUID().slice(0, 8)}`, source: edge.source, target: id, sourceHandle: edge.sourceHandle ?? undefined, label: edge.label },
        {
          id: `e-${crypto.randomUUID().slice(0, 8)}`,
          source: id,
          target: edge.target,
          sourceHandle: outgoingBranch,
          label: labelForBranch(newNodeData, outgoingBranch),
        },
      ]);
    }

    setSelectedId(id);
    setInsertMenu(null);
  }

  function addNode(kind: AutomationNodeKind, type: string) {
    const entry = getRegistryEntry(type);
    if (!entry) return;

    // crypto.randomUUID in an event handler, never in a render — the
    // React Compiler's purity rule rejects non-deterministic calls in a
    // component body, and this app has already been bitten by the
    // Date.now() form of that.
    const id = `n-${crypto.randomUUID().slice(0, 8)}`;

    // Placed in a loose column by kind so a new node lands somewhere
    // sensible rather than on top of an existing one.
    const column = kind === "trigger" ? 0 : kind === "action" ? 2 : 1;
    const sameKindCount = nodes.filter((node) => node.data.kind === kind).length;

    setNodes((current) => [
      ...current,
      {
        id,
        type: "automation" as const,
        position: { x: column * 300, y: sameKindCount * 160 },
        data: { kind, type, config: { ...entry.defaultConfig }, hasIssue: false },
      },
    ]);
    setSelectedId(id);
  }

  /**
   * THE EMPTY-CANVAS ENTRY POINT — what the big "+ Start with a trigger"
   * button in the middle of a blank canvas actually does. Unlike a plain
   * palette add (one unwired node), this creates the trigger together
   * with an End marker already connected beneath it, so a brand-new
   * workflow looks like a path with a beginning and an end from the
   * first click — matching the interaction this was modelled on, without
   * adopting anything that node's own styling or copy. The End marker
   * itself is never part of what gets saved (see fromFlow) — only the
   * trigger is.
   */
  function startWithTrigger() {
    const entry = getRegistryEntry(TRIGGER_LEAD_CREATED);
    if (!entry) return;

    const triggerId = `n-${crypto.randomUUID().slice(0, 8)}`;
    const endId = `n-${crypto.randomUUID().slice(0, 8)}`;

    setNodes((current) => [
      ...current,
      {
        id: triggerId,
        type: "automation" as const,
        position: { x: 0, y: 0 },
        data: { kind: "trigger" as const, type: TRIGGER_LEAD_CREATED, config: { ...entry.defaultConfig }, hasIssue: false },
      },
      // To the RIGHT of the trigger, not below it — this canvas reads
      // left to right (see addNode's own column logic), so End follows
      // that same rhythm rather than the reference screenshots' vertical
      // layout, per the "this app's own voice" boundary.
      { id: endId, type: AUTOMATION_END_TYPE, position: { x: 320, y: 24 }, data: { kind: "end" as const } },
    ]);
    setEdges((current) => [...current, { id: `e-${crypto.randomUUID().slice(0, 8)}`, source: triggerId, target: endId }]);
    setSelectedId(triggerId);
  }

  /** Re-arranges every node's position from the CURRENT edge graph alone
   *  (see auto-layout.ts) — a one-shot, user-invoked action, not
   *  something that runs on every edit. A manual drag afterward is not
   *  overwritten again until this is clicked a second time. */
  function autoLayout() {
    setNodes((current) => layoutNodes(current, edges));
    // Re-centre on the new positions — otherwise the admin's current
    // pan/zoom stays exactly where it was and a node that moved out from
    // under it just looks like it vanished. `requestAnimationFrame`
    // because `fitView` reads node dimensions from the DOM, which needs
    // one paint after `setNodes` to reflect the new positions.
    requestAnimationFrame(() => fitView({ duration: 300, padding: 0.2 }));
  }

  function updateNodeConfig(nodeId: string, config: Record<string, unknown>) {
    // The End marker never reaches this — it has no config form to edit
    // — but the guard keeps the map's return type a real CanvasNode[]
    // rather than an object neither member of that union actually is.
    setNodes((current) =>
      current.map((node) => (node.id === nodeId && !isEndNode(node) ? { ...node, data: { ...node.data, config } } : node)),
    );
  }

  function deleteNode(nodeId: string) {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    // Edges touching a removed node go with it — leaving them would make
    // the definition reference a node that is not there, which
    // validateWorkflow() would then report as a confusing dangling
    // connection rather than as the deletion it was.
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSelectedId(null);
  }

  function save() {
    setFeedback(null);
    startTransition(async () => {
      const result = await saveAutomationAction({
        automation_id: automationId,
        name,
        description: description.trim() || null,
        definition,
        origin,
      });

      if (result.formError) {
        setFeedback({ tone: "error", text: result.formError });
        return;
      }

      if (result.automationId && result.automationId !== automationId) {
        setAutomationId(result.automationId);
        // Move the URL onto the real record so a refresh does not land
        // back on a blank canvas and create a second automation.
        router.replace(`/automations/${result.automationId}`);
      }

      setFeedback({ tone: result.issues?.length ? "error" : "success", text: result.message ?? "Saved." });
      router.refresh();
    });
  }

  function setStatus(next: "Active" | "Inactive") {
    if (!automationId) {
      setFeedback({ tone: "error", text: "Save this automation before switching it on." });
      return;
    }

    setFeedback(null);
    startTransition(async () => {
      const result = await setAutomationStatusAction({ automation_id: automationId, status: next });
      setFeedback({
        tone: result.formError ? "error" : "success",
        text:
          result.formError && result.issues?.length
            ? `${result.formError} ${result.issues.map((issue) => issue.message).join(" ")}`
            : (result.formError ?? result.message ?? "Updated."),
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Toolbar ---- */}
      <div className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            id="automation-name"
            name="name"
            label="Name"
            required
            variant="filled"
            value={name}
            disabled={locked}
            maxLength={MAX_AUTOMATION_NAME_LENGTH}
            onChange={(event) => setName(event.target.value)}
            placeholder="Follow up on new IndiaMART leads"
          />
          <FormField
            id="automation-description"
            name="description"
            label="Description"
            variant="filled"
            value={description}
            disabled={locked}
            maxLength={MAX_AUTOMATION_DESCRIPTION_LENGTH}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Optional — what this is for"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={status} activeVersion={activeVersion} latestVersion={latestVersion} />

          <span className="flex-1" />

          <button
            type="button"
            onClick={autoLayout}
            disabled={locked || nodes.length === 0}
            title="Rearrange every step left-to-right from how they're connected — your own dragged positions are kept until you click this again."
            className="min-h-9 rounded-full border border-neutral-300 px-3.5 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            Auto-layout
          </button>

          <button
            type="button"
            onClick={() => setLocked((current) => !current)}
            className="min-h-9 rounded-full border border-neutral-300 px-3.5 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
          >
            {locked ? "Unlock to edit" : "Lock (read-only)"}
          </button>

          <button
            type="button"
            onClick={save}
            disabled={isPending || locked || !name.trim()}
            className="min-h-9 rounded-full border border-neutral-300 px-3.5 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? "Saving..." : "Save draft"}
          </button>

          {status === "Active" ? (
            <button
              type="button"
              onClick={() => setStatus("Inactive")}
              disabled={isPending}
              className="min-h-9 rounded-full border border-amber-300 bg-amber-50 px-3.5 py-1.5 text-xs font-semibold text-amber-800 transition-colors hover:bg-amber-100 focus-visible:ring-2 focus-visible:ring-amber-500/40 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            >
              Switch off
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStatus("Active")}
              // Deliberately NOT disabled on validation.ok alone: the
              // server re-validates and its answer is the one that
              // counts. Disabling here as well would hide the reason.
              disabled={isPending || !automationId}
              className="min-h-9 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 transition-all hover:from-blue-700 hover:to-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Switch on
            </button>
          )}
        </div>

        {feedback ? <MessageBanner tone={feedback.tone}>{feedback.text}</MessageBanner> : null}
      </div>

      {/* ---- Palette | Canvas | Config ----
          EXPLICIT PIXEL HEIGHT on the row, and h-full on the canvas
          cell. React Flow measures its container and renders nothing at
          all inside a parent with no resolved height — a flex/grid child
          with `min-h-0` and no fixed basis is exactly that case. The
          height is set here, once, rather than on the ReactFlow element
          itself so the palette and config columns match it. */}
      <div className="grid h-[600px] grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)_300px]">
        <div className="hidden h-full flex-col overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 lg:flex">
          <LeftColumnTabs tab={leftTab} onChange={setLeftTab} />
          <div className="min-h-0 flex-1">
            {leftTab === "palette" ? (
              <NodePalette onAdd={addNode} hasTrigger={hasTrigger} disabled={locked} />
            ) : (
              <ResourcesPanel
                nodes={nodes.filter((candidate): candidate is BuilderNode => !isEndNode(candidate))}
                onSelectNode={setSelectedId}
                onAdd={addNode}
                disabled={locked}
              />
            )}
          </div>
        </div>

        <div className="relative h-full overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          <ReactFlow<CanvasNode>
            nodes={decoratedNodes}
            edges={decoratedEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_event, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            nodesDraggable={!locked}
            nodesConnectable={!locked}
            elementsSelectable
            deleteKeyCode={locked ? null : ["Backspace", "Delete"]}
            fitView
            // Bounded so a stray trackpad pinch cannot leave an admin
            // looking at a blank grey field with no way back.
            minZoom={0.3}
            maxZoom={1.75}
            proOptions={{ hideAttribution: false }}
          >
            <Background gap={16} />
            {/* Zoom in/out, fit and the interactivity toggle. */}
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="!hidden sm:!block" />
          </ReactFlow>

          {nodes.length === 0 && !locked ? (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <button
                type="button"
                onClick={startWithTrigger}
                className="pointer-events-auto flex items-center gap-2 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-xs font-semibold text-white shadow-sm shadow-blue-600/20 transition-all hover:from-blue-700 hover:to-violet-700"
              >
                <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/20 text-sm leading-none">+</span>
                Start with a trigger
              </button>
            </div>
          ) : null}

          {insertMenu ? (
            <NodeInsertMenu anchor={insertMenu.anchor} onPick={pickInsert} onClose={() => setInsertMenu(null)} />
          ) : null}
        </div>

        <div className="h-full overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          <NodeConfigPanel
            node={selectedNode}
            allNodes={nodes.filter((candidate): candidate is BuilderNode => !isEndNode(candidate))}
            team={team}
            issues={validation.issues}
            readOnly={locked}
            onChange={updateNodeConfig}
            onDelete={deleteNode}
          />
        </div>
      </div>

      {/* The palette is hidden at small widths above; this keeps it
          reachable there rather than making the canvas unusable on a
          tablet. */}
      <div className="rounded-2xl bg-white shadow-sm ring-1 ring-black/5 lg:hidden">
        <NodePalette onAdd={addNode} hasTrigger={hasTrigger} disabled={locked} />
      </div>

      {/* ---- Validation ---- */}
      <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
        <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Checks</h2>
        {validation.ok ? (
          <p className="mt-2 text-sm text-teal-700">
            This workflow is valid and can be switched on.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {validation.issues.map((issue, index) => (
              <li key={`${issue.nodeId ?? "workflow"}-${index}`} className="flex items-start gap-2 text-sm">
                <span aria-hidden="true" className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
                <span className="text-neutral-700">
                  {issue.message}
                  {issue.nodeId ? (
                    <button
                      type="button"
                      onClick={() => setSelectedId(issue.nodeId)}
                      className="ml-1.5 font-semibold text-sky-600 underline-offset-2 hover:underline"
                    >
                      show me
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <TestModePanel definition={definition} valid={validation.ok} team={team} />
    </div>
  );
}

/** The left column's own small tab bar — "+" (the palette) vs Resources
 *  (Phase 2's variable overview). A plain view toggle, not a route: both
 *  tabs read the identical `nodes` array, so switching never loses or
 *  resets anything. */
function LeftColumnTabs({ tab, onChange }: { tab: "palette" | "resources"; onChange: (next: "palette" | "resources") => void }) {
  return (
    <div className="flex shrink-0 border-b border-neutral-100 px-2 pt-2">
      {(
        [
          { key: "palette" as const, label: "Add steps" },
          { key: "resources" as const, label: "Resources" },
        ] as const
      ).map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          className={`flex-1 rounded-t-lg px-2 py-1.5 text-[11px] font-semibold transition-colors ${
            tab === option.key ? "border-b-2 border-sky-500 text-sky-700" : "text-neutral-400 hover:text-neutral-600"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StatusPill({
  status,
  activeVersion,
  latestVersion,
}: {
  status: AutomationStatus;
  activeVersion: number | null;
  latestVersion: number;
}) {
  const style =
    status === "Active"
      ? "bg-teal-50 text-teal-700 ring-teal-100"
      : status === "Draft"
        ? "bg-neutral-100 text-neutral-600 ring-neutral-200"
        : "bg-amber-50 text-amber-700 ring-amber-100";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-bold tracking-wide uppercase ring-1 ring-inset ${style}`}
      >
        {status}
      </span>
      {/* THE ONE THING AN ADMIN MOST NEEDS TO KNOW WHILE EDITING A LIVE
          AUTOMATION: that what they are looking at is not what is
          running. Shown only when the two genuinely differ. */}
      {status === "Active" && activeVersion !== null && activeVersion !== latestVersion ? (
        <span className="text-[11px] text-amber-700">
          Version {activeVersion} is running. You are editing version {latestVersion} — switch on again to make it
          live.
        </span>
      ) : activeVersion !== null ? (
        <span className="text-[11px] text-neutral-500">Version {activeVersion} is running.</span>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------
// Conversion between the stored definition and React Flow's own shape
// ---------------------------------------------------------------------
//
// Kept as two small pure functions rather than storing React Flow's
// shape directly: the database holds this app's own vocabulary (kind,
// type, config, branch), not a third-party library's node format. That
// is what makes a stored workflow survive a React Flow upgrade, and what
// lets validateWorkflow() and the engine — neither of which knows React
// Flow exists — read the same definition.

function toFlowNodes(definition: WorkflowDefinition): BuilderNode[] {
  return definition.nodes.map((node) => ({
    id: node.id,
    type: "automation" as const,
    position: node.position,
    data: { kind: node.kind, type: node.type, config: node.config, hasIssue: false },
  }));
}

function toFlowEdges(definition: WorkflowDefinition): Edge[] {
  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  return definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.branch ?? null,
    label: labelForBranch(nodeById.get(edge.source), edge.branch),
  }));
}

/**
 * THE STORED SHAPE, built from the live canvas — and where the End
 * marker stops existing. `realNodes` excludes every End node before
 * anything below runs, and any edge touching one (necessarily an edge
 * INTO one, since End has no source handle) is excluded with it. This
 * is the one place that boundary is enforced: nothing past this
 * function — validateWorkflow, the save action, the engine — ever
 * receives evidence an End marker was on the canvas at all, which is
 * what keeps it a pure authoring aid rather than a fifth node kind the
 * rest of this feature would have to know about.
 */
function fromFlow(nodes: CanvasNode[], edges: Edge[]): WorkflowDefinition {
  const realNodes = nodes.filter((node): node is BuilderNode => !isEndNode(node));
  const realNodeIds = new Set(realNodes.map((node) => node.id));

  return {
    nodes: realNodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      type: node.data.type,
      // Rounded: React Flow tracks sub-pixel drag positions, and storing
      // 214.38471 in a JSONB column every save is noise in the diff of
      // an immutable version history.
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      config: node.data.config,
    })),
    edges: edges
      .filter((edge) => realNodeIds.has(edge.source) && realNodeIds.has(edge.target))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        // Any non-empty handle id is a real branch now (see WorkflowEdge's
        // own note on why this widened from a fixed true/false pair) — a
        // plain single-output node never sets sourceHandle at all, so this
        // still cannot invent a branch on a node that has none.
        ...(edge.sourceHandle ? { branch: edge.sourceHandle } : {}),
      })),
  };
}

/** Which of a node's outputs currently lead nowhere, with the screen
 *  percentage each one's handle sits at — what workflow-node.tsx turns
 *  into a "+" chip. Recomputed from the live edge list on every render
 *  rather than tracked as state: an output is "open" purely because no
 *  edge currently leaves it, so there is nothing to keep in sync by
 *  hand when a connection is drawn, undone, or deleted. */
function computeOpenOutputs(node: BuilderNode, edges: Edge[]): OpenOutput[] {
  const outputs = outputHandles(node.data);
  const positions = handlePositions(outputs.length);
  const wired = new Set(edges.filter((edge) => edge.source === node.id).map((edge) => edge.sourceHandle ?? null));
  return outputs.map((output, index) => ({ branch: output.branch, top: positions[index] })).filter((output) => !wired.has(output.branch));
}
