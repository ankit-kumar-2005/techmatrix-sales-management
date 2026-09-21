import type { z } from "zod";

/**
 * SHARED OpenRouter transport — the parts of talking to OpenRouter that
 * are genuinely independent of what is being asked for.
 *
 * WHY THIS FILE EXISTS, AND WHERE ITS BOUNDARY IS DRAWN.
 * features/meeting-notes/lib/openrouter.ts got there first and had all
 * of this inside it, fused to the meeting-notes prompt and schema. The
 * automation builder needs the same transport and must not carry a
 * second copy of it. But Meeting Notes is shipped and verified, and part
 * of its chain-walking logic is NOT generic:
 *
 *   - it distinguishes `image_tiers_unavailable` from
 *     `all_tiers_failed`, which only means anything for a feature that
 *     accepts images;
 *   - it tracks which TIER served a response, for resolveTierForModel();
 *   - and its failure strings are a CONTRACT: describeAllTiersFailed()
 *     in features/meeting-notes/actions.ts matches on exact substrings
 *     like "rate-limited (429)" to decide what to tell the user.
 *
 * So the split is: the four pure, stateless helpers below are shared
 * (they were byte-identical and have no behaviour of their own), and
 * runStructuredCompletion() is a NEW generic chain walker for callers
 * that want one. Meeting Notes keeps its own walk, because rewriting a
 * working control flow whose log strings another module parses is not a
 * refactor that can be done safely — and the instruction was to do it
 * only if it could.
 *
 * Server-only, for the same reason the meeting-notes module is: it reads
 * an API key.
 */

if (typeof window !== "undefined") {
  throw new Error("lib/ai/openrouter.ts is server-only and must not be imported by client code.");
}

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

export const JSON_ONLY_REMINDER = "Return ONLY the JSON object, nothing else.";

/**
 * OpenRouter is OpenAI-compatible, so only the sliver of the response
 * actually read is typed — and it is all optional, because a 200 with an
 * unexpected body is precisely what the parse-failure path is for.
 * `content` is deliberately `unknown`: a reasoning model returns
 * `content: null` when it exhausts max_tokens thinking.
 */
export type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  model?: unknown;
};

/** Comma-separated env override, falling back to a compiled-in chain, so
 *  a retired model is a config change rather than a deploy. */
export function parseChain(configured: string | undefined, fallback: readonly string[]): string[] {
  const chain = (configured ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return chain.length > 0 ? chain : [...fallback];
}

/**
 * A short, SAFE diagnostic line built from OpenRouter's own error
 * envelope on a non-ok response.
 *
 * SAFE BY WHAT IT READS, not by filtering afterward. Every field comes
 * from OpenRouter's OWN wrapper describing the PROVIDER's rejection —
 * never our request, never the prompt, never the Authorization header,
 * which lives in a header this function never sees. `metadata.raw` is
 * the one field that is a third party's free text rather than a fixed
 * enum, so it is length-capped as a hedge against a provider ever
 * echoing something back.
 *
 * Deliberately excludes the envelope's `user_id`: it identifies this
 * app's own OpenRouter account, is constant across every request, and
 * has no diagnostic value.
 */
export function describeErrorBody(body: unknown): string {
  if (typeof body !== "object" || body === null) return "no error detail in response body";

  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return "no error detail in response body";

  const message = (error as { message?: unknown }).message;
  const metadata = (error as { metadata?: unknown }).metadata;
  const providerName =
    typeof metadata === "object" && metadata !== null
      ? (metadata as { provider_name?: unknown }).provider_name
      : undefined;
  const providerErrorCode =
    typeof metadata === "object" && metadata !== null
      ? (metadata as { provider_error_code?: unknown }).provider_error_code
      : undefined;
  const raw = typeof metadata === "object" && metadata !== null ? (metadata as { raw?: unknown }).raw : undefined;

  const parts = [
    typeof providerName === "string" && providerName ? `provider=${providerName}` : null,
    typeof providerErrorCode === "string" && providerErrorCode ? `provider_code=${providerErrorCode}` : null,
    typeof message === "string" && message ? `message="${message}"` : null,
    typeof raw === "string" && raw ? `raw="${raw.slice(0, 200)}"` : null,
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(" ") : "no error detail in response body";
}

/**
 * Strips a markdown fence if the model wrapped its JSON in one despite
 * being told not to. Observed often enough to be worth handling rather
 * than treating as a failure — it is the single most common way an
 * otherwise-perfect response fails JSON.parse. Also handles a fence with
 * trailing prose after it, by taking the first fenced block.
 */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

export type StructuredCompletionResult<T> =
  | { ok: true; value: T; servedModel: string }
  | { ok: false; reason: "not_configured" | "all_tiers_failed"; attempts: string[] };

export type StructuredCompletionOptions<T> = {
  systemPrompt: string;
  userContent: string;
  schema: z.ZodType<T>;
  chain: string[];
  maxTokens: number;
  timeoutMs: number;
  /** Prefix for log lines, e.g. "automations". Never interpolated into
   *  the request. */
  logLabel: string;
};

/**
 * Walk a model chain until one returns JSON matching `schema`.
 *
 * Each tier gets one normal attempt and, ONLY if that attempt produced
 * unparseable or wrong-shaped JSON, one retry with the JSON-only
 * reminder. A 429, timeout, HTTP error or empty-content response moves
 * straight to the next tier without retrying, because none of those is
 * a problem a reworded prompt can fix — retrying would just spend
 * another timeout proving it.
 *
 * Returns a discriminated union rather than throwing, so the chain logic
 * stays a plain loop and every caller has to handle failure explicitly.
 */
export async function runStructuredCompletion<T>(
  options: StructuredCompletionOptions<T>,
): Promise<StructuredCompletionResult<T>> {
  // .trim() matching the meeting-notes path exactly: a trailing newline
  // in an env file produces a malformed Authorization header and a 401
  // that looks like a revoked key.
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { ok: false, reason: "not_configured", attempts: [] };
  }

  const attempts: string[] = [];

  for (const model of options.chain) {
    for (const withReminder of [false, true]) {
      const outcome = await attemptOnce(model, apiKey, options, withReminder);

      if (outcome.status === "ok") {
        return { ok: true, value: outcome.value, servedModel: outcome.servedModel };
      }

      attempts.push(`${model}${withReminder ? " (retry)" : ""}: ${outcome.detail}`);

      // Only a parse/shape failure earns the reminder retry. Anything
      // else is a tier problem and the next tier is the right move.
      if (outcome.status !== "parse_failed") {
        break;
      }
    }
  }

  // Model names and category labels only — never the prompt, never the
  // model's output, never the key.
  console.error(`[${options.logLabel}] every model tier failed: ${attempts.join(" | ")}`);
  return { ok: false, reason: "all_tiers_failed", attempts };
}

type AttemptOutcome<T> =
  | { status: "ok"; value: T; servedModel: string }
  | { status: "parse_failed"; detail: string }
  | { status: "tier_failed"; detail: string };

async function attemptOnce<T>(
  model: string,
  apiKey: string,
  options: StructuredCompletionOptions<T>,
  withReminder: boolean,
): Promise<AttemptOutcome<T>> {
  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: options.systemPrompt },
  ];
  if (withReminder) {
    messages.push({ role: "system", content: JSON_ONLY_REMINDER });
  }
  // THE CALLER'S TEXT STAYS IN ITS OWN USER MESSAGE and is never
  // concatenated into the system prompt. That separation is the part
  // that matters: appending untrusted text to the system instruction
  // would give a prompt saying "ignore the above" the same authority as
  // the rules.
  messages.push({ role: "user", content: options.userContent });

  let response: Response;
  try {
    response = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "Techmatrix Sales Management",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
        max_tokens: options.maxTokens,
        // Belt and braces, NOT relied upon: Zod is the authority either
        // way. Sending it measurably reduces fence wrapping.
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(options.timeoutMs),
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
    const category =
      response.status === 429
        ? "rate-limited (429)"
        : response.status >= 500
          ? `provider unavailable (HTTP ${response.status})`
          : `invalid request (HTTP ${response.status})`;

    let bodyDetail: string;
    try {
      bodyDetail = describeErrorBody(await response.json());
    } catch {
      bodyDetail = "error body was not JSON";
    }

    return { status: "tier_failed", detail: `${category} — ${bodyDetail}` };
  }

  let payload: ChatCompletionResponse;
  try {
    payload = (await response.json()) as ChatCompletionResponse;
  } catch {
    return { status: "tier_failed", detail: "response envelope was not JSON" };
  }

  const servedModel = typeof payload.model === "string" && payload.model ? payload.model : model;
  const content = payload.choices?.[0]?.message?.content;

  // A reasoning model returns content: null when max_tokens is exhausted
  // by hidden reasoning. That is a tier problem, not a prompt problem —
  // a reminder would make the response longer, not shorter.
  if (typeof content !== "string" || content.trim() === "") {
    return { status: "tier_failed", detail: "returned no text content" };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(stripJsonFence(content));
  } catch {
    return { status: "parse_failed", detail: "response was not valid JSON" };
  }

  const parsed = options.schema.safeParse(candidate);
  if (!parsed.success) {
    // Valid JSON, wrong shape — also worth one reminder. The issue PATHS
    // are kept (they name our own fields), the messages are not logged
    // verbatim to avoid echoing model output into logs.
    const paths = parsed.error.issues
      .map((issue) => issue.path.join(".") || "(root)")
      .slice(0, 5)
      .join(", ");
    return { status: "parse_failed", detail: `JSON did not match the required shape (${paths})` };
  }

  return { status: "ok", value: parsed.data, servedModel };
}
