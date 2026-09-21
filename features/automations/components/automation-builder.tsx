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
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from "@xyflow/react";
import { FormField } from "@/components/shared/form-field";
import { MessageBanner } from "@/components/shared/message-banner";
import { getRegistryEntry } from "../registry/definitions";
import { MAX_AUTOMATION_DESCRIPTION_LENGTH, MAX_AUTOMATION_NAME_LENGTH } from "../config/safeguards";
import { validateWorkflow } from "../lib/validate-workflow";
import { saveAutomationAction, setAutomationStatusAction } from "../actions";
import { NodePalette } from "./node-palette";
import { NodeConfigPanel } from "./node-config-panel";
import { TestModePanel } from "./test-mode-panel";
import { WorkflowNodeCard, type BuilderNode } from "./workflow-node";
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
const NODE_TYPES = { automation: WorkflowNodeCard };

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
  const [isPending, startTransition] = useTransition();

  const [automationId, setAutomationId] = useState(initialAutomationId);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<BuilderNode>(
    initialDefinition ? toFlowNodes(initialDefinition) : [],
  );
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>(
    initialDefinition ? toFlowEdges(initialDefinition) : [],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; text: string } | null>(null);
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

  const decoratedNodes = useMemo(
    () =>
      nodes.map((node) =>
        node.data.hasIssue === issueNodeIds.has(node.id)
          ? node
          : { ...node, data: { ...node.data, hasIssue: issueNodeIds.has(node.id) } },
      ),
    [nodes, issueNodeIds],
  );

  const selectedNode = decoratedNodes.find((node) => node.id === selectedId) ?? null;
  const hasTrigger = nodes.some((node) => node.data.kind === "trigger");

  const onNodesChange = useCallback(
    (changes: NodeChange<BuilderNode>[]) => {
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
      setEdges((current) =>
        addEdge(
          {
            ...connection,
            // The condition's own handle id IS the branch value, so
            // drawing from the "yes" output is what makes the stored
            // edge a "true" edge. No mapping table.
            label: connection.sourceHandle === "true" ? "yes" : connection.sourceHandle === "false" ? "no" : undefined,
            animated: false,
          },
          current,
        ),
      );
    },
    [locked, setEdges],
  );

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
    const column = kind === "trigger" ? 0 : kind === "condition" ? 1 : 2;
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

  function updateNodeConfig(nodeId: string, config: Record<string, unknown>) {
    setNodes((current) =>
      current.map((node) => (node.id === nodeId ? { ...node, data: { ...node.data, config } } : node)),
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
        <div className="hidden h-full overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5 lg:block">
          <NodePalette onAdd={addNode} hasTrigger={hasTrigger} disabled={locked} />
        </div>

        <div className="h-full overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          <ReactFlow<BuilderNode>
            nodes={decoratedNodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
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
        </div>

        <div className="h-full overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-black/5">
          <NodeConfigPanel
            node={selectedNode}
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
  return definition.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.branch ?? null,
    label: edge.branch === "true" ? "yes" : edge.branch === "false" ? "no" : undefined,
  }));
}

function fromFlow(nodes: BuilderNode[], edges: Edge[]): WorkflowDefinition {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.data.kind,
      type: node.data.type,
      // Rounded: React Flow tracks sub-pixel drag positions, and storing
      // 214.38471 in a JSONB column every save is noise in the diff of
      // an immutable version history.
      position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      config: node.data.config,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      ...(edge.sourceHandle === "true" || edge.sourceHandle === "false" ? { branch: edge.sourceHandle } : {}),
    })),
  };
}
