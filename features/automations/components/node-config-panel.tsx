"use client";

import { FormField } from "@/components/shared/form-field";
import { SelectField } from "@/components/shared/select-field";
import { TeamSelect } from "@/components/shared/team-select";
import { INTEGRATION_SOURCES } from "@/types/integration";
import { getRegistryEntry, type FieldDescriptor } from "../registry/definitions";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { ValidationIssue } from "@/types/automation";
import type { BuilderNode } from "./workflow-node";

type NodeConfigPanelProps = {
  node: BuilderNode | null;
  team: TeamDirectoryEntry[];
  issues: ValidationIssue[];
  readOnly: boolean;
  onChange: (nodeId: string, config: Record<string, unknown>) => void;
  onDelete: (nodeId: string) => void;
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
export function NodeConfigPanel({ node, team, issues, readOnly, onChange, onDelete }: NodeConfigPanelProps) {
  if (!node) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <p className="text-xs leading-relaxed text-neutral-400">
          Select a step on the canvas to change its settings, or add one from the palette.
        </p>
      </div>
    );
  }

  const entry = getRegistryEntry(node.data.type);

  if (!entry) {
    return (
      <div className="p-4">
        <p className="text-sm font-semibold text-neutral-900">Unavailable step</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          &ldquo;{node.data.type}&rdquo; is not something this app can do any more. Remove it before switching this
          automation on.
        </p>
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

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-neutral-100 p-4">
        <p className="text-[10px] font-bold tracking-wide text-neutral-400 uppercase">{entry.kind}</p>
        <p className="mt-0.5 text-sm font-semibold text-neutral-900">{entry.label}</p>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">{entry.description}</p>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-4">
        {entry.fields.map((field) => {
          // visibleWhen is how one node type offers two shapes (fixed
          // assignee vs a rotation) without becoming two node types.
          if (field.visibleWhen && config[field.visibleWhen.field] !== field.visibleWhen.equals) {
            return null;
          }

          const error = errorFor(field);
          const value = config[field.name];

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
            const selected = Array.isArray(value) ? (value as string[]) : [];
            return (
              <fieldset key={field.name} className="flex flex-col gap-1.5">
                <legend className="text-xs font-semibold text-neutral-700">{field.label}</legend>
                <div className="flex flex-col gap-1.5">
                  {INTEGRATION_SOURCES.map((source) => (
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
                  {/* Leads typed into the app by hand have no source at
                      all, which is a real case an admin needs to be able
                      to name — it is not the absence of a filter. */}
                  <label className="flex items-center gap-2 text-xs text-neutral-700">
                    <input
                      type="checkbox"
                      disabled={readOnly}
                      checked={selected.includes("Manual")}
                      onChange={(event) =>
                        update(
                          field.name,
                          event.target.checked
                            ? [...selected, "Manual"]
                            : selected.filter((entryValue) => entryValue !== "Manual"),
                        )
                      }
                      className="h-3.5 w-3.5 rounded border-neutral-300 text-sky-600 focus:ring-sky-500/40"
                    />
                    Manual — entered by hand
                  </label>
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
                <label htmlFor={textareaId} className="text-sm font-medium text-neutral-700">
                  {field.label}
                </label>
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
