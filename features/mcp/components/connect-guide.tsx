"use client";

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { BRAND_NAME } from "@/lib/brand";

type Tab = { id: string; label: string; steps: ReactNode[] };

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex min-w-0 items-stretch gap-2">
      <code
        aria-label={label}
        className="min-w-0 flex-1 truncate rounded-xl bg-neutral-50 px-3 py-2.5 font-mono text-[13px] text-neutral-800 ring-1 ring-neutral-200"
      >
        {value}
      </code>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded-xl bg-neutral-900 px-4 text-sm font-semibold text-white transition hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2"
      >
        <span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}

/**
 * "Connect your AI" — the server URL and per-client steps. There is
 * deliberately NO one-click "Add to Claude" button: the prefilled
 * add-connector deep link was not verified to work, and an unverified
 * button that fails silently is worse than three clear steps.
 */
export function ConnectGuide({ serverUrl, serverSlug }: { serverUrl: string; serverSlug: string }) {
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const cliCommand = `claude mcp add --transport http ${serverSlug} ${serverUrl}`;

  const tabs: Tab[] = [
    {
      id: "claude",
      label: "Claude (web & desktop)",
      steps: [
        <>In Claude, open <strong>Settings → Connectors</strong> and choose <strong>Add custom connector</strong>.</>,
        <>Name it <strong>{BRAND_NAME}</strong> and paste the server URL above.</>,
        <>Click <strong>Connect</strong>, sign in with your {BRAND_NAME} account, and choose <strong>Allow</strong>.</>,
      ],
    },
    {
      id: "team",
      label: "Claude Team & Enterprise",
      steps: [
        <>An organization <strong>Owner</strong> adds the connector once, in the organization&apos;s connector settings, using the server URL above.</>,
        <>Each person then finds {BRAND_NAME} under <strong>Settings → Connectors</strong> and clicks <strong>Connect</strong>.</>,
        <>Everyone signs in with their <strong>own</strong> {BRAND_NAME} account, so each person only ever sees their own data.</>,
      ],
    },
    {
      id: "code",
      label: "Claude Code",
      steps: [
        <>Run this in a terminal: <span className="mt-2 block"><CopyField value={cliCommand} label="Claude Code command" /></span></>,
        <>Start Claude Code, type <strong>/mcp</strong>, pick <strong>{serverSlug}</strong> and choose <strong>Authenticate</strong>.</>,
        <>Your browser opens {BRAND_NAME}: sign in and choose <strong>Allow</strong>.</>,
      ],
    },
    {
      id: "other",
      label: "Other MCP clients",
      steps: [
        <>Add a <strong>remote MCP server</strong> using <strong>Streamable HTTP</strong> and the server URL above.</>,
        <>The client must support OAuth 2.1 sign-in with Dynamic Client Registration (it discovers everything from the URL).</>,
        <>{BRAND_NAME} currently approves Claude&apos;s sign-in addresses only; ask {BRAND_NAME} support to allow another client.</>,
      ],
    },
  ];

  const [active, setActive] = useState(0);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight" ? (index === last ? 0 : index + 1)
      : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1)
      : event.key === "Home" ? 0
      : event.key === "End" ? last
      : null;
    if (next === null) return;
    event.preventDefault();
    setActive(next);
    tabRefs.current[next]?.focus();
  }

  return (
    <section aria-labelledby={`${baseId}-title`} className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5">
      <h2 id={`${baseId}-title`} className="text-lg font-semibold text-neutral-900">Connect your AI</h2>
      <p className="mt-1 text-sm text-neutral-600">Everyone in your company uses the same address.</p>

      <div className="mt-4">
        <CopyField value={serverUrl} label="Server URL" />
        <p className="mt-2 text-xs leading-relaxed text-neutral-500">
          This URL is safe to share. It holds no password or key — every person still signs in with their own {BRAND_NAME}{" "}
          account, and only sees what they can already see in {BRAND_NAME}.
        </p>
      </div>

      <div role="tablist" aria-label="Setup instructions" className="mt-6 flex gap-1 overflow-x-auto border-b border-neutral-200">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${baseId}-tab-${tab.id}`}
            aria-selected={active === index}
            aria-controls={`${baseId}-panel-${tab.id}`}
            tabIndex={active === index ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${
              active === index ? "border-violet-600 text-violet-700" : "border-transparent text-neutral-500 hover:text-neutral-800"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={active !== index}
          className="pt-4"
        >
          <ol className="flex flex-col gap-3">
            {tab.steps.map((step, stepIndex) => (
              <li key={stepIndex} className="flex gap-3 text-sm leading-relaxed text-neutral-700">
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-600 to-violet-600 text-xs font-bold text-white"
                >
                  {stepIndex + 1}
                </span>
                <div className="min-w-0 flex-1">{step}</div>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}
