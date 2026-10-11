"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageBanner } from "@/components/shared/message-banner";
import { BRAND_NAME } from "@/lib/brand";
import { formatRelativeTime } from "@/utils/format";
import { disconnectMyConnectionAction } from "../actions";
import type { MyConnectionRow } from "../lib/admin-data";

const STATUS: Record<MyConnectionRow["status"], { label: string; className: string }> = {
  active: { label: "Connected", className: "bg-emerald-50 text-emerald-700 ring-emerald-100" },
  disconnected: { label: "Disconnected", className: "bg-neutral-100 text-neutral-600 ring-neutral-200" },
  blocked: { label: "Blocked by your admin", className: "bg-red-50 text-red-700 ring-red-100" },
};

export function MyAiConnections({ connections, nowMs }: { connections: MyConnectionRow[]; nowMs: number }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busyClient, setBusyClient] = useState<string | null>(null);

  function disconnect(row: MyConnectionRow) {
    setMessage(null);
    setBusyClient(row.clientId);
    startTransition(async () => {
      const result = await disconnectMyConnectionAction(row.clientId);
      setMessage(result.ok ? { tone: "success", text: `${row.clientName} was disconnected.` } : { tone: "error", text: result.error });
      setBusyClient(null);
      router.refresh();
    });
  }

  return (
    <section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-black/5" aria-labelledby="my-ai-title">
      <h2 id="my-ai-title" className="text-lg font-semibold text-neutral-900">AI apps you&apos;ve connected</h2>
      <p className="mt-1 text-sm text-neutral-600">
        These apps can use {BRAND_NAME} as you — seeing and changing only what you can. Disconnecting stops an app immediately.
      </p>

      {message ? (
        <div className="mt-4">
          <MessageBanner tone={message.tone}>
            <p>{message.text}</p>
          </MessageBanner>
        </div>
      ) : null}

      {connections.length === 0 ? (
        <p className="mt-5 text-sm text-neutral-500">
          You haven&apos;t connected any AI apps. Your administrator can share how to connect Claude from Settings → AI Connections.
        </p>
      ) : (
        <ul className="mt-5 divide-y divide-neutral-100 rounded-xl ring-1 ring-neutral-200">
          {connections.map((row) => {
            const status = STATUS[row.status];
            return (
              <li key={row.clientId} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-neutral-900">{row.clientName}</p>
                    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${status.className}`}>
                      {status.label}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">
                    {row.redirectDomain ? `${row.redirectDomain} · ` : ""}connected {formatRelativeTime(row.connectedAt, nowMs)}
                    {row.lastUsedAt ? ` · last used ${formatRelativeTime(row.lastUsedAt, nowMs)}` : " · not used yet"}
                  </p>
                </div>
                {row.status !== "disconnected" ? (
                  <button
                    type="button"
                    onClick={() => disconnect(row)}
                    disabled={pending}
                    className="min-h-9 shrink-0 rounded-full px-4 text-sm font-semibold text-red-700 ring-1 ring-red-200 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 disabled:opacity-50"
                  >
                    {busyClient === row.clientId ? "Disconnecting…" : "Disconnect"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
