import { createServerClient } from "@supabase/ssr";
import { z } from "zod";

/**
 * The IndiaMART Push API payload, and the one call that turns it into a
 * lead.
 *
 * WHY THIS FILE EXISTS AND NOT A services/ MODULE
 * CLAUDE.md Section I says a Route Handler stays thin and delegates to
 * `services/`. That directory does not exist in this repo — the actual
 * convention that grew instead is `features/<feature>/lib/*` for data
 * access (get-meeting-notes, get-team-directory, get-tasks, ...). This
 * follows the convention that exists. The "service" in the Section I
 * sense is genuinely ingest_indiamart_lead() in Postgres; everything
 * here is parsing and transport.
 */

/**
 * EVERY FIELD IS OPTIONAL AND EVERY FIELD IS A STRING-OR-NUMBER.
 *
 * This is not laziness about validation — it is the correct shape for
 * this particular input. IndiaMART is a third party pushing to us on a
 * schedule we do not control, and it DEACTIVATES AN INTEGRATION AFTER
 * 48 CONTINUOUS HOURS of non-200 responses. A strict schema that 400s
 * on an unexpected extra key, a renamed field, or a numeric
 * UNIQUE_QUERY_ID would convert a cosmetic upstream change into a
 * silent, total loss of the tenant's lead feed two days later.
 *
 * So the schema's job here is narrow: confirm the envelope is shaped
 * like an IndiaMART push at all, and coerce whatever arrived into
 * strings. Everything that actually protects the database —
 * same-customer FKs, the stage/owner re-validation, the dedupe index,
 * NOT NULL fallbacks — lives in ingest_indiamart_lead(), where it
 * cannot be bypassed by any payload.
 */
const leadFieldSchema = z.union([z.string(), z.number()]).optional().nullable();

const responseSchema = z.object({
  UNIQUE_QUERY_ID: leadFieldSchema,
  SENDER_NAME: leadFieldSchema,
  SENDER_MOBILE: leadFieldSchema,
  SENDER_EMAIL: leadFieldSchema,
  SENDER_COMPANY: leadFieldSchema,
  QUERY_PRODUCT_NAME: leadFieldSchema,
  QUERY_MESSAGE: leadFieldSchema,
});

/**
 * RESPONSE arrives as an OBJECT for a single lead, but IndiaMART's own
 * documentation and their test tool have both shown it as a
 * single-element ARRAY. Accepting either costs one union and removes a
 * whole class of "works in test, 400s in production" failure — see the
 * 48-hour note above for why that matters more here than tidiness.
 */
const payloadSchema = z.object({
  RESPONSE: z.union([responseSchema, z.array(responseSchema).min(1)]),
});

export type IngestResult =
  | "created"
  | "duplicate"
  | "unknown_token"
  | "no_active_stage"
  | "bad_payload"
  | "error";

/** Whatever arrived, as a string the RPC can take, or null. */
function text(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * A DELIBERATELY SESSION-LESS Supabase client.
 *
 * Not lib/supabase/server.ts's createClient(), which reads cookies. A
 * webhook has no session, and if an admin happened to open the webhook
 * URL in their own logged-in browser the cookie client would run the
 * RPC as `authenticated` instead of `anon` — the same endpoint behaving
 * differently depending on who poked it. Empty cookie handlers make
 * that impossible: this client is always anon, for everyone.
 *
 * It grants nothing. ingest_indiamart_lead() is SECURITY DEFINER and
 * resolves the tenant from the token alone; the anon role's only
 * privilege here is permission to call it.
 */
function createWebhookClient() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: () => {},
      },
    },
  );
}

/**
 * Parse a push and hand it to the database.
 *
 * `token` comes from the URL path and is the ONLY thing that decides
 * which tenant the lead lands in. There is no customer_id parameter
 * here, and there is none on the RPC either — that is the property the
 * whole endpoint's safety rests on, so it is expressed as an absence,
 * not as a validation step that could be forgotten.
 */
export async function ingestIndiamartLead(token: string, body: unknown): Promise<IngestResult> {
  const parsed = payloadSchema.safeParse(body);
  if (!parsed.success) {
    // PATHS AND CODES ONLY, NEVER VALUES. The payload carries a real
    // buyer's name, phone and email, so `received` and the raw body are
    // both off limits (CLAUDE.md Section P) — but "RESPONSE.SENDER_NAME
    // invalid_type" is the whole diagnosis anyway, and it is what tells
    // you whether IndiaMART renamed a field or something else entirely
    // is posting here.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
      .join(", ");
    console.error(
      `[indiamart] REJECTED bad_payload — the push did not match the expected shape (${issues}). ` +
        "This is answered with 200 on purpose so IndiaMART does not retry it for 48 hours; " +
        "it will keep being rejected until the payload shape is addressed.",
    );
    return "bad_payload";
  }

  const response = Array.isArray(parsed.data.RESPONSE) ? parsed.data.RESPONSE[0] : parsed.data.RESPONSE;

  const supabase = createWebhookClient();

  const { data, error } = await supabase.rpc("ingest_indiamart_lead", {
    p_token: token,
    p_unique_query_id: text(response.UNIQUE_QUERY_ID),
    p_sender_name: text(response.SENDER_NAME),
    p_sender_mobile: text(response.SENDER_MOBILE),
    p_sender_email: text(response.SENDER_EMAIL),
    p_sender_company: text(response.SENDER_COMPANY),
    p_query_product_name: text(response.QUERY_PRODUCT_NAME),
    p_query_message: text(response.QUERY_MESSAGE),
  });

  if (error) {
    // Code only. The payload carries a real person's name, phone and
    // email, and the token is a bearer secret — neither belongs in a
    // log line (CLAUDE.md Section P).
    console.error(`[indiamart] ingest failed (code: ${error.code ?? "unknown"}).`);
    return "error";
  }

  const result = (data as IngestResult | null) ?? "error";

  // EVERY NON-SUCCESS OUTCOME LEAVES A TRACE.
  //
  // The two 200-returning rejections below are the dangerous ones
  // precisely because they are 200s: nothing upstream will ever
  // complain about them, IndiaMART will not retry them, and there is no
  // UI for them yet. Unlogged, a tenant's feed could be silently
  // dropping every push with nobody able to say why. `created` and
  // `duplicate` are deliberately NOT logged — they are the normal
  // traffic of a working integration, and one line per lead would bury
  // the lines that matter.
  if (result === "no_active_stage") {
    // NOTE: this cannot name the tenant. Resolving customer_id is the
    // RPC's job and it returns only a status string — see the route
    // handler's comment on why that trade is worth keeping.
    console.error(
      "[indiamart] REJECTED no_active_stage — a push resolved to a real, active integration, " +
        "but that customer has no Active lead stage, and leads.stage_id is NOT NULL. " +
        "Reactivate a stage in Pipeline settings; pushes are being dropped until then.",
    );
  }

  if (result === "unknown_token") {
    // The single most likely real-world failure: the URL was
    // regenerated and nobody pasted the new one into IndiaMART. Worth a
    // log line even though the endpoint answers 404, because the 404
    // goes to IndiaMART and nobody here ever sees it. The token itself
    // is a bearer secret and is not logged, not even truncated.
    console.error(
      "[indiamart] REJECTED unknown_token — a push arrived for a token that is unknown, " +
        "belongs to another source, or belongs to a paused integration. " +
        "If the webhook URL was recently regenerated, the new URL has not been installed in IndiaMART yet.",
    );
  }

  return result;
}
