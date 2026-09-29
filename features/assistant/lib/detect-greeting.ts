/**
 * A plain greeting ("hii", "hello", "hey") or a general help request
 * ("help", "can you help me", "what can you do") is simple, extremely
 * common, and entirely predictable — exactly the kind of input that
 * should not depend on an LLM correctly classifying it on every single
 * call. Handled here, deterministically, BEFORE a message ever reaches
 * classifyIntent (see actions.ts's own use of this) — faster, free, and
 * removes any chance of the model misclassifying it.
 *
 * REGRESSION THIS FIXES (real conversation, 2026-09-29): a plain "hii"
 * and "can you help me" were both landing on the "I couldn't make sense
 * of that... rephrase it" fallback — the message this app reserves for
 * a genuine ALL-TIERS classification failure, not for ordinary chit-
 * chat. Root cause, confirmed live rather than assumed: the previous
 * fix's new `refers_to_last_discussed` field is REQUIRED whenever
 * `status` is "READY" (see schemas.ts) — for a low-information message
 * like a bare greeting, the model sometimes answers `status: "READY",
 * intent: "unclear"` instead of the intended `NEEDS_CLARIFICATION`
 * pairing, and either omits `refers_to_last_discussed` or gets its
 * shape wrong, which fails Zod validation on every tier. That failure
 * mode is now sidestepped entirely for this whole category of input:
 * a bare greeting/help request never reaches the model at all, so it
 * can never be misclassified by it, regardless of which shape quirk a
 * given free-tier model happens to produce on a given day.
 *
 * DELIBERATELY NARROW, ANCHORED TO THE WHOLE MESSAGE. This must never
 * swallow a real request that merely opens politely ("hi, can you
 * create a lead for Priya Sharma") — every pattern below is matched
 * against the ENTIRE message (after trimming and stripping only
 * TRAILING punctuation), not a prefix or substring. "hi" matches;
 * "hi, can you create a lead for..." does not, because the comma and
 * everything after it are still part of the string these patterns have
 * to fully account for and don't. This is the one deliberate design
 * choice that makes the boundary case safe — see this module's own
 * test coverage via classify-intent's caller (actions.ts) for the
 * live-verified proof.
 */

/** Trims, lowercases, and strips only TRAILING `!`/`?`/`.`/`,` — never
 *  anything in the middle, which is exactly what preserves the
 *  greeting-plus-real-request boundary above. Collapses internal
 *  whitespace so "hi   there" and "hi there" are treated alike. */
function normalize(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[!?.,]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Repeating-letter groups (h+i+, h+e+y+, h+e+l+o+) rather than a fixed
 *  list of spellings — "hii", "hiii", "heyy", "hellooo" are exactly how
 *  people actually type these, and a fixed list would chase an
 *  unbounded set of elongations. A short, optional, contentless filler
 *  ("there", "pipeway", "assistant") is allowed after the greeting
 *  itself; anything else after it is real content and must NOT match. */
const GREETING_ONLY_PATTERN =
  /^(h+i+|h+e+l+o+|h+e+y+a?|y+o+|hola|howdy|greetings|good (morning|afternoon|evening))( there| pipeway| assistant)?$/;

/** Exact phrasings only — "help me create a lead" is a real request and
 *  correctly does NOT match any of these (the trailing content after
 *  "help me" fails the full-string anchor). */
const HELP_ONLY_PATTERN =
  /^(please )?(can you help( me)?|help( me)?( out)?|what can you do|what do you do|how (do you|does this) work|what can you help( me)? with|what can i do( here)?|what is this)$/;

export function detectGreetingOrHelp(message: string): boolean {
  const normalized = normalize(message);
  if (!normalized) return false;
  return GREETING_ONLY_PATTERN.test(normalized) || HELP_ONLY_PATTERN.test(normalized);
}

/** Same tone as the chat panel's own WELCOME_MESSAGE — this is what a
 *  bare greeting or help request gets instead of ever reaching the
 *  model. */
export const GREETING_REPLY =
  "Hi! I can help you create or edit a Lead, Task, or Contact, or give you a summary — just tell me what you'd like to do, or paste a transcript or email.";
