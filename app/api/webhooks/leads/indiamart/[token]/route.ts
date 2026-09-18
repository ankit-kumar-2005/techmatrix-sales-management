import { NextResponse } from "next/server";
import { ingestIndiamartLead } from "@/features/integrations/lib/ingest-indiamart-lead";

/**
 * POST /api/webhooks/leads/indiamart/{token}
 *
 * IndiaMART's Push API delivers here. The FIRST Route Handler in this
 * repo, and it exists because a Server Action cannot be the target: a
 * third party posting JSON needs a real URL, and a future mobile client
 * or a second lead source needs the same (CLAUDE.md Section A/I).
 *
 * THE TOKEN IN THE PATH IS THE ONLY TENANT RESOLUTION. Nothing in the
 * body is ever consulted for it — not a customer id, not an email, not
 * a "receiver" field. ingest_indiamart_lead() takes no customer_id
 * parameter at all, so there is no code path here that could pass one
 * even by mistake.
 *
 * WHY EVERY OUTCOME IS 200 EXCEPT AN UNKNOWN TOKEN
 * IndiaMART deactivates an integration after 48 continuous hours of
 * non-200 responses. That makes the status code an operational lever,
 * not just a description:
 *
 *   created         200 — the lead landed.
 *   duplicate       200 — a retry of something already stored. This is
 *                   the CORRECT answer to a retry: 4xx would tell
 *                   IndiaMART to keep retrying something we have
 *                   deliberately refused, and count toward the 48 hours.
 *   bad_payload     200 — logged, not retried. A malformed push will be
 *                   malformed every time, so a 400 here would burn the
 *                   48-hour budget on a message that can never succeed.
 *                   The tenant's real leads keep flowing meanwhile.
 *   no_active_stage 200 — a tenant-side misconfiguration (every stage
 *                   deactivated). Nothing IndiaMART can fix by
 *                   retrying, and the whole feed must not die for it.
 *   error           500 — an actual server-side fault, which IS worth
 *                   retrying, and which we want to be visibly failing.
 *   unknown_token   404 — see below.
 *
 * The 404 for an unknown, wrong-source, or deactivated token is
 * deliberately indistinguishable between those cases: a probe must not
 * be able to tell "no such token" from "that token exists but is
 * switched off". It is also the one case where a non-200 is right — a
 * caller holding a bad URL should be told, not silently thanked.
 */

// No caching, ever: this is a write endpoint.
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  // Shape-checked before it reaches the database. A token is 64 hex
  // characters by construction (two hyphen-stripped uuids), so anything
  // else is a probe and is answered without a query.
  if (!/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Unparseable body. 200 for the same reason as bad_payload above —
    // it will not parse on a retry either.
    console.error("[indiamart] request body was not valid JSON.");
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const result = await ingestIndiamartLead(token, body);

  if (result === "unknown_token") {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }
  if (result === "error") {
    return NextResponse.json({ status: "error" }, { status: 500 });
  }

  return NextResponse.json({ status: result }, { status: 200 });
}

/**
 * IndiaMART's setup screen, and their test tool, both GET the URL to
 * check it resolves. Answering with a 200 and a hint — rather than
 * Next's default 405 — makes "is my URL right?" answerable without
 * sending a dummy lead. It reveals nothing: the token was already in
 * the requester's hands, and a wrong one still 404s.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  if (!/^[0-9a-f]{64}$/.test(token)) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  return NextResponse.json(
    { status: "ready", message: "This endpoint accepts POST requests from IndiaMART's Push API." },
    { status: 200 },
  );
}
