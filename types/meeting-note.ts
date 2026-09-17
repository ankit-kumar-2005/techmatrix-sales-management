import type { RecordStatus } from "./customer";

/** A row from public.meeting_notes. */
export type MeetingNote = {
  id: string;
  customer_id: string;
  /** customer_users.id — whose meeting this was. Drives RLS visibility
   *  (is_customer_user_visible), NOT an auth.users id. */
  owner_id: string;
  lead_id: string | null;
  title: string;
  /** ISO yyyy-mm-dd, or null when the source stated no date. */
  meeting_date: string | null;
  attendees: string[];
  summary: string;
  source_kind: "Text" | "Image";
  raw_source: string;
  /** Which model actually served the extraction. */
  model_used: string;
  status: RecordStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

/** A row from public.meeting_note_action_items.
 *
 *  Every `suggested_` field is the MODEL'S SUGGESTION, never a decision.
 *  There is deliberately no suggested_lead_id and no
 *  suggested_assignee_id: the model is given no ids and could only
 *  invent them, and a task silently assigned to the wrong person is
 *  worse than no task. A human picks both in the existing task dialog. */
export type MeetingNoteActionItem = {
  id: string;
  customer_id: string;
  meeting_note_id: string;
  display_order: number;
  subject: string;
  description: string | null;
  /** A literal name as written in the source, or null. Resolved to a
   *  real member by a fuzzy match at render time — never stored, because
   *  storing it would make a guess look like a decision. */
  suggested_assignee: string | null;
  suggested_due_date: string | null;
  suggested_priority: "Low" | "Medium" | "High";
  suggested_type: "Call" | "Meeting" | "Email" | "Other";
  /** Set once a human confirmed this item through the normal task
   *  dialog. The ONLY link between an extraction and a real task.
   *  Non-null is what renders the item struck through. */
  task_id: string | null;
  created_at: string;
  updated_at: string;
};

/** A note with its checklist, as the Meeting Notes list renders it. */
export type MeetingNoteWithActionItems = MeetingNote & {
  action_items: MeetingNoteActionItem[];
};
