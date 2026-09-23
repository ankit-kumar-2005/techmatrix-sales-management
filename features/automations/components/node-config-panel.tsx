"use client";

import { useState } from "react";
import { FormField } from "@/components/shared/form-field";
import { SelectField } from "@/components/shared/select-field";
import { TeamSelect } from "@/components/shared/team-select";
import { LEAD_SOURCES } from "@/features/leads/schemas";
import {
  getRegistryEntry,
  TRIGGER_LEAD_CREATED,
  TRIGGER_TASK_CREATED,
  TRIGGER_CONTACT_CREATED,
  type AssignmentEntry,
  type DecisionOutcome,
  type FieldDescriptor,
} from "../registry/definitions";
import { AssignmentEditor } from "./assignment-editor";
import { ConditionGroupEditor } from "./condition-group-editor";
import { fieldRegistryForObject } from "../registry/object-fields";
import { FieldReferencePicker } from "./field-reference-picker";
import { DecisionOutcomesEditor } from "./decision-outcomes-editor";
import { EntryConditionEditor } from "./entry-condition-editor";
import { LearningPanel } from "./learning-panel";
import { ChevronRightIcon } from "@/features/sales-management/components/icons";
import type { ConditionGroup } from "../registry/condition-group";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { ValidationIssue } from "@/types/automation";
import { isEndNode, type BuilderNode, type CanvasNode } from "./workflow-node";

type NodeConfigPanelProps = {
  node: CanvasNode | null;
  /** Every real (non-End) node currently on the canvas — needed only by
   *  "node-reference" fields, to offer the eligible Create nodes a
   *  Task/Contact Update/Deactivate action can target. Nothing else
   *  reads this; the generic renderer for every other field kind still
   *  only ever looks at the selected node's own config. */
  allNodes: BuilderNode[];
  team: TeamDirectoryEntry[];
  issues: ValidationIssue[];
  readOnly: boolean;
  onChange: (nodeId: string, config: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
  /** Renders a collapse toggle in the tab bar's own corner when set —
   *  purely a layout affordance for the builder's progressive panel
   *  collapse, so it lives beside the Configure/Learn tabs rather than
   *  as a second floating button that would overlap them (TabBar's own
   *  two tabs are flex-1 and already fill the row's full width). */
  onCollapse?: () => void;
};

/**
 * The selected node's settings, RENDERED FROM THE REGISTRY.
 *
 * There is no per-node-type form component anywhere in this feature.
 * This panel walks `entry.fields` and renders each descriptor with the
 * app's existing shared inputs (FormField, SelectField, TeamSelect) —
 * the same components the lead, task and capture-rules forms use, so a
 * field here looks and behaves exactly like a field anywhere else.
 *
 * Adding a configurable option to an action means adding one descriptor
 * to the registry. It then appears here, is described to the AI, is
 * validated by the same Zod schema, and is read by the executor —
 * without this file changing at all.
 */
export function NodeConfigPanel({ node, allNodes, team, issues, readOnly, onChange, onDelete, onCollapse }: NodeConfigPanelProps) {
  // TABS, NOT TWO SEPARATE PANELS — a fixed set of tabs at the top of
  // this one panel, so selecting a different node never has to decide
  // which panel it "belongs in". Reset per-node selection change is
  // deliberately NOT done here: staying on "Learn" while clicking
  // through several nodes to understand a workflow is a completely
  // reasonable thing to do, and resetting to "Configure" every click
  // would fight that.
  const [tab, setTab] = useState<"configure" | "learn">("configure");

  if (!node) {
    return (
      <div className="flex h-full flex-col">
        <TabBar tab={tab} onChange={setTab} onCollapse={onCollapse} />
        {tab === "learn" ? (
          <LearningPanel entry={undefined} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center">
            <p className="text-xs leading-relaxed text-neutral-400">
              Select a step on the canvas to change its settings, or add one from the palette.
            </p>
          </div>
        )}
      </div>
    );
  }

  if (isEndNode(node)) {
    return (
      <div className="flex h-full flex-col">
        <TabBar tab={tab} onChange={setTab} onCollapse={onCollapse} />
        {tab === "learn" ? (
          <div className="p-4">
            <p className="text-xs leading-relaxed text-neutral-500">
              This marks where a path currently ends. It is a visual guide only — nothing to configure, and it is
              never saved as part of the workflow itself. To add another step here, use the + on the connector
              leading into it.
            </p>
          </div>
        ) : (
          <>
            <div className="border-b border-neutral-100 p-4">
              <p className="text-[10px] font-bold tracking-wide text-neutral-400 uppercase">end</p>
              <p className="mt-0.5 text-sm font-semibold text-neutral-900">End of this path</p>
              <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                A visual guide only — nothing to configure here. Use the + on the connector leading into it to add
                another step.
              </p>
            </div>
            {!readOnly ? (
              <div className="mt-auto border-t border-neutral-100 p-4">
                <button
                  type="button"
                  onClick={() => onDelete(node.id)}
                  className="w-full rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500/40 focus-visible:outline-none"
                >
                  Remove this marker
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  }

  const entry = getRegistryEntry(node.data.type);

  if (!entry) {
    return (
      <div className="flex h-full flex-col">
        <TabBar tab={tab} onChange={setTab} onCollapse={onCollapse} />
        {tab === "learn" ? (
          <LearningPanel entry={undefined} />
        ) : (
          <div className="p-4">
            <p className="text-sm font-semibold text-neutral-900">Unavailable step</p>
            <p className="mt-1 text-xs leading-relaxed text-neutral-500">
              &ldquo;{node.data.type}&rdquo; is not something this app can do any more. Remove it before switching
              this automation on.
            </p>
          </div>
        )}
      </div>
    );
  }

  const config = node.data.config;
  const nodeIssues = issues.filter((issue) => issue.nodeId === node.id);

  // Field-level errors are matched on the "Label — path: message" shape
  // validateWorkflow() produces for a config problem, so an invalid
  // field is flagged on the field itself rather than only in the list at
  // the bottom of the screen.
  function errorFor(field: FieldDescriptor): string | undefined {
    const match = nodeIssues.find((issue) => issue.message.includes(`— ${field.name}:`));
    return match?.message.split(`— ${field.name}:`)[1]?.trim();
  }

  function update(name: string, value: unknown) {
    onChange(node!.id, { ...config, [name]: value });
  }

  if (tab === "learn") {
    return (
      <div className="flex h-full flex-col">
        <TabBar tab={tab} onChange={setTab} onCollapse={onCollapse} />
        <LearningPanel entry={entry} />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <TabBar tab={tab} onChange={setTab} onCollapse={onCollapse} />

      <div className="border-b border-neutral-100 p-4">
        <p className="text-[10px] font-bold tracking-wide text-neutral-400 uppercase">{entry.kind}</p>
        <p className="mt-0.5 text-sm font-semibold text-neutral-900">{entry.label}</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">{entry.description}</p>
      </div>

      {entry.kind === "trigger" ? <StartObjectPicker activeObject={TRIGGER_OBJECT_LABELS[node.data.type] ?? null} /> : null}

      <div className="flex flex-1 flex-col gap-4 p-4">
        {entry.fields.map((field) => {
          // visibleWhen is how one node type offers two (or more) shapes
          // without becoming several node types — equals may be one
          // value or a list (the update-trigger's own updateMode field is
          // visible for two of its parent's three eventType values).
          if (field.visibleWhen) {
            const expected = field.visibleWhen.equals;
            const actual = config[field.visibleWhen.field];
            const matches = Array.isArray(expected) ? expected.includes(actual as string) : actual === expected;
            if (!matches) return null;
          }

          const error = errorFor(field);
          const value = config[field.name];

          if (field.kind === "condition-group") {
            const root = (value as ConditionGroup | undefined) ?? { kind: "group", match: "all", rules: [] };
            const objectValue = field.objectFieldName ? config[field.objectFieldName] : undefined;
            const fieldRegistry =
              typeof objectValue === "string" && (objectValue === "lead" || objectValue === "task" || objectValue === "contact")
                ? fieldRegistryForObject(objectValue)
                : undefined;
            return (
              <div key={field.name}>
                <ConditionGroupEditor
                  group={root}
                  onChange={(next) => update(field.name, next)}
                  disabled={readOnly}
                  depth={1}
                  fieldRegistry={fieldRegistry}
                />
                {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
              </div>
            );
          }

          if (field.kind === "decision-outcomes") {
            const outcomes = Array.isArray(value) ? (value as DecisionOutcome[]) : [];
            return (
              <div key={field.name}>
                <DecisionOutcomesEditor outcomes={outcomes} onChange={(next) => update(field.name, next)} disabled={readOnly} />
                {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
              </div>
            );
          }

          if (field.kind === "assignment-list") {
            const assignmentList = Array.isArray(value) ? (value as AssignmentEntry[]) : [];
            return (
              <div key={field.name}>
                <AssignmentEditor assignments={assignmentList} onChange={(next) => update(field.name, next)} disabled={readOnly} />
                {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
              </div>
            );
          }

          if (field.kind === "entry-condition") {
            const entryCondition = (value as ConditionGroup | null | undefined) ?? null;
            return (
              <div key={field.name}>
                <EntryConditionEditor value={entryCondition} onChange={(next) => update(field.name, next)} disabled={readOnly} />
                {error ? <p className="mt-1.5 text-xs text-red-600">{error}</p> : null}
                {!error && field.helperText ? <p className="mt-1 text-[11px] text-neutral-500">{field.helperText}</p> : null}
              </div>
            );
          }

          if (field.kind === "node-reference") {
            // Only Create nodes of the right object (field.targetType) —
            // never an arbitrary node id. Self-reference is excluded too,
            // though it can never actually occur: validateWorkflow's own
            // ancestor check would already refuse a self-referencing
            // workflow before it could be saved.
            const eligible = allNodes.filter(
              (candidate) => candidate.id !== node.id && (!field.targetType || candidate.data.type === field.targetType),
            );
            const selected = typeof value === "string" ? value : "";
            const targetLabel = (field.targetType && getRegistryEntry(field.targetType)?.label) || "Create";
            return (
              <div key={field.name} className="flex flex-col gap-1.5">
                <label htmlFor={`node-${node.id}-${field.name}`} className="text-sm font-medium text-neutral-700">
                  {field.label}
                  {field.required ? (
                    <span className="text-red-500" aria-hidden="true"> *</span>
                  ) : null}
                </label>
                <select
                  id={`node-${node.id}-${field.name}`}
                  value={selected}
                  disabled={readOnly}
                  onChange={(event) => update(field.name, event.target.value)}
                  className="h-10 rounded-lg border border-neutral-300 bg-white px-3 text-sm text-neutral-800 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value="">Choose a step…</option>
                  {eligible.map((candidate, index) => (
                    <option key={candidate.id} value={candidate.id}>
                      {getRegistryEntry(candidate.data.type)?.label ?? candidate.data.type}
                      {eligible.length > 1 ? ` #${index + 1}` : ""}
                    </option>
                  ))}
                </select>
                {eligible.length === 0 ? (
                  <p className="text-xs text-amber-700">Add a &ldquo;{targetLabel}&rdquo; step to the canvas first.</p>
                ) : null}
                {error ? <p className="text-xs text-red-600">{error}</p> : null}
                {!error && field.helperText ? <p className="text-xs text-neutral-500">{field.helperText}</p> : null}
              </div>
            );
          }

          if (field.kind === "select") {
            return (
              <SelectField
                key={field.name}
                id={`node-${node.id}-${field.name}`}
                name={field.name}
                label={field.label}
                required={field.required}
                disabled={readOnly}
                value={typeof value === "string" ? value : ""}
                onChange={(event) => update(field.name, event.target.value)}
                error={error}
                helperText={field.helperText}
              >
                {field.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
            );
          }

          if (field.kind === "source-multi") {
            // The SAME canonical list LEAD_SOURCES powers everywhere else
            // a source is picked (the Create Lead form, the Pipeline
            // filter, the condition builder's Source field). There is
            // deliberately no "entered by hand" checkbox here any more —
            // a hand-entered lead has source = null, which this list
            // never claims to represent as a pickable value; matching
            // that case is the generic Source field's job now ("is
            // empty"), not this legacy condition's.
            const selected = Array.isArray(value) ? (value as string[]) : [];
            return (
              <fieldset key={field.name} className="flex flex-col gap-1.5">
                <legend className="text-xs font-semibold text-neutral-700">{field.label}</legend>
                <div className="flex flex-col gap-1.5">
                  {LEAD_SOURCES.map((source) => (
                    <label key={source} className="flex items-center gap-2 text-xs text-neutral-700">
                      <input
                        type="checkbox"
                        disabled={readOnly}
                        checked={selected.includes(source)}
                        onChange={(event) =>
                          update(
                            field.name,
                            event.target.checked
                              ? [...selected, source]
                              : selected.filter((entryValue) => entryValue !== source),
                          )
                        }
                        className="h-3.5 w-3.5 rounded border-neutral-300 text-sky-600 focus:ring-sky-500/40"
                      />
                      {source}
                    </label>
                  ))}
                </div>
                {error ? <p className="text-xs text-red-600">{error}</p> : null}
                {field.helperText ? <p className="text-xs text-neutral-500">{field.helperText}</p> : null}
              </fieldset>
            );
          }

          if (field.kind === "team-single" || field.kind === "team-multi") {
            const multiple = field.kind === "team-multi";
            const selectedIds = multiple
              ? Array.isArray(value)
                ? (value as string[])
                : []
              : typeof value === "string" && value
                ? [value]
                : [];

            return (
              <TeamSelect
                // KEYED BY NODE, deliberately. TeamSelect owns its own
                // selection state and is uncontrolled after mount (see
                // its own note), so selecting a different node has to
                // remount it — otherwise the panel would keep showing
                // the previous node's assignee.
                key={`${node.id}-${field.name}`}
                id={`node-${node.id}-${field.name}`}
                name={field.name}
                label={field.label}
                multiple={multiple}
                options={team}
                disabled={readOnly}
                defaultSelectedIds={selectedIds}
                emptyOptionLabel={multiple ? undefined : "Choose someone"}
                error={error}
                helperText={field.helperText}
                onSelectionChange={(ids) => update(field.name, multiple ? ids : (ids[0] ?? null))}
              />
            );
          }

          if (field.kind === "textarea") {
            // A raw textarea rather than FormField, which wraps an
            // <input> only. Styled to match FormField's filled variant
            // so it still reads as one set with the controls above it.
            const textareaId = `node-${node.id}-${field.name}`;
            return (
              <div key={field.name} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={textareaId} className="text-sm font-medium text-neutral-700">
                    {field.label}
                  </label>
                  {field.templated ? (
                    <FieldReferencePicker
                      value={typeof value === "string" ? value : ""}
                      onInsert={(next) => update(field.name, next)}
                      disabled={readOnly}
                    />
                  ) : null}
                </div>
                <textarea
                  id={textareaId}
                  name={field.name}
                  rows={3}
                  disabled={readOnly}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => update(field.name, event.target.value)}
                  aria-invalid={Boolean(error)}
                  className={`w-full resize-y rounded-lg border bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60 ${
                    error ? "border-red-400" : "border-transparent"
                  }`}
                />
                {error ? <p className="text-xs text-red-600">{error}</p> : null}
                {!error && field.helperText ? <p className="text-xs text-neutral-500">{field.helperText}</p> : null}
              </div>
            );
          }

          if (field.templated) {
            // FormField has no slot for a trailing control, and this is
            // the one place a text field needs one (see
            // field-reference-picker.tsx) — a custom label row, styled to
            // match FormField's own "filled" variant exactly, rather than
            // changing a component every other form in this app also
            // uses.
            const inputId = `node-${node.id}-${field.name}`;
            return (
              <div key={field.name} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor={inputId} className="text-sm font-medium text-neutral-700">
                    {field.label}
                    {field.required ? (
                      <span className="text-red-500" aria-hidden="true">
                        {" "}
                        *
                      </span>
                    ) : null}
                  </label>
                  <FieldReferencePicker
                    value={typeof value === "string" ? value : ""}
                    onInsert={(next) => update(field.name, next)}
                    disabled={readOnly}
                  />
                </div>
                <input
                  id={inputId}
                  name={field.name}
                  type="text"
                  disabled={readOnly}
                  maxLength={field.maxLength}
                  placeholder={field.placeholder}
                  value={typeof value === "string" ? value : ""}
                  onChange={(event) => update(field.name, event.target.value)}
                  aria-invalid={Boolean(error)}
                  className={`w-full rounded-lg border border-transparent bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 disabled:cursor-not-allowed disabled:opacity-60 ${
                    error ? "ring-2 ring-red-300" : ""
                  }`}
                />
                {error ? <p className="text-xs text-red-600">{error}</p> : null}
                {!error && field.helperText ? <p className="text-xs text-neutral-500">{field.helperText}</p> : null}
              </div>
            );
          }

          return (
            <FormField
              key={field.name}
              id={`node-${node.id}-${field.name}`}
              name={field.name}
              label={field.label}
              type={field.kind === "number" ? "number" : "text"}
              variant="filled"
              required={field.required}
              disabled={readOnly}
              min={field.min}
              max={field.max}
              maxLength={field.maxLength}
              placeholder={field.placeholder}
              value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
              onChange={(event) =>
                update(field.name, field.kind === "number" ? Number(event.target.value) : event.target.value)
              }
              error={error}
              helperText={field.helperText}
            />
          );
        })}

        {entry.limitations.length > 0 ? (
          <div className="rounded-lg bg-neutral-50 p-3 ring-1 ring-neutral-100">
            <p className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">What this cannot do</p>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-[11px] leading-relaxed text-neutral-500">
              {entry.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      {!readOnly ? (
        <div className="border-t border-neutral-100 p-4">
          <button
            type="button"
            onClick={() => onDelete(node.id)}
            className="w-full rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-500/40 focus-visible:outline-none"
          >
            Remove this step
          </button>
        </div>
      ) : null}
    </div>
  );
}

const OBJECT_CHOICES = ["Lead", "Task", "Contact"] as const;

const TRIGGER_OBJECT_LABELS: Record<string, (typeof OBJECT_CHOICES)[number]> = {
  [TRIGGER_LEAD_CREATED]: "Lead",
  [TRIGGER_TASK_CREATED]: "Task",
  [TRIGGER_CONTACT_CREATED]: "Contact",
};

/**
 * "What starts this automation?" — purely presentational, not a config
 * field; this node's own type (a specific trigger registry entry) is
 * already the real picker, chosen from the palette. This just restates
 * which of the three real trigger objects that entry is, since "Task
 * created or updated" alone doesn't visually group with Lead/Contact the
 * way this pill row does. Nothing here writes to config.
 */
function StartObjectPicker({ activeObject }: { activeObject: (typeof OBJECT_CHOICES)[number] | null }) {
  return (
    <div className="border-b border-neutral-100 p-4">
      <p className="text-[10px] font-bold tracking-wide text-neutral-400 uppercase">What starts this automation?</p>
      <div className="mt-2 flex gap-1.5">
        {OBJECT_CHOICES.map((choice) => (
          <span
            key={choice}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ring-inset ${
              choice === activeObject
                ? "bg-gradient-to-r from-blue-600 to-violet-600 text-white ring-transparent"
                : "bg-neutral-50 text-neutral-400 ring-neutral-200"
            }`}
          >
            {choice}
          </span>
        ))}
      </div>
    </div>
  );
}

function TabBar({
  tab,
  onChange,
  onCollapse,
}: {
  tab: "configure" | "learn";
  onChange: (tab: "configure" | "learn") => void;
  onCollapse?: () => void;
}) {
  return (
    <div role="tablist" aria-label="Node panel" className="flex shrink-0 items-center border-b border-neutral-100">
      {(["configure", "learn"] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={tab === value}
          onClick={() => onChange(value)}
          className={`flex-1 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none ${
            tab === value
              ? "border-sky-500 text-sky-700"
              : "border-transparent text-neutral-400 hover:text-neutral-600"
          }`}
        >
          {value === "configure" ? "Configure" : "Learn"}
        </button>
      ))}
      {onCollapse ? (
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Hide configure panel"
          title="Hide configure panel"
          className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700"
        >
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
