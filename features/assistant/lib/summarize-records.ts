import { z } from "zod";
import { parseChain, runStructuredCompletion } from "@/lib/ai/openrouter";
import type { SummarizableContact, SummarizableTask } from "./fetch-records";

/**
 * A Lead ready to hand to the model for a BULK ("summarize all my
 * leads") aggregate overview — the ONLY summarize path that still goes
 * through an LLM at all (a single, specific record now gets a fully
 * deterministic summary instead — see format-summary.ts and actions.ts's
 * own summarize branch). `deal_value` and `stage` are pre-resolved to
 * their real, final display forms by the caller (actions.ts, which has
 * the `supabase`/`customerId` this module deliberately does not) BEFORE
 * they ever reach here — this is what fixes the same two bugs
 * (missing stage, wrong currency) for the bulk/aggregate case too: the
 * model only ever echoes an already-formatted "₹99,999" string and an
 * already-resolved stage name, never invents either one itself.
 */
export type PromptableLead = {
  contact_name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  /** Already formatted via this app's real currencyFormatter (or
   *  null) — never a bare number the model would have to format
   *  itself. */
  deal_value: string | null;
  stage: string | null;
  source: string | null;
  next_step: string | null;
  status: string;
};

/**
 * Turns already-fetched, already-authorized records into a prose
 * summary answering the user's own request.
 *
 * THE MODEL NEVER QUERIES ANYTHING (non-negotiable #2). By the time
 * this function is called, the caller (actions.ts) has already fetched
 * every record it will ever see, through the SAME tenant-and-role-
 * scoped mechanism the real Leads/Tasks/Contacts pages use (see
 * fetch-records.ts's own header for exactly why that's the safe
 * mechanism, not get_automation_records()). This function's only job is
 * to describe data it was handed — it has no tool, no query parameter,
 * and no way to ask for a different or larger set of rows than what's
 * already in `records` below. There is no code path from a user's
 * wording to a broader or different database read.
 */

// Same chain, same tier-3 replacement, and same reasoning as
// classify-intent.ts's own DEFAULT_CHAIN — see its comment for the
// live-verified detail.
const DEFAULT_CHAIN = [
  "google/gemma-4-26b-a4b-it:free",
  "google/gemma-4-31b-it:free",
  "cohere/north-mini-code:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
] as const;

const MAX_TOKENS = 900;
const REQUEST_TIMEOUT_MS = 45_000;

const summaryResponseSchema = z.object({
  summary: z.string().trim().min(1).max(3000),
});

const SYSTEM_PROMPT = `You write a short, plain-English summary of CRM records for the user
who owns them, answering whatever they specifically asked for if
possible. Return ONLY valid JSON, no markdown fences, no commentary,
matching exactly this shape:

{ "summary": string }

Rules:
- Base the summary ONLY on the records provided in the user message
  below. Never invent a record, a count, or a detail not present in
  that data.
- If the provided records are capped (the message says so), be
  explicit that the summary covers "the most recent N" rather than
  implying it's everyone, when relevant to what was asked.
- Write for a busy salesperson: short sentences, concrete numbers,
  no filler. A few sentences or a short list is usually enough.
- If the records list is empty, say so plainly rather than describing
  nothing as something.
- Any "deal_value" or "stage" field you see is ALREADY its final,
  correct, display-ready text (e.g. a deal_value of "₹99,999" is
  already formatted in Indian Rupees, and a stage is already a real
  stage name, never a raw id). Repeat these values EXACTLY as given —
  never reformat a number, never invent or substitute a different
  currency symbol (no "$", ever), never rename or guess a stage.
- Output must be valid, parseable JSON and nothing else.`;

export type SummarizeRecordsResult =
  | { ok: true; summary: string }
  | { ok: false; reason: "not_configured" | "all_tiers_failed" };

async function runSummary(userContent: string): Promise<SummarizeRecordsResult> {
  const result = await runStructuredCompletion({
    systemPrompt: SYSTEM_PROMPT,
    userContent,
    schema: summaryResponseSchema,
    chain: parseChain(process.env.OPENROUTER_MODEL_CHAIN, DEFAULT_CHAIN),
    maxTokens: MAX_TOKENS,
    timeoutMs: REQUEST_TIMEOUT_MS,
    logLabel: "assistant:summarize",
  });

  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  return { ok: true, summary: result.value.summary };
}

/** userRequest is the ORIGINAL message text (e.g. "summarize my
 *  overdue tasks") — the model reads it to decide what angle to
 *  emphasize, but it never changes which records are IN the payload;
 *  that set was already fixed before this function was called. */
export async function summarizeLeads(records: PromptableLead[], userRequest: string): Promise<SummarizeRecordsResult> {
  return runSummary(
    `The user asked: "${userRequest}"\n\nHere are their ${records.length} visible lead(s) (capped at ${records.length === 200 ? "200 — there may be more" : records.length}):\n${JSON.stringify(records, null, 0)}`,
  );
}

export async function summarizeTasks(records: SummarizableTask[], userRequest: string): Promise<SummarizeRecordsResult> {
  return runSummary(
    `The user asked: "${userRequest}"\n\nHere are their ${records.length} visible task(s) (capped at ${records.length === 200 ? "200 — there may be more" : records.length}):\n${JSON.stringify(records, null, 0)}`,
  );
}

export async function summarizeContacts(records: SummarizableContact[], userRequest: string): Promise<SummarizeRecordsResult> {
  return runSummary(
    `The user asked: "${userRequest}"\n\nHere are their ${records.length} visible contact(s) (capped at ${records.length === 200 ? "200 — there may be more" : records.length}):\n${JSON.stringify(records, null, 0)}`,
  );
}
