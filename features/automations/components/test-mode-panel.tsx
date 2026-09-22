"use client";

import { useMemo, useState } from "react";
import { SelectField } from "@/components/shared/select-field";
import { FormField } from "@/components/shared/form-field";
import { getOwnerDisplayLabels } from "@/features/leads/lib/owner-display";
import { LEAD_SOURCES } from "@/features/leads/schemas";
import {
  ACTION_CONTACT_CREATE,
  ACTION_CONTACT_DEACTIVATE,
  ACTION_CONTACT_UPDATE,
  ACTION_LEAD_UPDATE,
  ACTION_TASK_CREATE,
  ACTION_TASK_DEACTIVATE,
  ACTION_TASK_UPDATE,
  getRegistryEntry,
} from "../registry/definitions";
import { planWorkflow, renderTemplate, type EventOperation, type LeadFacts } from "../lib/plan-workflow";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { WorkflowDefinition } from "@/types/automation";

type TestModePanelProps = {
  definition: WorkflowDefinition;
  valid: boolean;
  team: TeamDirectoryEntry[];
};

/** One row of business-meaningful field values a tester can set,
 *  reused for both the "current" and (on an update test) "before this
 *  update" states. Deliberately a SUBSET of the full field registry —
 *  created_at/updated_at are real, working condition fields but are not
 *  useful things for a person to hand-type in a quick test, so they are
 *  left out of this panel while staying fully usable in the condition
 *  builder itself. */
type FieldValues = {
  source: string;
  hasOwner: string;
  dealValue: string;
  status: string;
  nextStep: string;
  expectedCloseDate: string;
};

const INITIAL_VALUES: FieldValues = {
  source: LEAD_SOURCES[0],
  hasOwner: "no",
  dealValue: "",
  status: "Active",
  nextStep: "",
  expectedCloseDate: "",
};

function buildFields(values: FieldValues): Record<string, unknown> {
  return {
    source: values.source === "Manual" ? null : values.source,
    // Any non-blank marker — evaluateFieldRule's reference-type
    // operators only check blank vs. not-blank, never the actual id.
    owner_id: values.hasOwner === "yes" ? "test-owner" : null,
    deal_value: values.dealValue === "" ? null : values.dealValue,
    status: values.status,
    next_step: values.nextStep === "" ? null : values.nextStep,
    expected_close_date: values.expectedCloseDate === "" ? null : values.expectedCloseDate,
  };
}

function buildFacts(values: FieldValues, company: string, contactName: string): LeadFacts {
  return {
    leadId: "00000000-0000-0000-0000-000000000000",
    source: values.source === "Manual" ? null : values.source,
    hasOwner: values.hasOwner === "yes",
    company,
    contactName,
    fields: buildFields(values),
  };
}

/**
 * TEST MODE — runs the workflow against a lead you invent, and writes
 * nothing.
 *
 * IT IS NOT A SIMULATION OF THE ENGINE, IT IS THE ENGINE'S OWN DECISION
 * FUNCTION. planWorkflow() is the exact function the execution engine
 * calls, imported here unchanged, with the same `operation` and
 * `previousFacts` arguments the engine passes for a real Updated event
 * — so "only when it starts matching" can be genuinely tested here, not
 * approximated. The only difference between a test and a real run is
 * what happens afterwards: the engine hands the result to an executor,
 * and this panel renders it.
 *
 * That is also why this is safe. planWorkflow is pure: no Supabase, no
 * fetch, no clock. There is no path from this panel to a write, because
 * the function it calls has no way to perform one.
 */
export function TestModePanel({ definition, valid, team }: TestModePanelProps) {
  const [open, setOpen] = useState(false);
  const [operation, setOperation] = useState<EventOperation>("created");
  const [company, setCompany] = useState("Acme Industries");
  const [contactName, setContactName] = useState("Priya Sharma");
  const [current, setCurrent] = useState<FieldValues>(INITIAL_VALUES);
  const [previous, setPrevious] = useState<FieldValues>(INITIAL_VALUES);

  const labelById = useMemo(() => getOwnerDisplayLabels(team), [team]);
  /** node id -> a friendly description of that step, for a node-reference
   *  field's summary ("Targets the record from: Create a contact") — a
   *  DIFFERENT map from labelById, which is team-member ids to names. */
  const nodeLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const node of definition.nodes) {
      map.set(node.id, getRegistryEntry(node.type)?.label ?? node.type);
    }
    return map;
  }, [definition]);

  const facts = useMemo(() => buildFacts(current, company, contactName), [current, company, contactName]);
  const previousFacts = useMemo(
    () => (operation === "updated" ? buildFacts(previous, company, contactName) : undefined),
    [operation, previous, company, contactName],
  );

  const plan = useMemo(
    () => planWorkflow(definition, facts, operation, previousFacts),
    [definition, facts, operation, previousFacts],
  );

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Test with a pretend lead</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Nothing is created or changed. This shows what would happen, using the same code that runs for real.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="min-h-9 rounded-full border border-neutral-300 px-3.5 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
        >
          {open ? "Hide" : "Run a test"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 flex flex-col gap-4">
          <SelectField
            id="test-operation"
            name="operation"
            label="Simulate"
            value={operation}
            onChange={(event) => setOperation(event.target.value as EventOperation)}
          >
            <option value="created">A brand-new lead being created</option>
            <option value="updated">An existing lead being updated</option>
          </SelectField>

          <div className="grid gap-4 lg:grid-cols-2">
            <FieldValuesEditor
              idPrefix="current"
              title={operation === "updated" ? "After the update" : "The new lead"}
              values={current}
              onChange={setCurrent}
              company={company}
              contactName={contactName}
              onCompanyChange={setCompany}
              onContactNameChange={setContactName}
            />

            {operation === "updated" ? (
              <FieldValuesEditor
                idPrefix="previous"
                title="Before the update"
                values={previous}
                onChange={setPrevious}
                helperText='Only matters for a trigger set to "only when it starts matching" — leave equal to the current values to test "every time" instead.'
              />
            ) : (
              <div className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
                <p className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">What would happen</p>
                <PlanOutcome plan={plan} valid={valid} facts={facts} labelById={labelById} nodeLabelById={nodeLabelById} />
              </div>
            )}
          </div>

          {operation === "updated" ? (
            <div className="rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
              <p className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">What would happen</p>
              <div className="mt-2">
                <PlanOutcome plan={plan} valid={valid} facts={facts} labelById={labelById} nodeLabelById={nodeLabelById} />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PlanOutcome({
  plan,
  valid,
  facts,
  labelById,
  nodeLabelById,
}: {
  plan: ReturnType<typeof planWorkflow>;
  valid: boolean;
  facts: LeadFacts;
  labelById: Map<string, string>;
  nodeLabelById: Map<string, string>;
}) {
  return (
    <>
      {!valid ? (
        <p className="mb-2 text-sm text-amber-700">
          This workflow has problems to fix first. The test below still shows the path it would take, but it cannot
          be switched on as it is.
        </p>
      ) : null}

      <ol className="flex flex-col gap-1.5">
        {plan.trace.map((line, index) => (
          <li key={index} className="flex items-start gap-2 text-xs text-neutral-600">
            <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-neutral-400" />
            {line}
          </li>
        ))}
      </ol>

      {plan.triggered && plan.actions.length > 0 ? (
        <div className="mt-2 flex flex-col gap-2">
          {plan.actions.map((action) => (
            <ActionSummaryCard key={action.nodeId} action={action} facts={facts} labelById={labelById} nodeLabelById={nodeLabelById} />
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm text-neutral-500">Nothing would happen for this lead.</p>
      )}
    </>
  );
}

function ActionSummaryCard({
  action,
  facts,
  labelById,
  nodeLabelById,
}: {
  action: ReturnType<typeof planWorkflow>["actions"][number];
  facts: LeadFacts;
  labelById: Map<string, string>;
  nodeLabelById: Map<string, string>;
}) {
  const entry = getRegistryEntry(action.type);
  const config = action.config;

  const describeAssignee = (mode: unknown, assigneeId: unknown, rotation: unknown) =>
    mode === "RoundRobin"
      ? `the next person in a rotation of ${Array.isArray(rotation) ? rotation.length : 0}`
      : typeof assigneeId === "string"
        ? (labelById.get(assigneeId) ?? "somebody no longer on the team")
        : "nobody yet — pick an assignee";

  if (action.type === ACTION_TASK_CREATE) {
    const subject = typeof config.subject === "string" ? renderTemplate(config.subject, facts) : "(no subject)";
    const assignee = describeAssignee(config.assignmentMode, config.assigneeId, config.rotation);
    return (
      <div className="rounded-lg bg-white p-3 ring-1 ring-teal-100">
        <p className="text-[10px] font-bold tracking-wide text-teal-700 uppercase">{entry?.label ?? action.type}</p>
        <p className="mt-1 text-sm font-semibold text-neutral-900">{subject}</p>
        <p className="mt-0.5 text-xs text-neutral-500">
          {String(config.priority ?? "Medium")} priority {String(config.type ?? "Other")} task, due in{" "}
          {String(config.dueInDays ?? 0)} day{Number(config.dueInDays ?? 0) === 1 ? "" : "s"}, assigned to {assignee}.
        </p>
      </div>
    );
  }

  if (action.type === ACTION_LEAD_UPDATE) {
    const changes: string[] = [];
    if (typeof config.nextStep === "string" && config.nextStep) changes.push(`next step → "${config.nextStep}"`);
    if (typeof config.dealValue === "string" && config.dealValue) changes.push(`deal value → ${config.dealValue}`);
    if (typeof config.status === "string" && config.status) changes.push(`status → ${config.status}`);
    if (config.assignmentMode && config.assignmentMode !== "None") {
      changes.push(`owner → ${describeAssignee(config.assignmentMode, config.assigneeId, config.rotation)}`);
    }
    return (
      <div className="rounded-lg bg-white p-3 ring-1 ring-teal-100">
        <p className="text-[10px] font-bold tracking-wide text-teal-700 uppercase">{entry?.label ?? action.type}</p>
        <p className="mt-1 text-sm text-neutral-700">
          {changes.length > 0 ? changes.join(", ") : "No fields configured — this would be a no-op."}
        </p>
      </div>
    );
  }

  if (action.type === ACTION_CONTACT_CREATE) {
    const assignee = describeAssignee(config.assignmentMode, config.assigneeId, config.rotation);
    return (
      <div className="rounded-lg bg-white p-3 ring-1 ring-teal-100">
        <p className="text-[10px] font-bold tracking-wide text-teal-700 uppercase">{entry?.label ?? action.type}</p>
        <p className="mt-1 text-sm font-semibold text-neutral-900">{typeof config.name === "string" && config.name ? config.name : "(no name)"}</p>
        <p className="mt-0.5 text-xs text-neutral-500">Assigned to {assignee}.</p>
      </div>
    );
  }

  if (action.type === ACTION_TASK_UPDATE || action.type === ACTION_CONTACT_UPDATE) {
    const fieldKeys = action.type === ACTION_TASK_UPDATE ? ["subject", "description", "priority", "due_date", "type", "status"] : ["name", "company", "title", "email", "phone"];
    const changes = fieldKeys
      .filter((key) => typeof config[key] === "string" && config[key] !== "")
      .map((key) => `${key} → "${config[key]}"`);
    if (config.assignmentMode && config.assignmentMode !== "None") {
      changes.push(`owner → ${describeAssignee(config.assignmentMode, config.assigneeId, config.rotation)}`);
    }
    const sourceLabel = typeof config.sourceNodeId === "string" ? (nodeLabelById.get(config.sourceNodeId) ?? config.sourceNodeId) : "(no step chosen)";
    return (
      <div className="rounded-lg bg-white p-3 ring-1 ring-teal-100">
        <p className="text-[10px] font-bold tracking-wide text-teal-700 uppercase">{entry?.label ?? action.type}</p>
        <p className="mt-1 text-xs text-neutral-500">Targets the record from: {sourceLabel}</p>
        <p className="mt-0.5 text-sm text-neutral-700">
          {changes.length > 0 ? changes.join(", ") : "No fields configured — this would be a no-op."}
        </p>
      </div>
    );
  }

  if (action.type === ACTION_TASK_DEACTIVATE || action.type === ACTION_CONTACT_DEACTIVATE) {
    const sourceLabel = typeof config.sourceNodeId === "string" ? (nodeLabelById.get(config.sourceNodeId) ?? config.sourceNodeId) : "(no step chosen)";
    return (
      <div className="rounded-lg bg-white p-3 ring-1 ring-teal-100">
        <p className="text-[10px] font-bold tracking-wide text-teal-700 uppercase">{entry?.label ?? action.type}</p>
        <p className="mt-1 text-sm text-neutral-700">Deactivates the record from: {sourceLabel}</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-white p-3 ring-1 ring-teal-100">
      <p className="text-[10px] font-bold tracking-wide text-teal-700 uppercase">{entry?.label ?? action.type}</p>
    </div>
  );
}

function FieldValuesEditor({
  idPrefix,
  title,
  values,
  onChange,
  company,
  contactName,
  onCompanyChange,
  onContactNameChange,
  helperText,
}: {
  idPrefix: string;
  title: string;
  values: FieldValues;
  onChange: (values: FieldValues) => void;
  company?: string;
  contactName?: string;
  onCompanyChange?: (value: string) => void;
  onContactNameChange?: (value: string) => void;
  helperText?: string;
}) {
  const set = <K extends keyof FieldValues>(key: K, value: FieldValues[K]) => onChange({ ...values, [key]: value });

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
      <p className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">{title}</p>
      {helperText ? <p className="-mt-1.5 text-[11px] text-neutral-500">{helperText}</p> : null}

      <SelectField
        id={`${idPrefix}-source`}
        name="source"
        label="Source"
        value={values.source}
        onChange={(event) => set("source", event.target.value)}
      >
        {LEAD_SOURCES.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
        {/* A local UI sentinel only — translated to a real `source: null`
            below before it ever becomes a LeadFacts value. Not part of
            LEAD_SOURCES itself, which lists real values only (see its
            own note on why "no source" is never a fake list entry). */}
        <option value="Manual">Entered by hand (no source)</option>
      </SelectField>

      <SelectField
        id={`${idPrefix}-has-owner`}
        name="hasOwner"
        label="Has an owner?"
        value={values.hasOwner}
        onChange={(event) => set("hasOwner", event.target.value)}
      >
        <option value="no">No — unassigned</option>
        <option value="yes">Yes — already has an owner</option>
      </SelectField>

      <FormField
        id={`${idPrefix}-deal-value`}
        name="dealValue"
        label="Deal value"
        variant="filled"
        value={values.dealValue}
        onChange={(event) => set("dealValue", event.target.value)}
        placeholder="e.g. 50000"
      />

      <SelectField
        id={`${idPrefix}-status`}
        name="status"
        label="Status"
        value={values.status}
        onChange={(event) => set("status", event.target.value)}
      >
        <option value="Active">Active</option>
        <option value="Inactive">Inactive</option>
      </SelectField>

      <FormField
        id={`${idPrefix}-next-step`}
        name="nextStep"
        label="Next step"
        variant="filled"
        value={values.nextStep}
        onChange={(event) => set("nextStep", event.target.value)}
      />

      <FormField
        id={`${idPrefix}-expected-close-date`}
        name="expectedCloseDate"
        label="Expected close date"
        type="date"
        variant="filled"
        value={values.expectedCloseDate}
        onChange={(event) => set("expectedCloseDate", event.target.value)}
      />

      {company !== undefined && onCompanyChange ? (
        <FormField
          id={`${idPrefix}-company`}
          name="company"
          label="Company"
          variant="filled"
          value={company}
          onChange={(event) => onCompanyChange(event.target.value)}
        />
      ) : null}

      {contactName !== undefined && onContactNameChange ? (
        <FormField
          id={`${idPrefix}-contact`}
          name="contactName"
          label="Contact"
          variant="filled"
          value={contactName}
          onChange={(event) => onContactNameChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}
