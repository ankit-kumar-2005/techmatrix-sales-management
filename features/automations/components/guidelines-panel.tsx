import { PUBLIC_SAFEGUARDS } from "../config/safeguards";
import { REGISTRY_ENTRIES, SUBJECT_TOKENS } from "../registry/definitions";

/**
 * "What automations can do, and where the edges are" — the learning
 * surface.
 *
 * EVERY WORD OF IT IS READ FROM THE REGISTRY AND THE SAFEGUARDS CONFIG.
 * There is no hand-written list of capabilities here and no hand-typed
 * number. An action added to the registry documents itself on this page;
 * a limit changed in safeguards.ts changes here too. That is the point —
 * a help page that is maintained separately from the thing it describes
 * is a help page that will eventually lie, and this one cannot.
 *
 * The limits shown are PUBLIC_SAFEGUARDS, a deliberate subset: the
 * numbers an admin needs in order to build something that will not be
 * rejected, and not the operational ones (retry budget, claim timeout)
 * that would only tell a probe where the edges are.
 */
export function GuidelinesPanel() {
  const byKind = {
    trigger: REGISTRY_ENTRIES.filter((entry) => entry.kind === "trigger"),
    condition: REGISTRY_ENTRIES.filter((entry) => entry.kind === "condition"),
    action: REGISTRY_ENTRIES.filter((entry) => entry.kind === "action"),
  };

  return (
    <div className="flex flex-col gap-5 rounded-2xl bg-white p-5 shadow-sm ring-1 ring-black/5 sm:p-6">
      <section>
        <h3 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">How an automation runs</h3>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-sm leading-relaxed text-neutral-600">
          <li>
            It runs on its own, in the background, for <strong>new leads only</strong> — switching one on never goes
            back over leads you already have.
          </li>
          <li>
            A change you save becomes a new version and does not go live until you switch it on again. Whatever is
            already running keeps running the version it was switched on with.
          </li>
          <li>
            Every run is recorded, including the ones that were skipped or stopped by a safety limit, so an
            automation that quietly does nothing is never a mystery.
          </li>
          <li>Only administrators can create, change or switch on an automation, or see this history.</li>
        </ul>
      </section>

      <section>
        <h3 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">What you can build with</h3>
        <div className="mt-2 flex flex-col gap-3">
          {(
            [
              ["trigger", "Triggers — what starts it"],
              ["condition", "Conditions — how it branches"],
              ["action", "Actions — what it does"],
            ] as const
          ).map(([kind, title]) => (
            <div key={kind}>
              <p className="text-[11px] font-bold tracking-wide text-neutral-400 uppercase">{title}</p>
              <ul className="mt-1 flex flex-col gap-2">
                {byKind[kind].map((entry) => (
                  <li key={entry.key} className="rounded-lg bg-neutral-50 p-3 ring-1 ring-neutral-100">
                    <p className="text-sm font-semibold text-neutral-900">{entry.label}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-neutral-600">{entry.description}</p>
                    <p className="mt-1 text-xs text-neutral-500">
                      <span className="font-semibold">For example:</span> {entry.example}
                    </p>
                    {entry.limitations.length > 0 ? (
                      <ul className="mt-1.5 flex list-disc flex-col gap-0.5 pl-4 text-[11px] leading-relaxed text-neutral-500">
                        {entry.limitations.map((limitation) => (
                          <li key={limitation}>{limitation}</li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Placeholders</h3>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          Usable in a task subject or description. Anything else you type is left exactly as written.
        </p>
        <ul className="mt-2 flex flex-col gap-1">
          {SUBJECT_TOKENS.map((token) => (
            <li key={token.token} className="text-xs text-neutral-600">
              <code className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-800">
                {token.token}
              </code>{" "}
              — {token.description}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h3 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">Limits</h3>
        <p className="mt-1 text-xs leading-relaxed text-neutral-500">
          These apply to every automation, whether you built it yourself or described it in plain English.
        </p>
        <dl className="mt-2 flex flex-col gap-2">
          {PUBLIC_SAFEGUARDS.map((limit) => (
            <div key={limit.label} className="flex items-start gap-3">
              <dd className="w-16 shrink-0 text-sm font-bold text-neutral-900">{limit.value}</dd>
              <div className="min-w-0">
                <dt className="text-xs font-semibold text-neutral-700">{limit.label}</dt>
                <p className="text-[11px] leading-relaxed text-neutral-500">{limit.detail}</p>
              </div>
            </div>
          ))}
        </dl>
      </section>

      <section>
        <h3 className="text-xs font-bold tracking-wide text-neutral-500 uppercase">About the AI builder</h3>
        <ul className="mt-2 flex list-disc flex-col gap-1.5 pl-4 text-sm leading-relaxed text-neutral-600">
          <li>
            It can only pick from the triggers, conditions and actions listed above. It cannot write code, run a
            query, or invent a step that does not exist here.
          </li>
          <li>
            If your description is missing something, it asks rather than guessing. Anything subjective — urgent,
            important, high-value — is something it will ask you to define.
          </li>
          <li>If you ask for something it cannot do, it says so instead of substituting the nearest thing.</li>
          <li>
            What it produces is always a draft. You save it, and then switch it on, yourself — and it goes through
            exactly the same checks and the same limits as one you built by hand.
          </li>
        </ul>
      </section>
    </div>
  );
}
