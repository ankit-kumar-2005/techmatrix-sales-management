"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getFieldErrors } from "@/features/auth/lib/get-field-errors";
import { analyzeModeSchema, analyzeTextSchema, validateImageUpload } from "./schemas";
import { extractMeetingNotes, type ExtractionSource } from "./lib/openrouter";
import { persistExtraction } from "./lib/persist-extraction";
import type { MeetingNotesFormState } from "./form-state";

/**
 * Every failure the extraction chain or the write can report, mapped to
 * what a person should actually read — the same "stable codes in, human
 * copy out" split translateDatabaseError uses for Postgres errors.
 *
 * NONE of these is derived from a provider response, an HTTP body, or a
 * Postgres message. There is no path by which a stack trace, a model's
 * own words, or an environment variable reaches the browser.
 */
const FAILURE_MESSAGES: Record<string, string> = {
  not_configured:
    "Meeting Notes AI isn't configured on the server yet. Ask an administrator to set the OpenRouter API key.",
  no_source: "Add some notes or an image to analyze.",
  source_too_long: "These notes are too long to analyze. Please shorten them and try again.",
  note_insert_failed: "The notes were analyzed but couldn't be saved. Please try again.",
  items_insert_failed: "The notes were analyzed but the action items couldn't be saved. Please try again.",
};

/** Built separately from the map above because it is the one failure
 *  with useful detail to convey: "everything is rate-limited, wait" and
 *  "the models would not produce usable output for this input" call for
 *  different user behaviour, and the attempt trace is what distinguishes
 *  them. Those trace lines are ours — model ids and status codes — never
 *  provider prose. */
function describeAllTiersFailed(attempts: string[] | undefined): string {
  const everyTierThrottled =
    attempts !== undefined &&
    attempts.length > 0 &&
    attempts.every((line) => line.includes("rate-limited") || line.includes("timed out"));

  if (everyTierThrottled) {
    return "Every AI model is busy or rate-limited right now. Please wait a minute and try again — nothing was saved.";
  }

  return "The AI couldn't produce a usable result for this input, even after retrying with a different model. Nothing was saved. Try rephrasing the notes.";
}

/** Separate copy for an IMAGE that exhausted the image chain. The
 *  difference is not cosmetic: only the two Gemma tiers can read an
 *  image (tier 3 rejects the multimodal message format outright, tested
 *  live), and both share one provider rate limit. So when this fires the
 *  image was almost certainly fine and the advice "use a clearer image"
 *  would be actively wrong — pasting the text works right now, and is
 *  what the user should be told. */
function describeImageTiersUnavailable(): string {
  return "Image reading is temporarily unavailable — the AI models that can read images are busy. Nothing was saved. Paste the text of your notes instead, which uses a different model and should work now.";
}

/**
 * Extract structured meeting notes from pasted text or an uploaded
 * image, then persist them.
 *
 * AUTH AND TENANCY, in the order it happens:
 *   1. A session, or /login — the same guard every other action here has.
 *   2. An active customer membership, or /signup. This action spends a
 *      shared, billable API key, so "signed in" is the minimum bar; the
 *      membership is also what supplies owner_id.
 *   3. owner_id is THE CALLER'S OWN membership id, never anything from
 *      the form. meeting_notes' INSERT policy re-checks that
 *      independently (it requires owner_id to equal the caller's own
 *      active membership), so this is belt and braces, not the only
 *      guard.
 *
 * Deliberately NOT role-gated: recording your own meeting is not an
 * administrative act, and RLS already decides who can later see it.
 *
 * WHAT THIS ACTION NEVER DOES: write to `tasks`. An extraction produces
 * suggestions in meeting_note_action_items and nothing more. Turning one
 * into a real task is Phase 4 — through the existing task dialog and the
 * existing createTaskAction, with a human choosing the lead and the
 * assignee every time.
 */
export async function extractMeetingNotesAction(
  _prevState: MeetingNotesFormState,
  formData: FormData,
): Promise<MeetingNotesFormState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  const mode = analyzeModeSchema.safeParse(formData.get("mode"));
  if (!mode.success) {
    return { formError: "Something went wrong with that submission. Please try again." };
  }

  // ---- Build the source, validating BEFORE any network call ----------
  let source: ExtractionSource;
  /** What gets stored in meeting_notes.raw_source. For text this is the
   *  text itself; for an image it is filled in after extraction from
   *  what the model actually read, because the binary is discarded. */
  let rawSourceForText: string | null = null;
  const submittedNotes = typeof formData.get("notes") === "string" ? (formData.get("notes") as string) : "";

  if (mode.data === "Text") {
    const parsed = analyzeTextSchema.safeParse({ notes: submittedNotes });
    if (!parsed.success) {
      return { fieldErrors: getFieldErrors(parsed.error), notes: submittedNotes };
    }
    rawSourceForText = parsed.data.notes;
    source = { kind: "Text", text: parsed.data.notes };
  } else {
    const validated = validateImageUpload(formData.get("image"));
    if (!validated.ok) {
      return { fieldErrors: { image: validated.message } };
    }

    // Base64'd in memory and sent inline. Nothing is written to disk,
    // nothing goes to storage, and the buffer is not retained past this
    // request — that is the whole of the v1 text-only decision.
    const bytes = Buffer.from(await validated.file.arrayBuffer());
    source = { kind: "Image", dataUrl: `data:${validated.file.type};base64,${bytes.toString("base64")}` };
  }

  // ---- Extract -------------------------------------------------------
  // Today's date is resolved HERE, server-side, and passed in — never
  // taken from the client, where a wrong clock or a crafted value would
  // silently shift every relative due date the model resolves.
  const todayIso = new Date().toISOString().slice(0, 10);
  const result = await extractMeetingNotes(source, todayIso);

  if (!result.ok) {
    const message =
      result.reason === "all_tiers_failed"
        ? describeAllTiersFailed(result.attempts)
        : result.reason === "image_tiers_unavailable"
          ? describeImageTiersUnavailable()
          : (FAILURE_MESSAGES[result.reason] ?? "Something went wrong. Please try again.");

    return {
      formError: message,
      ...(mode.data === "Text" ? { notes: submittedNotes } : {}),
    };
  }

  // ---- Persist -------------------------------------------------------
  // For an image, raw_source becomes the text the model read out of it:
  // the summary plus every action item subject. The column is NOT NULL
  // with a not-blank CHECK so something is required, but the real reason
  // is falsifiability — with the binary discarded, this is the only
  // record of what was actually read from the photo.
  const rawSource =
    rawSourceForText ??
    [result.extraction.summary, ...result.extraction.action_items.map((item) => `- ${item.subject}`)]
      .join("\n")
      .trim();

  const persisted = await persistExtraction({
    supabase,
    customerId: membership.customer.id,
    ownerId: membership.membership.id,
    createdBy: user.id,
    sourceKind: mode.data,
    rawSource,
    modelUsed: result.model,
    extraction: result.extraction,
  });

  if (!persisted.ok) {
    return {
      formError: FAILURE_MESSAGES[persisted.reason] ?? "Something went wrong. Please try again.",
      ...(mode.data === "Text" ? { notes: submittedNotes } : {}),
    };
  }

  revalidatePath("/meeting-notes");

  return {
    success: true,
    meetingNoteId: persisted.meetingNoteId,
    actionItemCount: persisted.actionItemCount,
    tier: result.tier,
  };
}

/**
 * Record that a human confirmed an action item into a real task.
 *
 * THIS IS THE ONLY WRITE THIS FEATURE MAKES TO AN ACTION ITEM AFTER
 * EXTRACTION, and it writes exactly one column: task_id. It does not
 * touch `tasks` at all — the task was already created by the existing
 * createTaskAction through the existing dialog, with a human choosing
 * the lead and the assignee. There is no second write path to tasks in
 * this codebase and this action does not become one.
 *
 * WHY IT IS A SEPARATE STEP rather than something createTaskAction does:
 * folding it in would make the Tasks feature import and write a Meeting
 * Notes table, coupling two features so that a change to either can
 * break the other. Two calls means a window where the task exists but
 * is not yet linked — which is the right failure to have, because the
 * task is the thing the user actually wanted. An unlinked item simply
 * stays unstruck and can be ticked again; the partial-unique index on
 * (customer_id, task_id) stops a second attempt from pointing a
 * different item at the same task.
 *
 * AUTHORIZATION IS RLS'S. The UPDATE policy on
 * meeting_note_action_items requires the caller to be able to see the
 * parent note, and the composite FK (customer_id, task_id) -> tasks
 * requires the task to belong to the same customer — so a crafted call
 * naming another tenant's task, or an item on a note the caller cannot
 * see, is rejected by the database rather than by a check here.
 */
export async function linkActionItemToTaskAction(
  actionItemId: string,
  taskId: string,
): Promise<{ success: boolean; error?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
  }

  const { data: updated, error } = await supabase
    .from("meeting_note_action_items")
    .update({ task_id: taskId })
    .eq("id", actionItemId)
    .eq("customer_id", membership.customer.id)
    // Re-asserting "not yet linked" inside the UPDATE itself closes the
    // gap between rendering and this write: if the item was linked by
    // another tab in the meantime, this matches zero rows instead of
    // silently repointing it at a different task.
    .is("task_id", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error(`[meeting-notes] could not link action item to task (code: ${error.code}).`);
    return {
      success: false,
      error: "The task was created, but couldn't be linked back to this action item. Refresh to see its current state.",
    };
  }

  if (!updated) {
    // Either it was already linked, or RLS excluded it. Same response
    // either way — and the task itself was still created, so this is not
    // presented as a failure of the thing the user asked for.
    return {
      success: false,
      error: "The task was created. This action item was already linked, so nothing else changed.",
    };
  }

  revalidatePath("/meeting-notes");
  return { success: true };
}
