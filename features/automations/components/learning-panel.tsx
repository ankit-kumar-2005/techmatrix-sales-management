import type { RegistryEntry } from "../registry/definitions";

type LearningPanelProps = {
  /** The selected node's registry entry, or undefined when nothing is
   *  selected (or the node's type is no longer registered) — the panel
   *  falls back to general orientation content either way. */
  entry: RegistryEntry | undefined;
};

/**
 * THE LEARN TAB — contextual to whatever is selected, generated from the
 * SAME registry the palette and the config panel already read.
 *
 * Every sentence about what an element does, its example, its
 * limitations and its configuration options is pulled from
 * `RegistryEntry` — never a second, hand-maintained copy. That is what
 * keeps this honest: a capability this app cannot do has no registry
 * entry to describe it, so there is nothing here that could claim
 * something unsupported. The only text NOT sourced from the registry is
 * the small set of general, node-independent concepts below (what a
 * trigger even is, AND vs OR, drafts vs versions) — those describe the
 * BUILDER itself, not any one capability, so there is no registry field
 * for them to be pulled from.
 *
 * <details>/<summary> throughout: native, keyboard-operable,
 * screen-reader-announced expand/collapse with no bespoke JS state.
 */
export function LearningPanel({ entry }: LearningPanelProps) {
  if (!entry) {
    return (
      <div className="flex h-full flex-col gap-3 overflow-y-auto p-4">
        <p className="text-xs leading-relaxed text-neutral-500">
          Select a step to see exactly how it works, or start with the basics below.
        </p>
        <GeneralTopics />
      </div>
    );
  }

  const whenToUse =
    entry.kind === "trigger"
      ? "Use this to decide what starts the whole automation. Every workflow needs exactly one."
      : entry.kind === "condition"
        ? "Use this to send different leads down different paths, without needing a separate automation for each case."
        : entry.kind === "decision"
          ? "Use this instead of a plain condition when a lead can land in more than two distinct groups — each with its own named path — rather than just a yes and a no."
          : entry.kind === "assignment"
            ? "Use this to prepare a value once and reuse it in more than one place later in the same run, instead of repeating the same text or calculation in every action."
            : "Use this for the part that actually changes something — everything before it just decides whether this runs.";

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-4">
      <Section title="What it does" defaultOpen>
        <p>{entry.description}</p>
      </Section>

      <Section title="When to use it">
        <p>{whenToUse}</p>
      </Section>

      <Section title="Example">
        <p>{entry.example}</p>
      </Section>

      {entry.fields.length > 0 ? (
        <Section title="Configuration options">
          <ul className="flex flex-col gap-2">
            {entry.fields.map((field) => (
              <li key={field.name}>
                <p className="text-xs font-semibold text-neutral-800">
                  {field.label}
                  {field.required ? "" : " (optional)"}
                </p>
                {field.helperText ? <p className="text-[11px] text-neutral-500">{field.helperText}</p> : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Limitations">
        <ul className="flex list-disc flex-col gap-1 pl-4">
          {entry.limitations.map((limitation) => (
            <li key={limitation}>{limitation}</li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function GeneralTopics() {
  const topics: Array<{ title: string; body: React.ReactNode }> = [
    {
      title: "What is a trigger?",
      body: (
        <p>
          A trigger is what starts an automation. In this app that is always something happening to a Lead — one
          being created, updated, or either. Every workflow has exactly one, and it is always the leftmost node.
        </p>
      ),
    },
    {
      title: "Created vs. Updated vs. either",
      body: (
        <p>
          &ldquo;Created&rdquo; only looks at brand-new leads. &ldquo;Updated&rdquo; only looks at edits to leads
          that already existed. &ldquo;Created or updated&rdquo; watches both. An automation set to Created never
          re-runs just because someone later edits that lead.
        </p>
      ),
    },
    {
      title: "\"Only when it starts matching\"",
      body: (
        <p>
          On an update trigger, this means the automation only runs when the lead goes from NOT matching your
          conditions to matching them on this specific edit — not every time a matching lead is saved again. Useful
          for &ldquo;the moment a deal crosses ₹50,000&rdquo; rather than every edit to a deal already above it.
        </p>
      ),
    },
    {
      title: "AND vs. OR",
      body: (
        <p>
          AND means every condition in the group has to be true. OR means any one of them is enough. You can nest
          groups inside groups — for example, (source is IndiaMART AND deal value is over ₹50,000) OR (source is
          Website AND status is Active).
        </p>
      ),
    },
    {
      title: "What is an action?",
      body: (
        <p>
          An action is the part that actually does something — creates a task, or changes a field on the lead. A
          workflow can have several actions after its conditions, and each only runs if the path leading to it was
          taken.
        </p>
      ),
    },
    {
      title: "Fixed vs. round-robin assignment",
      body: (
        <p>
          Fixed always picks the same person. Round-robin hands work to whoever is next in a list you choose,
          rotating one step further each time the action runs — shared across every action in the same automation
          that also rotates.
        </p>
      ),
    },
    {
      title: "Drafts, versions and activation",
      body: (
        <p>
          Saving never changes what is currently running — it creates a new version. Only switching the automation
          on makes that version live. This means you can safely edit an automation that is already active without
          affecting leads it is processing right now.
        </p>
      ),
    },
    {
      title: "Why safety limits exist",
      body: (
        <p>
          This feature runs unattended, so it has hard limits on how many actions one event can trigger and how deep
          a chain of automations can go — the same limits shown in the guidelines panel. They exist so a
          misconfigured workflow fails safely instead of running away.
        </p>
      ),
    },
    {
      title: "How loops are prevented",
      body: (
        <p>
          If an action could itself cause the same automation to run again, the engine tracks the whole chain back
          to its origin and refuses to run an automation a second time within one chain — recorded as a stopped run,
          never a silent skip.
        </p>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      {topics.map((topic) => (
        <Section key={topic.title} title={topic.title}>
          {topic.body}
        </Section>
      ))}
    </div>
  );
}

function Section({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-lg bg-neutral-50 ring-1 ring-neutral-100 open:ring-sky-100"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-semibold text-neutral-700 marker:content-none">
        {title}
        <ChevronIcon className="h-3.5 w-3.5 text-neutral-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-3 pb-3 text-xs leading-relaxed text-neutral-600">{children}</div>
    </details>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} stroke="currentColor" strokeWidth={2}>
      <path d="M5 7.5l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
