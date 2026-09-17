import type { SupabaseClient } from "@supabase/supabase-js";
import type { MeetingNote, MeetingNoteActionItem } from "@/types/meeting-note";
import { resolveTierForModel } from "./openrouter";

/**
 * Server-side only: a bounded page of this customer's meeting notes with
 * their action items.
 *
 * RLS IS THE SCOPING, NOT THIS FUNCTION. "hierarchy-aware meeting note
 * visibility" on meeting_notes (is_customer_user_visible(owner_id)) is
 * what decides which notes come back — ADMIN the whole customer,
 * MANAGER/SENIOR_SALES_REP their own branch, SALES_REP only their own.
 * The .eq("customer_id") below is belt and braces plus an index hint,
 * never the boundary. The action items query relies on the child table's
 * own policy, which asks the same question via its parent.
 *
 * =====================================================================
 * TWO QUERIES, NOT A POSTGREST EMBED — and that is a tested decision
 * =====================================================================
 * The obvious shape is
 *   .select("*, meeting_note_action_items(*)")
 * which would be one round trip. It is not used because it depends on
 * PostgREST detecting the child's foreign key, and that key is COMPOSITE
 * — (customer_id, meeting_note_id) -> meeting_notes(customer_id, id) —
 * which is the shape every relationship in this schema uses but is not
 * the shape PostgREST's relationship inference is most predictable
 * about. It would likely need an explicit
 * `!meeting_note_action_items_note_same_customer_fkey` disambiguation
 * hint, which then silently breaks if that constraint is ever renamed.
 *
 * I could not verify which form resolves: probing the live API with the
 * publishable key returns 42501 (anon has no grant on these tables, by
 * design) before the embed is ever evaluated, and the OpenAPI spec
 * endpoint requires a secret key. Rather than ship a query shape I could
 * not test, this uses two bounded queries whose behaviour is certain.
 *
 * The cost is one extra round trip per page, not per note — the second
 * query fetches the items for every note on the page in a single
 * `.in()`. Worth revisiting once there is a session to test the embed
 * against.
 */

export type MeetingNoteListItem = MeetingNote & {
  action_items: MeetingNoteActionItem[];
  /** 1-based position in the model chain that produced this note, or
   *  null when model_used is no longer in the chain. Resolved here,
   *  server-side, so the chain config never reaches the browser. */
  tier: number | null;
};

export type MeetingNotesPage = {
  notes: MeetingNoteListItem[];
  totalCount: number;
};

export type MeetingNotesPageParams = {
  page: number;
  pageSize: number;
  /** Matched server-side against title, summary AND attendee names.
   *  Empty/whitespace means no search. */
  search?: string;
};

export async function getMeetingNotesPage(
  supabase: SupabaseClient,
  customerId: string,
  { page, pageSize, search }: MeetingNotesPageParams,
): Promise<MeetingNotesPage> {
  const term = search?.trim() ?? "";

  // TWO PATHS, deliberately — and the split is about risk, not taste.
  // Searching needs search_meeting_notes() because attendees is a text[]
  // that PostgREST cannot partially match (that migration carries the
  // full reasoning). The UNSEARCHED path — the common one, rendered on
  // every visit — keeps the plain .range() query that already shipped
  // and is covered by the mock-client checks. I cannot execute SQL from
  // here, so if the new function has a bug it breaks search only,
  // visibly, instead of taking the whole page down with it.
  //
  // Everything after the first query is shared (attachActionItems), so
  // the two paths cannot diverge in how a note is assembled.
  if (term) {
    return getMeetingNotesPageBySearch(supabase, term, page, pageSize);
  }

  const from = page * pageSize;
  const to = from + pageSize - 1;

  const { data: noteRows, error: notesError, count } = await supabase
    .from("meeting_notes")
    // Explicit column list rather than "*": the same projection
    // discipline PipelineLead/ContactListItem already follow, so adding
    // a column later (source_image_path, when the private-bucket
    // fast-follow lands) does not silently start shipping it to every
    // list render.
    .select(
      "id, customer_id, owner_id, lead_id, title, meeting_date, attendees, summary, source_kind, raw_source, model_used, status, created_by, created_at, updated_at",
      { count: "exact" },
    )
    .eq("customer_id", customerId)
    // Only Active. An Inactive note is either one a user archived or one
    // whose action items failed to insert and was deactivated by the
    // compensating path in persistExtraction — in both cases it must not
    // appear in a list where its empty checklist would read as "the AI
    // found nothing".
    .eq("status", "Active")
    .order("created_at", { ascending: false })
    .range(from, to);

  if (notesError || !noteRows) {
    console.error(`[meeting-notes] could not load notes (code: ${notesError?.code ?? "no rows"}).`);
    return { notes: [], totalCount: 0 };
  }

  return attachActionItems(supabase, noteRows as MeetingNote[], count ?? 0);
}

/** A row from search_meeting_notes: a full note plus the window count.
 *  total_count is optional so it can be deleted before the note is
 *  handed on. */
type SearchRow = MeetingNote & { total_count?: number | string };

/**
 * The search path. One RPC call returns the page AND its total (via a
 * count(*) over () window column), then the shared tail attaches action
 * items exactly as the unsearched path does.
 *
 * No customerId is passed: search_meeting_notes is SECURITY INVOKER, so
 * RLS scopes it to the caller the same way it scopes every other query
 * here. The .eq("customer_id") on the other path is belt and braces plus
 * an index hint, never the boundary — so not having it here loses
 * nothing.
 */
async function getMeetingNotesPageBySearch(
  supabase: SupabaseClient,
  term: string,
  page: number,
  pageSize: number,
): Promise<MeetingNotesPage> {
  const { data, error } = await supabase.rpc("search_meeting_notes", {
    p_search: term,
    p_limit: pageSize,
    p_offset: page * pageSize,
  });

  if (error || !Array.isArray(data)) {
    console.error("[meeting-notes] search failed (code: " + (error?.code ?? "no rows") + ").");
    return { notes: [], totalCount: 0 };
  }

  const rows = data as SearchRow[];

  // total_count is identical on every row (a window over the whole match
  // set), so reading it off the first is enough; zero rows means zero
  // matches. Coerced because a bigint can arrive from PostgREST as a
  // string.
  const parsedTotal = rows.length > 0 ? Number(rows[0].total_count) : 0;

  // total_count is a transport detail, not part of a note — removed so
  // nothing downstream can start depending on it. Written as a delete
  // rather than a discarding destructure because this project's eslint
  // config has no underscore exemption for unused bindings.
  const notes = rows.map((row) => {
    const note: SearchRow = { ...row };
    delete note.total_count;
    return note as MeetingNote;
  });

  return attachActionItems(supabase, notes, Number.isFinite(parsedTotal) ? parsedTotal : 0);
}

/**
 * Shared tail: fetch the action items for a page of notes in ONE bounded
 * .in() query, group them onto their notes, and resolve each note's
 * model tier.
 */
async function attachActionItems(
  supabase: SupabaseClient,
  notes: MeetingNote[],
  totalCount: number,
): Promise<MeetingNotesPage> {
  if (notes.length === 0) {
    return { notes: [], totalCount };
  }

  const { data: itemRows, error: itemsError } = await supabase
    .from("meeting_note_action_items")
    .select(
      "id, customer_id, meeting_note_id, display_order, subject, description, suggested_assignee, suggested_due_date, suggested_priority, suggested_type, task_id, created_at, updated_at",
    )
    .in(
      "meeting_note_id",
      notes.map((note) => note.id),
    )
    .order("display_order", { ascending: true });

  if (itemsError) {
    // FAILS SOFT, and deliberately so: the summaries are still worth
    // showing, and a note legitimately CAN have zero action items. The
    // trade-off is that this one failure mode looks like "no action
    // items" — which is why it is logged loudly here. If it ever shows
    // up in practice the honest fix is to surface a per-card warning,
    // not to blank the whole page.
    console.error(`[meeting-notes] could not load action items (code: ${itemsError.code}).`);
  }

  const itemsByNote = new Map<string, MeetingNoteActionItem[]>();
  for (const item of (itemRows ?? []) as MeetingNoteActionItem[]) {
    const existing = itemsByNote.get(item.meeting_note_id);
    if (existing) existing.push(item);
    else itemsByNote.set(item.meeting_note_id, [item]);
  }

  return {
    notes: notes.map((note) => ({
      ...note,
      action_items: itemsByNote.get(note.id) ?? [],
      tier: resolveTierForModel(note.model_used),
    })),
    totalCount,
  };
}
