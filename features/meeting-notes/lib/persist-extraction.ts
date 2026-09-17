import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExtractedMeetingNotes } from "./extraction-schema";
import type { MeetingNotesSourceKind } from "../constants";

/**
 * SERVER-ONLY. Writes one validated extraction into meeting_notes plus
 * its meeting_note_action_items.
 *
 * NOTHING HERE DECIDES WHO MAY WRITE. The caller passes customerId and
 * ownerId from its own membership read, and both tables' INSERT policies
 * re-check them independently — meeting_notes' policy in particular
 * requires owner_id to BE the caller's own active membership, so passing
 * somebody else's id fails at the database rather than being trusted
 * here. This module is a writer, not an authorizer.
 */

export type PersistExtractionResult =
  | { ok: true; meetingNoteId: string; actionItemCount: number }
  | { ok: false; reason: "note_insert_failed" | "items_insert_failed" };

type PersistExtractionParams = {
  supabase: SupabaseClient;
  customerId: string;
  /** customer_users.id of the caller — NOT an auth.users id. */
  ownerId: string;
  /** auth.users id, for the audit column only. */
  createdBy: string;
  sourceKind: MeetingNotesSourceKind;
  /** The pasted text, or the text the model read out of the image. */
  rawSource: string;
  /** The model OpenRouter actually served. */
  modelUsed: string;
  extraction: ExtractedMeetingNotes;
};

export async function persistExtraction({
  supabase,
  customerId,
  ownerId,
  createdBy,
  sourceKind,
  rawSource,
  modelUsed,
  extraction,
}: PersistExtractionParams): Promise<PersistExtractionResult> {
  const { data: note, error: noteError } = await supabase
    .from("meeting_notes")
    .insert({
      customer_id: customerId,
      owner_id: ownerId,
      created_by: createdBy,
      // lead_id is deliberately NOT set here. The model is never asked
      // for one and could only invent it; linking a note to a lead is a
      // human action on the note afterwards. The column is nullable
      // precisely so this is a valid starting state.
      title: extraction.title,
      meeting_date: extraction.date,
      attendees: extraction.attendees,
      summary: extraction.summary,
      source_kind: sourceKind,
      raw_source: rawSource,
      model_used: modelUsed,
      // status takes the column default ('Active').
    })
    .select("id")
    .maybeSingle();

  if (noteError || !note) {
    // Raw Postgres text never reaches the caller (CLAUDE.md Section K);
    // the code is enough to diagnose a policy or constraint problem.
    console.error(`[meeting-notes] meeting_notes insert failed (code: ${noteError?.code ?? "no row returned"}).`);
    return { ok: false, reason: "note_insert_failed" };
  }

  const meetingNoteId = note.id as string;

  // ZERO ACTION ITEMS IS A VALID, SUCCESSFUL RESULT — it is what the
  // extraction prompt's own rule produces when the source is not really
  // meeting notes. Returning early here (rather than inserting an empty
  // array) keeps that case from looking like a failed write, and the UI
  // renders it as "No action items found" rather than an error.
  if (extraction.action_items.length === 0) {
    return { ok: true, meetingNoteId, actionItemCount: 0 };
  }

  // ONE multi-row insert, not a loop: a single statement is atomic among
  // its own rows, so the checklist can never land half-written.
  const { error: itemsError } = await supabase.from("meeting_note_action_items").insert(
    extraction.action_items.map((item, index) => ({
      customer_id: customerId,
      meeting_note_id: meetingNoteId,
      // The model's own ordering. Preserved because a checklist that
      // reshuffles between renders is unusable and there is no other
      // meaningful sort available for these.
      display_order: index,
      subject: item.subject,
      description: item.description,
      suggested_assignee: item.suggested_assignee,
      suggested_due_date: item.suggested_due_date,
      suggested_priority: item.suggested_priority,
      suggested_type: item.suggested_type,
      // task_id stays NULL: this item has not been confirmed into a
      // real task, and only the human-driven dialog ever sets it.
    })),
  );

  if (itemsError) {
    console.error(`[meeting-notes] action item insert failed (code: ${itemsError.code ?? "unknown"}).`);

    // COMPENSATE, don't leave a lie behind. The note row already exists
    // and there is no DELETE grant on the table by design, so it is
    // deactivated instead — the list only shows Active notes, so a note
    // whose action items never landed never appears claiming to have
    // none. That distinction is the whole point: "no action items
    // found" and "extraction failed" must never look the same.
    //
    // A failure of this compensating update is logged and otherwise
    // ignored: the caller is already being told the extraction failed,
    // and turning one error into two helps nobody.
    const { error: deactivateError } = await supabase
      .from("meeting_notes")
      .update({ status: "Inactive" })
      .eq("id", meetingNoteId)
      .eq("customer_id", customerId);

    if (deactivateError) {
      console.error(
        `[meeting-notes] could not deactivate the orphaned note ${meetingNoteId} (code: ${deactivateError.code ?? "unknown"}).`,
      );
    }

    return { ok: false, reason: "items_insert_failed" };
  }

  return { ok: true, meetingNoteId, actionItemCount: extraction.action_items.length };
}
