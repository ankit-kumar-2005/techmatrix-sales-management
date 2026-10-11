"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageBanner } from "@/components/shared/message-banner";
import { BRAND_NAME } from "@/lib/brand";
import { formatRelativeTime } from "@/utils/format";
import {
  setAiConnectionsEnabledAction,
  setAllowChangesAction,
  setPersonBlockedAction,
  setToolEnabledAction,
  type McpActionResult,
} from "../actions";
import type { ActivityRow, AiConnectionsAdminData, CatalogTool, ConnectionRow, TeamMemberRow } from "../lib/admin-data";
import type { McpToolGroup } from "../registry/types";
import { ConnectGuide } from "./connect-guide";
import { Switch } from "./switch";

type Props = {
  data: AiConnectionsAdminData;
  serverUrl: string;
  serverSlug: string;
  nowMs: number;
};

const GROUPS: McpToolGroup[] = ["Leads", "Tasks", "Contacts", "Pipeline"];

const CAPABILITY_BADGE: Record<CatalogTool["capability"], { label: string; className: string }> = {
  read: { label: "Read", className: "bg-sky-50 text-sky-700 ring-sky-100" },
  create: { label: "Create", className: "bg-violet-50 text-violet-700 ring-violet-100" },
  update: { label: "Update", className: "bg-amber-50 text-amber-700 ring-amber-100" },
};

const ACTIVITY_BADGE: Record<ActivityRow["status"], { label: string; className: string }> = {
  ok: { label: "Done", className: "bg-emerald-50 text-emerald-700 ring-emerald-100" },
  denied: { label: "Not allowed", className: "bg-red-50 text-red-700 ring-red-100" },
  invalid: { label: "Invalid request", className: "bg-amber-50 text-amber-700 ring-amber-100" },
  error: { label: "Failed", className: "bg-neutral-100 text-neutral-700 ring-neutral-200" },
  rate_limited: { label: "Rate limited", className: "bg-orange-50 text-orange-700 ring-orange-100" },
};

const card = "rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5";

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${className}`}>
      {label}
    </span>
  );
}

export function AiConnectionsAdmin({ data, serverUrl, serverSlug, nowMs }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Optimistic copies of what the switches show; the server action is the
  // source of truth and router.refresh() re-reads it afterwards.
  const [enabled, setEnabled] = useState(data.enabled);
  const [allowWrites, setAllowWrites] = useState(data.allowWrites);
  const [toolState, setToolState] = useState<Record<string, boolean>>(
    Object.fromEntries(data.catalog.map((tool) => [tool.name, tool.enabled])),
  );
  const [query, setQuery] = useState("");

  function run(apply: () => void, revert: () => void, action: () => Promise<McpActionResult>) {
    setError(null);
    apply();
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        revert();
        setError(result.error);
      }
      router.refresh();
    });
  }

  const status = !enabled
    ? { label: "Off", className: "bg-neutral-100 text-neutral-600 ring-neutral-200" }
    : data.activePeople > 0
      ? {
          label: `Used by ${data.activePeople} ${data.activePeople === 1 ? "person" : "people"}`,
          className: "bg-emerald-50 text-emerald-700 ring-emerald-100",
        }
      : { label: "Ready", className: "bg-sky-50 text-sky-700 ring-sky-100" };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.catalog.filter(
      (tool) => !needle || `${tool.label} ${tool.summary} ${tool.group}`.toLowerCase().includes(needle),
    );
  }, [data.catalog, query]);

  return (
    <div className="flex flex-col gap-6">
      {error ? (
        <MessageBanner tone="error">
          <p>{error}</p>
        </MessageBanner>
      ) : null}

      {/* Hero + status */}
      <section className="relative overflow-hidden rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5 sm:p-8">
        <div aria-hidden="true" className="pointer-events-none absolute -top-16 -right-16 h-48 w-48 rounded-full bg-violet-300/25 blur-3xl" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-20 -left-10 h-48 w-48 rounded-full bg-blue-300/20 blur-3xl" />
        <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="bg-gradient-to-r from-blue-600 to-violet-600 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
                Use {BRAND_NAME} inside Claude
              </h2>
              <Badge label={status.label} className={status.className} />
            </div>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-neutral-600">
              Let your team ask Claude about their pipeline, tasks and contacts in plain language — and, if you allow it, make
              updates. Each person signs in with their own account.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm font-medium text-neutral-700">{enabled ? "On" : "Off"}</span>
            <Switch
              size="lg"
              label="AI connections for your company"
              checked={enabled}
              disabled={pending}
              onChange={(next) =>
                run(() => setEnabled(next), () => setEnabled(!next), () => setAiConnectionsEnabledAction(next))
              }
            />
          </div>
        </div>
      </section>

      {/* Role explainer */}
      <section className={card} aria-labelledby="mcp-access-title">
        <h2 id="mcp-access-title" className="text-lg font-semibold text-neutral-900">
          Claude sees exactly what each person sees
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Nothing new is opened up. Every request runs as the person who asked, with their own role and team.
        </p>
        <div className="mt-5 grid gap-3 sm:grid-cols-3">
          {[
            { role: "Admin", scope: "The whole company", bar: "w-full" },
            { role: "Manager", scope: "Their own and their team's records", bar: "w-2/3" },
            { role: "Sales Rep", scope: "Only their own records", bar: "w-1/3" },
          ].map((item) => (
            <div key={item.role} className="rounded-xl bg-gradient-to-b from-neutral-50 to-white p-4 ring-1 ring-neutral-200">
              <p className="text-sm font-semibold text-neutral-900">{item.role}</p>
              <p className="mt-1 text-xs text-neutral-600">{item.scope}</p>
              <div className="mt-3 h-1.5 rounded-full bg-neutral-200" aria-hidden="true">
                <div className={`h-1.5 rounded-full bg-gradient-to-r from-blue-600 to-violet-600 ${item.bar}`} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Capability catalog */}
      <section className={card} aria-labelledby="mcp-catalog-title">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 id="mcp-catalog-title" className="text-lg font-semibold text-neutral-900">What Claude can do</h2>
            <p className="mt-1 text-sm text-neutral-600">Turning something on makes it available — each person&apos;s own permissions still apply.</p>
          </div>
          <label className="sm:w-64">
            <span className="sr-only">Search capabilities</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search capabilities"
              className="w-full rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-neutral-300 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-violet-500"
            />
          </label>
        </div>

        <div className="mt-5 rounded-xl bg-amber-50/60 p-4 ring-1 ring-amber-100">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-neutral-900">Allow changes</p>
              <p className="mt-1 text-xs leading-relaxed text-neutral-600">
                Lets Claude create and update records for people who ask — always as them, with the same checks as the{" "}
                {BRAND_NAME} forms. Claude asks the person to confirm before each change. Nothing can be deleted.
              </p>
            </div>
            <Switch
              label="Allow changes through AI apps"
              checked={allowWrites}
              disabled={pending}
              onChange={(next) =>
                run(() => setAllowWrites(next), () => setAllowWrites(!next), () => setAllowChangesAction(next))
              }
            />
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-6">
          {GROUPS.map((group) => {
            const tools = filtered.filter((tool) => tool.group === group);
            if (tools.length === 0) return null;
            return (
              <div key={group}>
                <h3 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">{group}</h3>
                <ul className="mt-2 divide-y divide-neutral-100 rounded-xl ring-1 ring-neutral-200">
                  {tools.map((tool) => {
                    const locked = tool.kind === "write" && !allowWrites;
                    const badge = CAPABILITY_BADGE[tool.capability];
                    return (
                      <li key={tool.name} className="flex items-center gap-4 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium text-neutral-900">{tool.label}</p>
                            <Badge label={badge.label} className={badge.className} />
                          </div>
                          <p className="mt-0.5 text-xs text-neutral-500">
                            {tool.summary}
                            {locked ? " Turn on “Allow changes” to use this." : ""}
                          </p>
                        </div>
                        <Switch
                          label={tool.label}
                          checked={toolState[tool.name] && !locked}
                          disabled={pending || locked}
                          onChange={(next) =>
                            run(
                              () => setToolState((state) => ({ ...state, [tool.name]: next })),
                              () => setToolState((state) => ({ ...state, [tool.name]: !next })),
                              () => setToolEnabledAction(tool.name, next),
                            )
                          }
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          {filtered.length === 0 ? <p className="text-sm text-neutral-500">No capabilities match “{query}”.</p> : null}
        </div>
      </section>

      <ConnectGuide serverUrl={serverUrl} serverSlug={serverSlug} />

      <PeopleAndAccess team={data.team} connections={data.connections} nowMs={nowMs} pending={pending} run={run} />

      <section className={card} aria-labelledby="mcp-activity-title">
        <h2 id="mcp-activity-title" className="text-lg font-semibold text-neutral-900">Recent activity</h2>
        {data.activity.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500">Nothing yet. Activity appears here once someone uses {BRAND_NAME} from Claude.</p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-100">
            {data.activity.map((row) => {
              const badge = ACTIVITY_BADGE[row.status];
              return (
                <li key={row.id} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-center sm:gap-4">
                  <p className="min-w-0 flex-1 text-sm text-neutral-800">
                    <span className="font-medium">{row.personName}</span> · {row.toolLabel}
                  </p>
                  <div className="flex items-center gap-3">
                    <Badge label={badge.label} className={badge.className} />
                    <time dateTime={row.createdAt} className="text-xs whitespace-nowrap text-neutral-500">
                      {formatRelativeTime(row.createdAt, nowMs)}
                    </time>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

type PersonEntry = {
  customerUserId: string;
  name: string;
  email: string | null;
  blocked: boolean;
  isSelf: boolean;
  rows: ConnectionRow[];
};

/**
 * Everyone in the company, with their AI apps (if any) and Block/Unblock.
 * Listing the whole team — not only people who have connected — is what
 * lets an admin block someone before their first connection. Blocking is
 * per person: Claude registers a new app on every reconnect, so one person
 * can have several connections, and a block covers all of them and any
 * future one.
 */
function PeopleAndAccess({
  team,
  connections,
  nowMs,
  pending,
  run,
}: {
  team: TeamMemberRow[];
  connections: ConnectionRow[];
  nowMs: number;
  pending: boolean;
  run: (apply: () => void, revert: () => void, action: () => Promise<McpActionResult>) => void;
}) {
  const [blockedOverride, setBlockedOverride] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");

  const people = useMemo(() => {
    const entries = new Map<string, PersonEntry>();
    for (const member of team) {
      entries.set(member.customerUserId, { ...member, rows: [] });
    }
    // Connections of members no longer in the active directory still show.
    for (const row of connections) {
      const entry =
        entries.get(row.customerUserId) ??
        { customerUserId: row.customerUserId, name: row.personName, email: row.personEmail, blocked: row.status === "blocked", isSelf: false, rows: [] };
      entry.rows.push(row);
      entries.set(row.customerUserId, entry);
    }
    // People with AI apps first, then everyone else alphabetically.
    return [...entries.values()].sort((a, b) => (b.rows.length > 0 ? 1 : 0) - (a.rows.length > 0 ? 1 : 0) || a.name.localeCompare(b.name));
  }, [team, connections]);

  const needle = filter.trim().toLowerCase();
  const visible = needle ? people.filter((p) => `${p.name} ${p.email ?? ""}`.toLowerCase().includes(needle)) : people;

  return (
    <section className={card} aria-labelledby="mcp-people-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 id="mcp-people-title" className="text-lg font-semibold text-neutral-900">People and access</h2>
          <p className="mt-1 text-sm text-neutral-600">
            Blocking stops a person&apos;s AI apps on their very next request and stops them connecting new ones — even if they
            haven&apos;t connected yet. It doesn&apos;t change their {BRAND_NAME} access.
          </p>
        </div>
        <label className="sm:w-56">
          <span className="sr-only">Find a person</span>
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a person"
            className="w-full rounded-xl bg-white px-3 py-2 text-sm ring-1 ring-neutral-300 placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-violet-500"
          />
        </label>
      </div>
      {visible.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">No one matches “{filter}”.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-3">
          {visible.map((person) => {
            const blocked = blockedOverride[person.customerUserId] ?? person.blocked;
            const lastUsed = person.rows.map((row) => row.lastUsedAt).filter((v): v is string => Boolean(v)).sort().at(-1);
            return (
              <li key={person.customerUserId} className="rounded-xl p-4 ring-1 ring-neutral-200">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-neutral-900">
                      {person.name}
                      {person.isSelf ? <span className="ml-2 text-xs font-normal text-neutral-500">(you)</span> : null}
                    </p>
                    {person.email ? <p className="truncate text-xs text-neutral-500">{person.email}</p> : null}
                    <p className="mt-1 text-xs text-neutral-500">
                      {person.rows.length === 0
                        ? "No AI apps connected"
                        : lastUsed
                          ? `Last used ${formatRelativeTime(lastUsed, nowMs)}`
                          : "Connected, not used yet"}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {blocked ? <Badge label="Blocked" className="bg-red-50 text-red-700 ring-red-100" /> : null}
                    <button
                      type="button"
                      disabled={pending || (person.isSelf && !blocked)}
                      title={person.isSelf && !blocked ? "You can't block yourself" : undefined}
                      onClick={() =>
                        run(
                          () => setBlockedOverride((s) => ({ ...s, [person.customerUserId]: !blocked })),
                          () => setBlockedOverride((s) => ({ ...s, [person.customerUserId]: blocked })),
                          () => setPersonBlockedAction(person.customerUserId, !blocked),
                        )
                      }
                      className={`min-h-9 rounded-full px-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50 ${
                        blocked ? "text-neutral-700 ring-1 ring-neutral-300 hover:bg-neutral-50" : "text-red-700 ring-1 ring-red-200 hover:bg-red-50"
                      }`}
                    >
                      {blocked ? "Unblock" : "Block"}
                    </button>
                  </div>
                </div>
                {person.rows.length > 0 ? (
                  <ul className="mt-3 flex flex-col gap-1.5 border-t border-neutral-100 pt-3">
                    {person.rows.map((row) => (
                      <li key={row.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-600">
                        <span className="font-medium text-neutral-800">{row.clientName}</span>
                        <span>via {row.redirectDomain}</span>
                        <span>connected {formatRelativeTime(row.createdAt, nowMs)}</span>
                        {row.status === "disconnected" ? <span className="text-neutral-400">disconnected by them</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
