import { z } from "zod";
import { parseChain, runStructuredCompletion } from "@/lib/ai/openrouter";
import { LEAD_SOURCES } from "../schemas";
import type { LeadExtractionResult } from "@/types/lead";

/**
 * AI-assisted lead creation: extract a lead's details from a pasted
 * call transcript or email.
 *
 * REUSES THE SHARED OPENROUTER TRANSPORT (lib/ai/openrouter.ts) — the
 * same runStructuredCompletion() the automation builder's own AI door
 * already uses (features/automations/lib/generate-workflow.ts), not a
 * second copy of Meeting Notes' bespoke chain-walk. That shared walker
 * already gives this feature everything Meeting Notes' own mechanism
 * has: each tier gets one attempt and, only on a parse/shape failure,
 * one retry with a "JSON only" reminder before moving to the next tier;
 * a 429/timeout/HTTP error skips straight to the next tier with no
 * retry, since a reworded prompt cannot fix any of those.
 *
 * THIS IS ALWAYS A DRAFT. This function only returns a result — it
 * never writes to `leads`. The caller (extractLeadAction) hands the
 * result straight to the browser, which pre-fills the existing New
 * Lead form for a human to review and explicitly submit through the
 * existing, unmodified createLeadAction. There is no second, AI-only
 * path into the leads table.
 *
 * WHY "lead" DELIBERATELY HAS FEWER FIELDS THAN THE FULL LEAD FORM
 * (Phase 0 findings):
 *   - customer_id and owner_id are never asked of the model at all —
 *     both are derived server-side from the caller's own session by
 *     createLeadAction, exactly as they are for a manually typed lead.
 *     Sending either to the model, or reading either back from it,
 *     would be the one thing this feature must never do.
 *   - stage_id is not a fact a transcript could state — it is which of
 *     THIS customer's own configured pipeline stages the lead should
 *     start in, an operational choice, not an extractable one. The
 *     blank Create Lead form already leaves it unselected
 *     (LeadFormFields' own <option value="" disabled>Select a
 *     stage</option>), so an AI-prefilled form does exactly the same —
 *     nothing to omit differently here.
 *   - whatsapp_phone is never asked for, never returned, and never
 *     reasoned about — see the module-level rule below. A transcript
 *     essentially never states "this number is also on WhatsApp," and
 *     asking a free-tier model to guess it is exactly the kind of
 *     confident-sounding invention this feature exists to avoid. The
 *     phone field is populated; LeadFormFields' own "same as Phone
 *     number" toggle (whatsapp_same) behaves exactly as it does when a
 *     human leaves it unchecked on a blank form.
 *   - address and expected_close_date are real, optional form fields,
 *     but the task's own extraction shape omits both and neither is
 *     something a transcript reliably states with enough certainty to
 *     extract — left for the human to fill in on review, same as any
 *     other blank field.
 *   - There is no "notes" field on the leads table at all (see
 *     types/lead.ts's Lead type) — "next_step" is the one free-text
 *     field the form actually has, so the model is asked directly for
 *     that (the single agreed follow-up action), not a separate
 *     generic "notes" field with nowhere to go.
 *
 * THE TWO FIELDS THAT GATE NEEDS_CLARIFICATION — contact_name AND
 * phone (Phase 0 finding, revised after real usage). `leads.contact_name`
 * is `not null` with no default (supabase/migrations/20260904140000) and
 * was never relaxed by any later migration — a genuine, unconditional
 * DATABASE constraint. `phone`'s own column is a plain nullable `text`
 * (added nullable by 20260906120000) — no such DB constraint exists for
 * it. But `phone` IS required by createLeadSchema/LeadFormFields (the
 * form this draft is reviewed and saved through refuses to submit
 * without it), so in PRACTICE a lead cannot actually be saved via this
 * flow without one either. Originally only contact_name gated this
 * branch, on the reasoning that this feature shouldn't re-decide
 * "required to save" differently from the form itself — but a silently
 * incomplete READY result, for a field the form is about to demand
 * anyway, isn't a better outcome than asking; it just moves the same
 * friction one step later and gives it no context. That reasoning held
 * up until live testing surfaced a second, sharper reason: OpenRouter's
 * free tiers are not perfectly reliable at pulling a phone number out of
 * unstructured text — a country-code-plus-separator number
 * ("+91-98765-43210") was directly observed to come back null on ~33%
 * of otherwise-identical live requests (2 of 6 runs, all served by the
 * chain's weakest, fallback tier, google/gemma's own tiers being
 * unavailable at the time — see nex-agi/nex-n2.5-mini:free in
 * DEFAULT_CHAIN below). Asking a clarifying question when phone comes
 * back missing turns that miss into an honest "please confirm/provide
 * it" instead of a silently blank required field the reviewer has to
 * notice on their own.
 */

const DEFAULT_CHAIN = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "nex-agi/nex-n2.5-mini:free",
] as const;

/** Generous for the same reason Meeting Notes' own MAX_TOKENS is: tier
 *  3 is a reasoning model whose hidden reasoning tokens count against
 *  this budget before any content is emitted, and a lead's extracted
 *  shape is small, so there's no reason to cut this any tighter than
 *  the sibling feature already proved necessary against the same
 *  chain. */
const MAX_TOKENS = 2000;

/** Per-attempt, matching Meeting Notes' own reasoning exactly: a busy
 *  free-tier endpoint is genuinely slow, but a dark tier must not hold
 *  up the whole chain. */
const REQUEST_TIMEOUT_MS = 45_000;

const nullableExtractedString = (max: number) =>
  z.preprocess(
    // The prompt says to use null for anything not present, but a
    // free-tier model does not always comply literally — an empty
    // string is treated the same as an actual null rather than failing
    // validation (and spending a retry) over that difference.
    (value) => (typeof value === "string" && value.trim() === "" ? null : value),
    z.string().trim().max(max).nullable(),
  );

const extractedLeadSchema = z.object({
  contact_name: nullableExtractedString(200),
  company: nullableExtractedString(200),
  email: nullableExtractedString(200),
  phone: nullableExtractedString(50),
  // Same tolerance as the string fields above, for the same reason.
  deal_value: z.preprocess(
    (value) => (value === "" ? null : value),
    z.number().min(0).max(1_000_000_000).nullable(),
  ),
  source: nullableExtractedString(100),
  next_step: nullableExtractedString(500),
});

const leadExtractionResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("READY"), lead: extractedLeadSchema }),
  z.object({
    status: z.literal("NEEDS_CLARIFICATION"),
    // In practice this holds at most two questions — see the module
    // header: contact_name and phone are the only fields that can
    // trigger this branch, one question each, never combined. Kept as
    // a bounded array rather than a fixed pair to match the general
    // shape the rest of this app's AI features already use
    // (AiGenerationResult's own questions field), and to tolerate the
    // model asking about only one of the two when only one is missing.
    questions: z.array(z.string().trim().min(1).max(300)).min(1).max(3),
  }),
]);

/**
 * Verbatim-adapted from the feature specification's own prompt shape —
 * "notes" removed (no destination field exists for it; see the module
 * header), "next_step" and the source allowlist filled in from Phase 0's
 * real findings.
 */
const SYSTEM_PROMPT = `You are an assistant that extracts a new sales lead's details from a
pasted call transcript or email for a CRM. Return ONLY valid JSON, no
markdown fences, no commentary, matching exactly this shape:

{
  "status": "READY" | "NEEDS_CLARIFICATION",
  "questions": string[],
  "lead": {
    "contact_name": string | null,
    "company": string | null,
    "email": string | null,
    "phone": string | null,
    "deal_value": number | null,
    "source": string | null,
    "next_step": string | null
  }
}

Rules:
- Never invent a name, company, email, phone number, deal value, or any
  other fact that is not clearly present in the source text. If
  uncertain, use null.
- Read the ENTIRE text carefully before deciding a phone number is
  missing — it is easy to miss one embedded mid-sentence or written
  with a country code. "phone" must capture the phone number exactly as
  written in the source, including a country code, spaces, dashes, or
  parentheses if present. A country code prefix (like +91) is part of
  THE SAME phone number, never a separate or ambiguous value:
  "+91-98765-43210" and "+91 98765 43210" are each one phone number, to
  be copied as one string, not split apart or treated as unclear.
- "contact_name" and "phone" are the two fields that can force
  "status": "NEEDS_CLARIFICATION" — between them, this CRM's own lead
  form cannot actually be saved without a name or a phone number. If
  either is missing, or too ambiguous to extract confidently (for
  example several names appear with no clear indication of who the
  lead actually is), set "status" to "NEEDS_CLARIFICATION" and ask one
  short, specific question for EACH one that's missing — a separate
  question per field, never combined into one. Every other field that
  is simply unmentioned should be left null in "lead" with
  "status": "READY" instead — not every missing detail warrants a
  question, only these two.
- "source", if identifiable, must be exactly one of these known values:
  ${LEAD_SOURCES.join(", ")}. If the source mentioned in the text is not
  clearly one of these, leave it null rather than inventing a new value
  or guessing the closest match.
- "next_step" is the single agreed follow-up action, if the source
  clearly states one (for example "send the pricing breakdown by
  Friday") — not a general summary of the conversation.
- Never populate or reason about a WhatsApp number, even if one is
  mentioned in the source text — this schema intentionally has no such
  field, and a phone number must never be assumed to also be a WhatsApp
  number.
- "deal_value" is a plain number with no currency symbol or thousands
  separators, or null if no figure was clearly stated.
- Output must be valid, parseable JSON and nothing else.`;

export type ExtractLeadResult =
  | { ok: true; value: LeadExtractionResult }
  | { ok: false; reason: "not_configured" | "all_tiers_failed"; attempts: string[] };

/**
 * `clarificationContext`, when present, is the user's own answer(s) to
 * a prior NEEDS_CLARIFICATION response — appended as a second, clearly
 * labeled block rather than merged into the original text, so a re-run
 * never has to guess which part of the combined message was actually
 * pasted versus answered afterward.
 */
export async function extractLead(transcript: string, clarificationContext?: string): Promise<ExtractLeadResult> {
  const userContent = clarificationContext
    ? `${transcript}\n\nAdditional context, provided in answer to a clarifying question:\n${clarificationContext}`
    : transcript;

  const result = await runStructuredCompletion({
    systemPrompt: SYSTEM_PROMPT,
    userContent,
    schema: leadExtractionResponseSchema,
    chain: parseChain(process.env.OPENROUTER_MODEL_CHAIN, DEFAULT_CHAIN),
    maxTokens: MAX_TOKENS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    logLabel: "leads:ai",
  });

  if (!result.ok) {
    return result;
  }

  const response = result.value;

  if (response.status === "NEEDS_CLARIFICATION") {
    return { ok: true, value: { status: "NEEDS_CLARIFICATION", questions: response.questions } };
  }

  // DEFENSE IN DEPTH: the prompt tells the model to only pick a source
  // from LEAD_SOURCES, but the model's compliance is never trusted on
  // its own — exactly the same posture this app takes with every other
  // model output (getRegistryEntry() in generate-workflow.ts refuses an
  // unknown node type the same way, rather than trusting the prompt
  // alone). A value outside the real list is dropped to null here,
  // never passed through as a new, invented source.
  const source = response.lead.source && LEAD_SOURCES.includes(response.lead.source) ? response.lead.source : null;

  return {
    ok: true,
    value: { status: "READY", lead: { ...response.lead, source } },
  };
}
