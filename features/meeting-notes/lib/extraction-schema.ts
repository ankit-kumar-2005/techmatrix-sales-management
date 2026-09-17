import { z } from "zod";
import { isRealIsoDate } from "@/utils/iso-date";

/**
 * The shape the extraction prompt demands back from the model, and the
 * gate every extraction passes before a single row is written.
 *
 * =====================================================================
 * STRICT ABOUT STRUCTURE, LENIENT ABOUT SUGGESTIONS — on purpose
 * =====================================================================
 *   STRUCTURE (strict): it must be an object with a non-empty summary
 *   and an action_items ARRAY, and every item must have a non-empty
 *   subject. A response missing any of that is not a near-miss, it is a
 *   model that ignored the contract — exactly what should trigger the
 *   "Return ONLY the JSON object" reminder retry and then the next tier.
 *
 *   SUGGESTIONS (lenient): suggested_priority, suggested_type and
 *   suggested_due_date are COERCED to a safe value rather than
 *   rejected. Discarding an otherwise-good extraction of five real
 *   action items because one enum came back "Urgent" instead of "High"
 *   would be the wrong trade — a human reviews every one of these in the
 *   task dialog anyway, and the database CHECK constraints remain the
 *   backstop for anything this misses.
 *
 * =====================================================================
 * EVERY OPTIONAL KEY IS .optional(), AND THAT IS NOT COSMETIC
 * =====================================================================
 * In Zod 4, z.unknown() is NOT implicitly optional for an object key:
 * omitting the key fails with `expected: "nonoptional"`. Zod 3 accepted
 * it. Models routinely omit a key rather than sending an explicit null —
 * the prompt says `string | null`, and "absent" means the same thing
 * here — so without .optional() a good extraction that simply left
 * `description` out would be rejected, retried, and eventually fail the
 * whole chain. Caught by the parse checks rather than by reading docs,
 * which is why it is written down.
 *
 * The object-level .transform() after each schema then normalizes every
 * optional key back to an explicit value, so the OUTPUT type has no
 * optional properties and the persistence layer never has to tell
 * "absent" from "null" when building an insert.
 *
 * Dates go through isRealIsoDate — the same round-trip validator the
 * lead form uses — so a model-suggested "2026-02-30" becomes null rather
 * than silently landing on March 2nd once Postgres parses it.
 */

/** Matches tasks' own CHECK vocabularies. Deliberately not imported from
 *  types/task.ts: those constants describe a REAL task's fields, these
 *  describe a suggestion about one, and the two being the same list
 *  today is a coincidence, not a coupling. */
const SUGGESTED_PRIORITIES = ["Low", "Medium", "High"] as const;
const SUGGESTED_TYPES = ["Call", "Meeting", "Email", "Other"] as const;

/** A missing key, null, "", whitespace, or a non-string all become null.
 *  An empty string is not the same as "absent" once it reaches a
 *  nullable text column; this collapses the difference in one place. */
const optionalModelText = z
  .unknown()
  .optional()
  .transform((value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null));

/** An ISO date the model actually anchored, or null. A relative phrase
 *  it failed to resolve, a non-existent day, a timestamp, a number, or a
 *  missing key all become null. */
const optionalModelIsoDate = z
  .unknown()
  .optional()
  .transform((value) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return isRealIsoDate(trimmed) ? trimmed : null;
  });

/** Capped rather than rejected when a model rambles: this is display
 *  text a human reads beside a picker, not something searched on. */
function capped(value: string | null, max: number): string | null {
  return value === null ? null : value.slice(0, max);
}

export const extractedActionItemSchema = z
  .object({
    // The one genuinely required field: an item with no subject cannot
    // become a task (tasks.subject is NOT NULL with a not-blank CHECK)
    // and cannot be rendered in a checklist either.
    subject: z.string().trim().min(1, "Action item subject is empty.").max(500),

    description: optionalModelText,

    // A literal name as written in the source, never an id.
    suggested_assignee: optionalModelText,

    suggested_due_date: optionalModelIsoDate,

    // .catch() rather than .default(): .default() only fires when the
    // key is ABSENT, while .catch() also fires when the key is present
    // but invalid — which is the actual failure mode here (a model
    // emitting "Urgent", not a model omitting the field).
    suggested_priority: z.enum(SUGGESTED_PRIORITIES).catch("Medium"),
    suggested_type: z.enum(SUGGESTED_TYPES).catch("Other"),
  })
  .transform((item) => ({
    subject: item.subject,
    description: capped(item.description, 2000),
    suggested_assignee: capped(item.suggested_assignee, 200),
    suggested_due_date: item.suggested_due_date,
    suggested_priority: item.suggested_priority,
    suggested_type: item.suggested_type,
  }));

export const extractedMeetingNotesSchema = z
  .object({
    // Falls back rather than failing: a summary without a title is still
    // a useful extraction and the user can rename it. The placeholder is
    // deliberately plain — it should read as "nobody named this yet",
    // not as something the model decided.
    title: optionalModelText,

    date: optionalModelIsoDate,

    // Non-strings inside the array are dropped rather than failing the
    // whole extraction: one malformed attendee entry should not cost the
    // user their action items.
    attendees: z
      .unknown()
      .optional()
      .transform((value) =>
        Array.isArray(value)
          ? value
              .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
              .map((entry) => entry.trim().slice(0, 200))
              .slice(0, 50)
          : [],
      ),

    // Required and non-empty: meeting_notes.summary is NOT NULL with a
    // not-blank CHECK, and a note whose whole point is the summary has
    // nothing to show without one. A structural failure.
    summary: z.string().trim().min(1, "The model returned no summary.").max(8000),

    // MUST be an array, and an EMPTY one is a valid, meaningful result —
    // the prompt's own rule is to return [] when the source is not
    // really meeting notes. The "No action items found" state depends on
    // telling that apart from a failed extraction, which is why a
    // missing or non-array action_items is a hard failure here rather
    // than being coerced to [].
    action_items: z.array(extractedActionItemSchema).max(50),
  })
  .transform((notes) => ({
    title: capped(notes.title, 200) ?? "Untitled meeting note",
    date: notes.date,
    attendees: notes.attendees,
    summary: notes.summary,
    action_items: notes.action_items,
  }));

export type ExtractedActionItem = z.infer<typeof extractedActionItemSchema>;
export type ExtractedMeetingNotes = z.infer<typeof extractedMeetingNotesSchema>;
