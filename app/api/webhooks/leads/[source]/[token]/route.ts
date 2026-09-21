import { NextResponse, after } from "next/server";
import { getLeadProviderAdapter } from "@/features/integrations/lib/providers/registry";
import { ingestLead } from "@/features/integrations/lib/ingest-lead";
import { drainAutomationQueue } from "@/features/automations/lib/drain";

/**
 * POST /api/webhooks/leads/{source}/{token}
 *
 * The one lead-ingest controller for EVERY source this app supports —
 * replaces what was app/api/webhooks/leads/indiamart/[token]/route.ts.
 * This file contains zero source-specific code by construction: it
 * resolves an adapter by `source` from the registry, asks that adapter
 * to parse the body, and hands the result to the one generic RPC. It
 * has no idea IndiaMART exists, and gains no idea a second source
 * exists either, the day one is added — see features/integrations/lib/
 * providers/registry.ts.
 *
 * THE TOKEN IN THE PATH IS THE ONLY TENANT RESOLUTION. Nothing in the
 * body is ever consulted for it — not a customer id, not an email, not
 * a "receiver" field. ingest_lead() takes no customer_id parameter at
 * all, so there is no code path here that could pass one even by
 * mistake.
 *
 * `source` IS NOT TRUSTED FOR TENANT RESOLUTION EITHER — it only picks
 * which adapter parses the body. The database re-derives the true
 * source from the token itself and rejects a mismatch identically to
 * an unknown token (the migration's design note 10) — this route does
 * not need to, and does not, replicate that check.
 *
 * WHY EVERY OUTCOME IS 200 EXCEPT AN UNKNOWN SOURCE OR TOKEN
 * IndiaMART (and, going by their behavior, likely every push-based lead
 * source) deactivates an integration after sustained non-200 responses.
 * That makes the status code an operational lever, not just a
 * description:
 *
 *   created         200 — the lead landed.
 *   duplicate       200 — a retry of something already stored. This is
 *                   the CORRECT answer to a retry: 4xx would tell the
 *                   source to keep retrying something we have
 *                   deliberately refused, burning its own retry budget.
 *   bad_payload     200 — logged, not retried. A malformed push will be
 *                   malformed every time, so a 400 here would burn that
 *                   budget on a message that can never succeed. The
 *                   tenant's real leads keep flowing meanwhile.
 *   no_active_stage 200 — a tenant-side misconfiguration (every stage
 *                   deactivated). Nothing the source can fix by
 *                   retrying, and the whole feed must not die for it.
 *   error           500 — an actual server-side fault, which IS worth
 *                   retrying, and which we want to be visibly failing.
 *   unknown source
 *   or token        404 — see below.
 *
 * The 404 for an unregistered source, an unknown token, a source/token
 * mismatch, or a deactivated token is deliberately indistinguishable
 * between all of those cases: a probe must not be able to tell "no such
 * source" from "no such token" from "that token exists but is switched
 * off" by trying values. It is also the one case where a non-200 is
 * right — a caller holding a bad URL should be told, not silently
 * thanked.
 */

// No caching, ever: this is a write endpoint.
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ source: string; token: string }> }) {
  const { source, token } = await params;

  // Shape-checked before it reaches the database. A token is 64 hex
  // characters by construction (two hyphen-stripped uuids), so anything
  // else is a probe and is answered without a query.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  const adapter = getLeadProviderAdapter(source);
  if (!adapter) {
    // Unregistered source: the SAME generic 404 an unknown token gets —
    // never a distinct "no such source" answer, which would let a probe
    // enumerate which sources this app supports.
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Unparseable body. 200 for the same reason as bad_payload below —
    // it will not parse on a retry either.
    console.error(`[lead-capture:${source}] request body was not valid JSON.`);
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const parsed = adapter.parse(body);
  if (!parsed.ok) {
    console.error(
      `[lead-capture:${source}] REJECTED bad_payload — the push did not match the expected shape (${parsed.detail}). ` +
        "This is answered with 200 on purpose so the source does not exhaust its own retry budget on it; " +
        "it will keep being rejected until the payload shape is addressed.",
    );
    return NextResponse.json({ status: "bad_payload" }, { status: 200 });
  }

  const result = await ingestLead(token, source, parsed.lead);

  if (result === "unknown_token") {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }
  if (result === "error") {
    return NextResponse.json({ status: "error" }, { status: 500 });
  }

  if (result === "created") {
    // ingest_lead() inserted a lead, so that table's AFTER INSERT
    // trigger has already written any automation event inside the same
    // transaction. This nudges the worker to run it now instead of
    // waiting for the cron backstop.
    //
    // after(), WITHOUT EXCEPTION. This response is on the critical path
    // of the 48-hour deactivation rule described above: the source must
    // get its 200 immediately, and automation processing must never be
    // able to delay it, fail it, or turn a captured lead into a 500.
    // drainAutomationQueue never throws for the same reason.
    after(() => drainAutomationQueue(`a ${source} lead was captured`));
  }

  return NextResponse.json({ status: result }, { status: 200 });
}

/**
 * A source's own setup screen, or its test tool, GETting the URL to
 * check it resolves. Answering with a 200 and a hint — rather than
 * Next's default 405 — makes "is my URL right?" answerable without
 * sending a dummy lead. It reveals nothing beyond what the caller
 * already had: the source name was already in the URL they hold, and a
 * wrong source or token still 404s exactly as POST does.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ source: string; token: string }> }) {
  const { source, token } = await params;

  if (!/^[0-9a-f]{64}$/.test(token) || !getLeadProviderAdapter(source)) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  return NextResponse.json(
    { status: "ready", message: `This endpoint accepts POST requests from ${source}'s webhook delivery.` },
    { status: 200 },
  );
}
