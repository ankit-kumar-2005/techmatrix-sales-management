import { MEETING_NOTES_MAX_LENGTH, type MeetingNotesSourceKind } from "../constants";
import { extractedMeetingNotesSchema, type ExtractedMeetingNotes } from "./extraction-schema";

/**
 * SERVER-ONLY. The single place this application talks to OpenRouter.
 *
 * WHY IT LIVES IN features/*-/lib RATHER THAN IN A ROUTE HANDLER: the
 * provider call is separated from how it is invoked. The only caller
 * today is a Server Action (../actions.ts), because every UI-initiated
 * operation in this app is a Server Action and there is no app/api
 * directory to follow. When the future mobile client needs the same
 * extraction (CLAUDE.md Section B), a thin Route Handler calls this
 * exact function — no logic moves, nothing is reimplemented.
 *
 * THE KEY NEVER LEAVES THIS MODULE. process.env.OPENROUTER_API_KEY is
 * read here, placed straight into an Authorization header, and never
 * returned, logged, or embedded in an error — see the note on each
 * console.error below.
 */

/** Runtime backstop for the server-only boundary. The real boundary is
 *  that the only importer of THIS module is a "use server" file (shared
 *  constants live in ../constants precisely so no client component ever
 *  needs to import from here); the `server-only` package, which would
 *  make a client import a BUILD error, is not a dependency of this
 *  project. This at least fails loudly rather than shipping a
 *  key-shaped hole. */
if (typeof window !== "undefined") {
  throw new Error("features/meeting-notes/lib/openrouter.ts is server-only and must not be imported by client code.");
}

const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * THE FALLBACK CHAIN, in order. Each tier is tried in full (including
 * its own reminder retry) before the next is touched.
 *
 * Tiers 1 and 2 are the specified Gemma models: 262,144-token context,
 * text+image+video, response_format support, free.
 *
 * Tier 3 is `nex-agi/nex-n2.5-mini:free` and NOT `openrouter/free`,
 * which was the original choice. That was changed after testing it
 * against this exact request shape: openrouter/free is a router that
 * picks a free model AT RANDOM, and across six live attempts it
 * dispatched to five different models and returned parseable JSON zero
 * times — once to a content-safety classifier that replied "User
 * Safety: safe", and twice to reasoning models that spent the whole
 * max_tokens budget on hidden reasoning and returned content: null. A
 * random router cannot be relied on for structured output because you
 * cannot tune max_tokens for a model you cannot predict.
 *
 * nex-n2.5-mini:free was verified live to return this exact shape, and
 * critically runs on a DIFFERENT PROVIDER: both Gemma :free variants
 * route through the single Google AI Studio free endpoint, so tiers 1
 * and 2 share one rate limit. Tier 3 is the only one that survives that
 * endpoint being throttled — which, at the time of writing, it is.
 *
 * Overridable via OPENROUTER_MODEL_CHAIN (comma-separated) so a model
 * being retired is a config change, not a deploy.
 */
const DEFAULT_TEXT_CHAIN = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nex-agi/nex-n2.5-mini:free",
] as const;

/**
 * THE IMAGE CHAIN IS A SUBSET, AND THAT IS A TESTED FACT, NOT CAUTION.
 *
 * OpenRouter metadata lists nex-agi/nex-n2.5-mini:free as accepting
 * image input. It does not, in practice: sending it the OpenAI
 * content-parts message format returns HTTP 400 "invalid_request" from
 * the provider with an image part, and hangs past 60s with a
 * content-parts array containing NO image at all — while the identical
 * request using plain string content returns 200. The model is
 * text-only in practice regardless of what the catalogue advertises.
 *
 * Keeping it out of the image chain does two things: an image upload
 * never burns 45 seconds timing out against a tier that cannot read it,
 * and exhausting this chain produces a DISTINCT failure the UI can
 * phrase honestly ("image extraction is temporarily unavailable, paste
 * the text instead") rather than the misleading "try a clearer image".
 */
const DEFAULT_IMAGE_CHAIN = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
] as const;

function parseChain(configured: string | undefined, fallback: readonly string[]): string[] {
  const chain = (configured ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chain.length > 0 ? chain : [...fallback];
}

function resolveModelChain(kind: ExtractionSource["kind"]): string[] {
  return kind === "Image"
    ? parseChain(process.env.OPENROUTER_IMAGE_MODEL_CHAIN, DEFAULT_IMAGE_CHAIN)
    : parseChain(process.env.OPENROUTER_MODEL_CHAIN, DEFAULT_TEXT_CHAIN);
}

/** Generous because tier 3 is a reasoning model: it spent 294 reasoning
 *  tokens on a short transcript in testing, and those count against
 *  max_tokens BEFORE any content is emitted. The openrouter/free
 *  failures happened at 900 — a model can burn the entire budget
 *  thinking and return an empty string, which is indistinguishable from
 *  a refusal. 2500 leaves room for both the reasoning and a full
 *  extraction. */
const MAX_TOKENS = 2500;

/** Per-attempt, not per-request. A free-tier endpoint under load is
 *  genuinely slow (tier 3 answered in 10s in testing), but a tier that
 *  has gone dark must not hold the whole chain — three tiers x two
 *  attempts is the worst case, so this bounds the total at ~4.5 min
 *  only if every single attempt hangs, which the 429 fast-fail below
 *  makes unlikely. */
const REQUEST_TIMEOUT_MS = 45_000;

/** Verbatim from the specification. Not reformatted, not "improved" —
 *  the rules in it (never invent a name or date, assignee must be a
 *  literal name and never an id, empty action_items rather than
 *  guessing, resolve relative dates only against a known meeting date)
 *  are the behavioural contract the rest of this feature is built on. */
const SYSTEM_PROMPT = `You are an assistant that extracts structured meeting notes and action
items from sales call transcripts or notes for a CRM. You will be given
either pasted text or an image of notes (handwritten, whiteboard, or a
screenshot of typed notes).

Return ONLY valid JSON, no markdown code fences, no commentary before or
after, matching exactly this shape:

{
  "title": string,
  "date": string | null,
  "attendees": string[],
  "summary": string,
  "action_items": [
    {
      "subject": string,
      "description": string | null,
      "suggested_assignee": string | null,
      "suggested_due_date": string | null,
      "suggested_priority": "Low" | "Medium" | "High",
      "suggested_type": "Call" | "Meeting" | "Email" | "Other"
    }
  ]
}

Rules:
- Never invent a name, date, or fact that is not present in the source
  text/image. If uncertain, use null.
- "suggested_assignee" must be a literal name string as written in the
  source, never a database ID or guess at one — the calling application
  resolves names to real user accounts, not you.
- If the source is unclear or not actually meeting notes, return
  action_items as an empty array rather than guessing.
- Resolve a relative date ("by Friday", "next week") to an ISO date
  (YYYY-MM-DD) ONLY if the meeting's own date is known from the source or
  provided context; otherwise leave suggested_due_date null.
- Output must be valid, parseable JSON and nothing else.`;

/** Appended as a second system message on the retry attempt only. Kept
 *  separate from SYSTEM_PROMPT rather than concatenated so the verbatim
 *  prompt above stays byte-identical to the specification. */
const JSON_ONLY_REMINDER = "Return ONLY the JSON object, nothing else.";

export type ExtractionSource =
  | { kind: "Text"; text: string }
  | { kind: "Image"; dataUrl: string };

export type ExtractMeetingNotesResult =
  | {
      ok: true;
      extraction: ExtractedMeetingNotes;
      /** The model OpenRouter actually served, for meeting_notes.model_used. */
      model: string;
      /** 1-based position in the chain that succeeded. Surfaced so a
       *  persistent "tier 3 only" pattern is visible in logs rather than
       *  silently normal. */
      tier: number;
    }
  | {
      ok: false;
      /** A stable code the caller maps to human copy. Never a provider
       *  message, never anything derived from the key. */
      reason:
        | "not_configured"
        | "no_source"
        | "source_too_long"
        | "all_tiers_failed"
        /** Every IMAGE-capable tier failed. Distinct from
         *  all_tiers_failed because the honest advice differs: the
         *  image was probably fine, the models that can read one are
         *  simply unavailable, and pasting the text will work. */
        | "image_tiers_unavailable";
      /** One short, non-sensitive line per attempt, for the server log
       *  and for telling the user WHICH kind of failure this was. */
      attempts?: string[];
    };

/** Why a single attempt ended. Only `parse_failed` earns the reminder
 *  retry — the others are not problems a reworded prompt can fix, so
 *  they fall straight through to the next tier. */
type AttemptOutcome =
  | { status: "ok"; extraction: ExtractedMeetingNotes; servedModel: string }
  | { status: "parse_failed"; detail: string }
  | { status: "tier_failed"; detail: string };

/**
 * OpenRouter is OpenAI-compatible, so only the sliver of the response
 * actually read is typed — and it is all optional, because a 200 with an
 * unexpected body is precisely what the parse-failure path is for.
 * `content` is deliberately `unknown`: tier 3 is a reasoning model and
 * returns `content: null` when it exhausts max_tokens thinking.
 */
type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  model?: unknown;
};

/**
 * Strips a markdown fence if the model wrapped its JSON in one despite
 * being told not to. Observed in practice often enough to be worth
 * handling rather than treating as a failure — it is the single most
 * common way an otherwise-perfect response fails JSON.parse.
 *
 * Also handles the looser case of a fence with trailing prose after it,
 * by taking the first fenced block rather than requiring the fence to be
 * the entire message.
 */
function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

/**
 * The user message. Today's server-side date is passed as explicit
 * context because the prompt's own rule allows resolving a relative
 * date ("by Friday") ONLY against a known date — without this the model
 * has nothing to anchor to and must return null, which is correct but
 * unhelpful. Note it anchors on the MEETING's date when the source
 * states one; today's date is the fallback reference, not an override.
 *
 * The notes themselves stay in their own user message and are never
 * concatenated into the system prompt. That separation is the part that
 * matters: appending untrusted text to the system instruction would
 * give a note saying "ignore the above" the same authority as the rules.
 *
 * HONEST LIMIT: that reduces prompt-injection risk, it does not
 * eliminate it. The blast radius is what keeps it acceptable — the
 * output is validated by Zod, written to two tables the user owns, and
 * every action item still requires a human to pick a lead and an
 * assignee in the existing dialog before anything becomes a task. No
 * extraction can create a task on its own.
 */
function buildUserContent(source: ExtractionSource, todayIso: string) {
  const preamble = `Today's date is ${todayIso}.`;

  if (source.kind === "Text") {
    return `${preamble}\n\nMeeting notes:\n${source.text}`;
  }

  // OpenAI-compatible multimodal content parts. The data URL carries the
  // image inline; nothing is uploaded anywhere and no binary is stored
  // (see the migration's own note on the text-only v1 decision).
  return [
    { type: "text" as const, text: `${preamble}\n\nExtract the meeting notes from this image.` },
    { type: "image_url" as const, image_url: { url: source.dataUrl } },
  ];
}

/** One request to one model. Never throws: every failure becomes an
 *  AttemptOutcome so the chain logic stays a plain loop. */
async function attempt(
  model: string,
  apiKey: string,
  source: ExtractionSource,
  todayIso: string,
  withReminder: boolean,
): Promise<AttemptOutcome> {
  const messages: Array<{ role: "system" | "user"; content: unknown }> = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  if (withReminder) {
    messages.push({ role: "system", content: JSON_ONLY_REMINDER });
  }
  messages.push({ role: "user", content: buildUserContent(source, todayIso) });

  let response: Response;
  try {
    response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        // Static product name. No key, no user data, no tenant id.
        "X-Title": "Techmatrix Sales Management",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: MAX_TOKENS,
        // Belt and braces, NOT relied upon: the chain's models advertise
        // response_format but not strict structured_outputs, and Zod is
        // the authority either way. Sending it measurably reduces fence
        // wrapping.
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // A summary is derived from the exact text just submitted, and
      // Next.js caches fetch() in some contexts.
      cache: "no-store",
    });
  } catch (error) {
    // The caught value is never logged or inspected: a fetch rejection
    // can carry the originating request on some runtimes, and the
    // Authorization header lives in it. Only the error NAME is used.
    const name = error instanceof Error ? error.name : "unknown";
    return { status: "tier_failed", detail: name === "TimeoutError" ? "timed out" : "network error" };
  }

  if (!response.ok) {
    // STATUS CODE ONLY. The provider body is never logged or surfaced:
    // it can quote request details back, and it is not ours to show as
    // product copy either way.
    return {
      status: "tier_failed",
      detail: response.status === 429 ? "rate-limited (429)" : `HTTP ${response.status}`,
    };
  }

  let payload: ChatCompletionResponse;
  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch {
    return { status: "tier_failed", detail: "response envelope was not JSON" };
  }

  const servedModel = typeof payload.model === "string" && payload.model ? payload.model : model;
  const content = payload.choices?.[0]?.message?.content;

  // Reasoning models return content: null when max_tokens is exhausted
  // by hidden reasoning. That is a tier problem, not a prompt problem —
  // a reminder would make the response longer, not shorter — so it does
  // not earn the retry.
  if (typeof content !== "string" || content.trim() === "") {
    return { status: "tier_failed", detail: "returned no text content" };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(stripJsonFence(content));
  } catch {
    // THIS is what the reminder retry exists for: the model produced
    // prose, or prose wrapped around JSON we could not isolate.
    return { status: "parse_failed", detail: "response was not valid JSON" };
  }

  const parsed = extractedMeetingNotesSchema.safeParse(candidate);
  if (!parsed.success) {
    // Valid JSON, wrong shape — also worth one reminder. The issue
    // PATHS are kept (they name our own fields, e.g. "summary"), the
    // issue messages are not logged verbatim to avoid echoing model
    // output into logs.
    const paths = parsed.error.issues
      .map((issue) => issue.path.join(".") || "(root)")
      .slice(0, 5)
      .join(", ");
    return { status: "parse_failed", detail: `JSON did not match the required shape (${paths})` };
  }

  return { status: "ok", extraction: parsed.data, servedModel };
}

/**
 * Walk the chain: each tier gets one normal attempt and, only if that
 * attempt produced unparseable or wrong-shaped JSON, one retry with the
 * "Return ONLY the JSON object" reminder. A 429, timeout, HTTP error or
 * empty-content response moves straight to the next tier without
 * retrying, because none of those is a problem a reworded prompt can
 * fix and retrying would just spend another 45 seconds proving it.
 *
 * `todayIso` is an argument rather than read from the clock in here so
 * the caller decides what "today" means and this stays a pure-ish
 * function of its inputs — which is what made it testable against the
 * live API without a running app.
 */
export async function extractMeetingNotes(
  source: ExtractionSource,
  todayIso: string = new Date().toISOString().slice(0, 10),
): Promise<ExtractMeetingNotesResult> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    // Names WHICH variable is missing, never anything about its value.
    console.error("[meeting-notes] OPENROUTER_API_KEY is not set; no request was made.");
    return { ok: false, reason: "not_configured" };
  }

  if (source.kind === "Text") {
    const trimmed = source.text.trim();
    if (!trimmed) return { ok: false, reason: "no_source" };
    if (trimmed.length > MEETING_NOTES_MAX_LENGTH) return { ok: false, reason: "source_too_long" };
    source = { kind: "Text", text: trimmed };
  } else if (!source.dataUrl) {
    return { ok: false, reason: "no_source" };
  }

  const chain = resolveModelChain(source.kind);
  const attempts: string[] = [];

  for (let index = 0; index < chain.length; index += 1) {
    const model = chain[index];
    const tier = index + 1;

    let outcome = await attempt(model, apiKey, source, todayIso, false);

    if (outcome.status === "parse_failed") {
      attempts.push(`tier ${tier} (${model}): ${outcome.detail} — retrying with a JSON-only reminder`);
      outcome = await attempt(model, apiKey, source, todayIso, true);
    }

    if (outcome.status === "ok") {
      if (tier > 1) {
        // Worth a log line: the chain working is normal, the chain
        // needing its later tiers every time is a signal that tier 1 is
        // effectively unavailable and the config should change.
        console.warn(`[meeting-notes] extraction succeeded on fallback tier ${tier} (${outcome.servedModel}).`);
      }
      return { ok: true, extraction: outcome.extraction, model: outcome.servedModel, tier };
    }

    attempts.push(`tier ${tier} (${model}): ${outcome.detail}`);
  }

  // Every tier exhausted. The per-attempt lines are logged server-side
  // and handed back so the caller can tell the user WHAT kind of failure
  // this was (rate-limited everywhere vs. the models not cooperating),
  // which is the difference between "try again in a minute" and
  // "something is wrong with this input".
  console.error(`[meeting-notes] every extraction tier failed:\n  ${attempts.join("\n  ")}`);
  return {
    ok: false,
    // An IMAGE that exhausted its chain gets its own reason. Only the
    // two Gemma tiers can read one (tier 3 rejects the multimodal
    // message format outright), and both share a single provider rate
    // limit — so this firing means "the models that can read images are
    // busy", not "your image was bad". The caller phrases those two very
    // differently, and telling someone to retake a perfectly good photo
    // when pasting the text would work is the wrong advice.
    reason: source.kind === "Image" ? "image_tiers_unavailable" : "all_tiers_failed",
    attempts,
  };
}

/**
 * Which tier of the text chain a stored model_used value corresponds to,
 * or null when it is not in the chain at all.
 *
 * WHY THIS LIVES HERE: the chain is defined in this module and read from
 * server-only env, so the mapping has to be resolved server-side. The
 * Meeting Notes list calls this while fetching (a Server Component) and
 * passes a plain number to the card, so no env and no chain ever reaches
 * the browser.
 *
 * Returns null rather than guessing for a model that has since been
 * removed from the chain — a historical note keeps saying which model
 * produced it (that column is immutable), and claiming "tier 2" for a
 * model that is no longer tier anything would be worse than saying
 * nothing. The card falls back to showing the raw model name.
 *
 * The TEXT chain is used deliberately even for an image-sourced note:
 * the image chain is a subset of it, so an image note's model is always
 * found here too, and looking it up in one place avoids reporting two
 * different tier numbers for the same model.
 */
export function resolveTierForModel(modelUsed: string): number | null {
  const index = resolveModelChain("Text").indexOf(modelUsed);
  return index === -1 ? null : index + 1;
}

/** Re-exported so the action and the persistence layer share one source
 *  for these types rather than importing from two places. */
export type { ExtractedMeetingNotes, MeetingNotesSourceKind };
