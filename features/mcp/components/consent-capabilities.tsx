import type { CapabilitySummary } from "../lib/consent";

const OBJECT_NOUN: Record<CapabilitySummary["group"], string> = {
  Leads: "leads",
  Tasks: "tasks",
  Contacts: "contacts",
  Pipeline: "pipeline summary",
};

/** "See your leads", "See, create and update your tasks" — plain words
 *  for people who have never heard of OAuth scopes. */
function describe(summary: CapabilitySummary): string {
  const verbs = [summary.read ? "see" : null, summary.create ? "create" : null, summary.update ? "update" : null].filter(
    (verb): verb is string => verb !== null,
  );
  const phrase = verbs.length > 1 ? `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}` : verbs[0];
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)} your ${OBJECT_NOUN[summary.group]}`;
}

export function ConsentCapabilities({ capabilities, canChange }: { capabilities: CapabilitySummary[]; canChange: boolean }) {
  return (
    <div className="mt-5">
      <p className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">It will be able to</p>
      <ul className="mt-3 flex flex-col gap-2">
        {capabilities.map((summary) => (
          <li key={summary.group} className="flex items-start gap-3 text-sm text-neutral-800">
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                summary.create || summary.update ? "bg-violet-100 text-violet-700" : "bg-sky-100 text-sky-700"
              }`}
            >
              ✓
            </span>
            {describe(summary)}
          </li>
        ))}
      </ul>
      {!canChange ? (
        <p className="mt-3 text-xs text-neutral-500">It can&apos;t make any changes — your company allows read-only access.</p>
      ) : null}
    </div>
  );
}
