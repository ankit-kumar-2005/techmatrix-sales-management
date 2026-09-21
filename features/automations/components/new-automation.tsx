"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { MessageBanner } from "@/components/shared/message-banner";
import { generateWorkflowAction } from "../actions";
import { initialAiBuilderState } from "../form-state";
import { MAX_AI_PROMPT_LENGTH } from "../config/safeguards";
import { ACTION_TASK_CREATE, TRIGGER_LEAD_CREATED, getRegistryEntry } from "../registry/definitions";
import { AutomationBuilder } from "./automation-builder";
import type { TeamDirectoryEntry } from "@/types/lead";
import type { AutomationOrigin, WorkflowDefinition } from "@/types/automation";

type NewAutomationProps = {
  team: TeamDirectoryEntry[];
};

/**
 * THE "NEW AUTOMATION" ENTRY POINT — two doors, one room.
 *
 * Both paths are offered with the same visual weight, side by side,
 * neither presented as the default and neither as an add-on. And both
 * end in the SAME <AutomationBuilder>, rendered by this component with
 * different initial props: a blank canvas gets a starter definition, the
 * AI path gets a generated one. From the moment the builder mounts there
 * is no difference between them — same validation, same save action,
 * same test mode, same activation, same engine. Nothing downstream can
 * tell which door was used, because nothing downstream is told.
 */
export function NewAutomation({ team }: NewAutomationProps) {
  const [mode, setMode] = useState<"choose" | "build">("choose");
  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [origin, setOrigin] = useState<AutomationOrigin>("Manual");

  if (mode === "build") {
    return (
      <AutomationBuilder
        automationId={null}
        initialName={name}
        initialDescription={description}
        initialDefinition={definition}
        status="Draft"
        origin={origin}
        activeVersion={null}
        latestVersion={0}
        team={team}
      />
    );
  }

  function startBlank() {
    setOrigin("Manual");
    setName("");
    setDescription("");
    // A starter trigger rather than a genuinely empty canvas. An empty
    // React Flow pane gives no clue what to do first, and every valid
    // workflow needs exactly this node anyway — so it is pre-placed and
    // fully editable, not a template with opinions baked in.
    setDefinition(buildStarterDefinition());
    setMode("build");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---- Door 1: blank canvas ---- */}
        <section className="flex flex-col rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
          <span
            aria-hidden="true"
            className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-sm"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M12 8v8M8 12h8" strokeLinecap="round" />
            </svg>
          </span>
          <h2 className="mt-3 text-base font-semibold text-neutral-900">Build it yourself</h2>
          <p className="mt-1 flex-1 text-sm leading-relaxed text-neutral-500">
            Start from a blank canvas and drag the steps together. You pick the trigger, add conditions if you need
            them, and choose what happens.
          </p>
          <button
            type="button"
            onClick={startBlank}
            className="mt-5 min-h-11 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md"
          >
            Open a blank canvas
          </button>
        </section>

        {/* ---- Door 2: describe it ---- */}
        <AiDoor
          team={team}
          onAccept={(result) => {
            setOrigin("AI");
            setName(result.name);
            setDescription(result.description);
            setDefinition(result.definition);
            setMode("build");
          }}
        />
      </div>
    </div>
  );
}

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-3 min-h-11 w-full rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Working on it..." : "Describe it and continue"}
    </button>
  );
}

function AiDoor({
  team,
  onAccept,
}: {
  team: TeamDirectoryEntry[];
  onAccept: (result: { name: string; description: string; definition: WorkflowDefinition }) => void;
}) {
  const [state, formAction] = useActionState(generateWorkflowAction, initialAiBuilderState);
  const result = state.result;

  return (
    <section className="flex flex-col rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
      <span
        aria-hidden="true"
        className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-violet-600 text-white shadow-sm"
      >
        <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth={2}>
          <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z" strokeLinejoin="round" />
          <path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" strokeLinejoin="round" />
        </svg>
      </span>
      <h2 className="mt-3 text-base font-semibold text-neutral-900">Describe what you want</h2>
      <p className="mt-1 text-sm leading-relaxed text-neutral-500">
        Write it in plain English. You will get a draft on the same canvas, which you can change before anything is
        saved or switched on.
      </p>

      <form action={formAction} className="mt-4 flex flex-1 flex-col">
        <label htmlFor="ai-prompt" className="sr-only">
          Describe the automation you want
        </label>
        <textarea
          id="ai-prompt"
          name="prompt"
          rows={3}
          maxLength={MAX_AI_PROMPT_LENGTH}
          placeholder="When a new IndiaMART lead comes in, create a high-priority call task due tomorrow and rotate it between Ankit and Priya."
          className={`w-full resize-y rounded-lg border bg-neutral-100 px-3.5 py-2.5 text-sm text-neutral-900 outline-none transition-all duration-200 focus:border-sky-500 focus:bg-white focus:ring-2 focus:ring-sky-500/30 ${
            state.fieldErrors?.prompt ? "border-red-400" : "border-transparent"
          }`}
        />
        {state.fieldErrors?.prompt ? (
          <p className="mt-1 text-xs text-red-600">{state.fieldErrors.prompt}</p>
        ) : null}
        {state.formError ? (
          <div className="mt-2">
            <MessageBanner tone="error">{state.formError}</MessageBanner>
          </div>
        ) : null}

        <GenerateButton />
      </form>

      {/* ---- The three answers ---- */}
      {result?.status === "NEEDS_CLARIFICATION" ? (
        <div className="mt-4 rounded-xl bg-amber-50 p-4 ring-1 ring-amber-100">
          <p className="text-xs font-bold tracking-wide text-amber-800 uppercase">A couple of questions first</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-900">
            Rather than guess, here is what is still unclear. Add the answers to your description above and try
            again.
          </p>
          <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-sm text-amber-900">
            {result.questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {result?.status === "UNSUPPORTED" ? (
        <div className="mt-4 rounded-xl bg-neutral-50 p-4 ring-1 ring-neutral-200">
          <p className="text-xs font-bold tracking-wide text-neutral-600 uppercase">Not possible yet</p>
          <p className="mt-1 text-sm leading-relaxed text-neutral-700">{result.reason}</p>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            Nothing was created. You can change what you asked for, or build something else on a blank canvas.
          </p>
        </div>
      ) : null}

      {result?.status === "READY" ? (
        <div className="mt-4 rounded-xl bg-teal-50 p-4 ring-1 ring-teal-100">
          <p className="text-xs font-bold tracking-wide text-teal-800 uppercase">Draft ready</p>
          <p className="mt-1 text-sm font-semibold text-neutral-900">{result.name}</p>
          <p className="mt-1 text-sm leading-relaxed text-neutral-700">{result.summary}</p>
          <p className="mt-2 text-xs leading-relaxed text-neutral-500">
            Nothing has been saved yet. Opening this puts it on the canvas, where you still have to save it and then
            switch it on yourself.
          </p>
          <button
            type="button"
            onClick={() =>
              onAccept({ name: result.name, description: result.description, definition: result.definition })
            }
            className="mt-3 min-h-11 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all duration-200 hover:from-blue-700 hover:to-violet-700"
          >
            Open it on the canvas
          </button>
        </div>
      ) : null}

      {team.length === 0 ? (
        <p className="mt-3 text-xs text-neutral-400">
          Nobody active is available to assign work to yet, so a generated workflow will ask you who it is for.
        </p>
      ) : null}
    </section>
  );
}

/** The blank-canvas starting point: the one node every workflow must
 *  have, with the registry's own defaults. Built from the registry
 *  rather than written out, so it cannot drift from what the palette
 *  would have added. */
function buildStarterDefinition(): WorkflowDefinition {
  const trigger = getRegistryEntry(TRIGGER_LEAD_CREATED);
  const action = getRegistryEntry(ACTION_TASK_CREATE);

  return {
    nodes: [
      {
        id: "n-trigger",
        kind: "trigger",
        type: TRIGGER_LEAD_CREATED,
        position: { x: 0, y: 0 },
        config: { ...(trigger?.defaultConfig ?? {}) },
      },
      {
        id: "n-action",
        kind: "action",
        type: ACTION_TASK_CREATE,
        position: { x: 320, y: 0 },
        config: { ...(action?.defaultConfig ?? {}) },
      },
    ],
    edges: [{ id: "e-1", source: "n-trigger", target: "n-action" }],
  };
}
