"use client";

import { useMemo, useState } from "react";
import { SelectField } from "@/components/shared/select-field";
import { FormField } from "@/components/shared/form-field";
import { INTEGRATION_SOURCES } from "@/types/integration";
import { getOwnerDisplayLabels } from "@/features/leads/lib/owner-display";
import { getRegistryEntry } from "../registry/definitions";
import { planWorkflow, renderTemplate, type LeadFacts } from "../lib/plan-workflow";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { WorkflowDefinition } from "@/types/automation";

type TestModePanelProps = {
  definition: WorkflowDefinition;
  valid: boolean;
  team: TeamDirectoryEntry[];
};

/**
 * TEST MODE — runs the workflow against a lead you invent, and writes
 * nothing.
 *
 * IT IS NOT A SIMULATION OF THE ENGINE, IT IS THE ENGINE'S OWN DECISION
 * FUNCTION. planWorkflow() is the exact function the execution engine
 * calls, imported here unchanged. The only difference between a test and
 * a real run is what happens afterwards: the engine hands the result to
 * an executor, and this panel renders it. So what you see here is not an
 * approximation of what will happen at 3am — it is the same decision,
 * made by the same code, over the same definition.
 *
 * That is also why this is safe. planWorkflow is pure: no Supabase, no
 * fetch, no clock. There is no path from this panel to a write, because
 * the function it calls has no way to perform one.
 */
export function TestModePanel({ definition, valid, team }: TestModePanelProps) {
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<string>(INTEGRATION_SOURCES[0]);
  const [hasOwner, setHasOwner] = useState("no");
  const [company, setCompany] = useState("Acme Industries");
  const [contactName, setContactName] = useState("Priya Sharma");

  const labelById = useMemo(() => getOwnerDisplayLabels(team), [team]);

  const facts = useMemo<LeadFacts>(
    () => ({
      leadId: "00000000-0000-0000-0000-000000000000",
      source: source === "Manual" ? null : source,
      hasOwner: hasOwner === "yes",
      company,
      contactName,
    }),
    [source, hasOwner, company, contactName],
  );

  const plan = useMemo(() => planWorkflow(definition, facts), [definition, facts]);

  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Test with a pretend lead</h2>
          <p className="mt-0.5 text-xs text-neutral-500">
            Nothing is created. This shows what would happen, using the same code that runs for real.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="min-h-9 rounded-full border border-neutral-300 px-3.5 py-1.5 text-xs font-semibold text-neutral-700 transition-colors hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-sky-500/40 focus-visible:outline-none"
        >
          {open ? "Hide" : "Run a test"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
            <p className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">Pretend lead</p>
            <SelectField
              id="test-source"
              name="source"
              label="Came from"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            >
              {INTEGRATION_SOURCES.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
              <option value="Manual">Entered by hand (no source)</option>
            </SelectField>
            <SelectField
              id="test-has-owner"
              name="hasOwner"
              label="Arrived assigned?"
              value={hasOwner}
              onChange={(event) => setHasOwner(event.target.value)}
            >
              <option value="no">No — unassigned</option>
              <option value="yes">Yes — already has an owner</option>
            </SelectField>
            <FormField
              id="test-company"
              name="company"
              label="Company"
              variant="filled"
              value={company}
              onChange={(event) => setCompany(event.target.value)}
            />
            <FormField
              id="test-contact"
              name="contactName"
              label="Contact"
              variant="filled"
              value={contactName}
              onChange={(event) => setContactName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-3 rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-100">
            <p className="text-[10px] font-bold tracking-wide text-neutral-500 uppercase">What would happen</p>

            {!valid ? (
              <p className="text-sm text-amber-700">
                This workflow has problems to fix first. The test below still shows the path it would take, but it
                cannot be switched on as it is.
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
              <div className="flex flex-col gap-2">
                {plan.actions.map((action) => {
                  const entry = getRegistryEntry(action.type);
                  const config = action.config;
                  const subject =
                    typeof config.subject === "string" ? renderTemplate(config.subject, facts) : "(no subject)";
                  const assignee =
                    config.assignmentMode === "RoundRobin"
                      ? `the next person in a rotation of ${Array.isArray(config.rotation) ? config.rotation.length : 0}`
                      : typeof config.assigneeId === "string"
                        ? (labelById.get(config.assigneeId) ?? "somebody no longer on the team")
                        : "nobody yet — pick an assignee";

                  return (
                    <div key={action.nodeId} className="rounded-lg bg-white p-3 ring-1 ring-teal-100">
                      <p className="text-[10px] font-bold tracking-wide text-teal-700 uppercase">
                        {entry?.label ?? action.type}
                      </p>
                      <p className="mt-1 text-sm font-semibold text-neutral-900">{subject}</p>
                      <p className="mt-0.5 text-xs text-neutral-500">
                        {String(config.priority ?? "Medium")} priority {String(config.type ?? "Other")} task, due in{" "}
                        {String(config.dueInDays ?? 0)} day
                        {Number(config.dueInDays ?? 0) === 1 ? "" : "s"}, assigned to {assignee}.
                      </p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-neutral-500">Nothing would be created for this lead.</p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
