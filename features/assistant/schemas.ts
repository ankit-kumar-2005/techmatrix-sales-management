import { z } from "zod";
import type { AssistantFields, AssistantIntent } from "@/types/assistant";

/** A chat message, an email, or a pasted transcript is a page of text —
 *  same reasoning and same cap as Meeting Notes' MEETING_NOTES_MAX_LENGTH
 *  and Leads' LEAD_EXTRACTION_MAX_LENGTH: a cost-and-abuse limit on a
 *  feature any signed-in member can invoke, not a model context limit.
 *  Kept here (not in lib/classify-intent.ts) for the identical reason
 *  those two modules already document: this file is safe for a "use
 *  client" component to import (it never reads process.env), and the
 *  chat textarea needs this number too. */
export const ASSISTANT_MESSAGE_MAX_LENGTH = 4000;

/** A whole conversation, capped — matches MAX_AI_PROMPT_LENGTH-style
 *  reasoning elsewhere: the full history is resent every turn (the
 *  model is stateless), so an unbounded conversation would mean an
 *  unbounded, ever-growing request. Generous for a chat, since "New
 *  chat" is one click away the moment it would matter. */
export const ASSISTANT_MAX_TURNS = 40;

export const assistantMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().trim().min(1).max(ASSISTANT_MESSAGE_MAX_LENGTH),
});

export const sendAssistantMessageInputSchema = z.object({
  message: z.string().trim().min(1, "Type, paste, or say something first.").max(ASSISTANT_MESSAGE_MAX_LENGTH),
  history: z.array(assistantMessageSchema).max(ASSISTANT_MAX_TURNS),
});

export type SendAssistantMessageInput = z.infer<typeof sendAssistantMessageInputSchema>;

const ASSISTANT_INTENTS = [
  "create_lead",
  "create_task",
  "create_contact",
  "edit_lead",
  "edit_task",
  "edit_contact",
  "summarize",
  "unclear",
] as const satisfies readonly AssistantIntent[];

const intentSchema = z.enum(ASSISTANT_INTENTS);

const nullableString = (max: number) =>
  z.preprocess(
    // Same tolerance as extract-lead.ts's own nullableExtractedString —
    // a free-tier model does not always emit a literal null for
    // "nothing here." `undefined` is ALSO folded into null here (not
    // just an empty string) — confirmed live (2026-09-29) as a real
    // failure mode: a low-information message like a bare greeting
    // gave a model no reason to think "record_reference" was relevant,
    // and it omitted the key entirely rather than writing `null`.
    // `.nullable()` on its own accepts `null` but rejects `undefined`,
    // which turned an entirely reasonable omission into a hard
    // validation failure on every tier. Folding `undefined` into
    // `null` here closes that gap at its root, for every nullable
    // field, not just the one that happened to trigger it.
    (value) => (value === undefined || (typeof value === "string" && value.trim() === "") ? null : value),
    z.string().trim().max(max).nullable(),
  );

const nullableNumber = z.preprocess(
  (value) => (value === undefined || value === "" ? null : value),
  z.number().min(0).max(1_000_000_000).nullable(),
);

/** Every field the model can populate, across every intent — see
 *  types/assistant.ts's own AssistantFields for which intent reads
 *  which subset. */
const assistantFieldsSchema = z.object({
  contact_name: nullableString(200),
  company: nullableString(200),
  email: nullableString(200),
  phone: nullableString(50),
  deal_value: nullableNumber,
  source: nullableString(100),
  next_step: nullableString(500),
  stage: nullableString(100),
  subject: nullableString(200),
  description: nullableString(2000),
  priority: nullableString(20),
  due_date: nullableString(40),
  type: nullableString(20),
  assignee_name: nullableString(200),
  title: nullableString(200),
  object: z.preprocess(
    // Same `undefined`-to-`null` fold as nullableString above, and the
    // same reason — an omitted key must not fail validation.
    (value) => (value === undefined || (typeof value === "string" && value.trim() === "") ? null : value),
    z.enum(["lead", "task", "contact"]).nullable(),
  ),
}) satisfies z.ZodType<AssistantFields>;

export const assistantResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("NEEDS_CLARIFICATION"),
    intent: intentSchema,
    // In practice at most 2-3 (one per missing required field, or one
    // disambiguating question) — bounded generously, matching every
    // other AI feature's own `questions` cap in this app.
    questions: z.array(z.string().trim().min(1).max(300)).min(1).max(4),
    record_reference: nullableString(200),
  }),
  z.object({
    status: z.literal("READY"),
    intent: intentSchema,
    record_reference: nullableString(200),
    // Defaults to false for a model that omits it entirely (older
    // prompt-shape compliance drift) — false is the SAFE default here:
    // it just means "resolve record_reference normally," never "treat
    // this as a back-reference," so a model that doesn't set it costs
    // nothing more than the clarification questions this feature
    // already asks whenever a reference doesn't resolve.
    refers_to_last_discussed: z.preprocess((value) => value ?? false, z.boolean()),
    fields: assistantFieldsSchema,
  }),
]);

export type AssistantModelResponse = z.infer<typeof assistantResponseSchema>;
