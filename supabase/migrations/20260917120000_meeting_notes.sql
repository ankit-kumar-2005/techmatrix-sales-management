-- ---------------------------------------------------------------------
-- MEETING NOTES — AI-extracted call notes and their action items.
--
-- Two tables, not one, and NOT a JSONB column. The reasoning is below
-- because it is the main design decision in this migration.
--
-- =====================================================================
-- WHY A CHILD TABLE FOR ACTION ITEMS RATHER THAN JSONB
-- =====================================================================
--   1. CLAUDE.md Section F says it outright: "Avoid unnecessary
--      JSON/JSONB fields — prefer real columns and relationships for
--      anything that will be queried, filtered, sorted, or constrained.
--      JSONB is for genuinely schema-flexible data, not a shortcut
--      around modeling." Action items are queried (which are still
--      unconverted?), constrained (priority/type share tasks' own
--      vocabularies) and related (task_id). That is the exact case the
--      rule excludes. There is also currently ZERO json/jsonb anywhere
--      in this schema — this would be the first, introduced for the one
--      thing most likely to be queried.
--
--   2. task_id HAS TO BE A REAL FOREIGN KEY. Phase 4 writes the created
--      task's id back onto the action item. Inside JSONB that is an
--      unvalidated string: nothing stops it naming another tenant's
--      task or one that no longer exists. As a column it gets this
--      project's own composite same-customer treatment —
--      (customer_id, task_id) -> tasks (customer_id, id) — which makes
--      a cross-tenant reference structurally impossible rather than
--      merely discouraged.
--
--   3. PER-ITEM WRITES MUST NOT COLLIDE. Ticking one action item
--      updates one row. With a JSONB array, marking item 3 converted is
--      a read-modify-write of the whole array, so two users ticking two
--      different items race and one write is lost. This project already
--      guards that class of bug deliberately (see resendInvitationAction
--      re-asserting status = 'PENDING' inside its own UPDATE).
--
--   4. THE CHECK CONSTRAINTS ARE THE POINT. suggested_priority and
--      suggested_type mirror tasks' own CHECK vocabularies, so a model
--      hallucinating "Urgent" or "Follow-up" is rejected by the
--      database at write time instead of rendering as a broken pill and
--      failing later in the task dialog. JSONB cannot express that
--      without a bespoke trigger.
--
--   5. Every existing parent/child relationship here is a real table
--      (customer_lead_stages, tasks, contacts,
--      contact_duplicate_dismissals). A JSONB column would be the
--      outlier, not the convention.
--
-- ATTENDEES ARE THE OPPOSITE CASE, and are deliberately a plain
-- text[]: a free-form list of literal names, never joined, never
-- filtered, no foreign key, no vocabulary. contacts.tags is the
-- existing precedent for exactly this shape, and its own migration
-- already argued a plain array over a join table. Same call here.
--
-- =====================================================================
-- V1 STORES NO IMAGE BINARY — AND THE SCHEMA IS SHAPED TO GROW INTO IT
-- =====================================================================
-- An uploaded image is sent to the model, its text extracted into
-- raw_source, and the binary discarded. The only storage precedent in
-- this project is the `avatars` bucket, which is PUBLIC-read — wrong
-- for customer call notes, where an unauthenticated URL would be a
-- cross-tenant leak in an application whose whole schema exists to
-- prevent that.
--
-- This is a deliberate FAST-FOLLOW, not a rejected idea. source_kind
-- records from day one whether a note came from text or an image, so
-- adding a private bucket later is a purely additive migration (one
-- nullable source_image_path column) against rows that already say
-- which ones had an image. No redesign, no backfill of meaning. The
-- column itself is not added now on purpose: a column that is always
-- NULL until a bucket exists is speculative, and CLAUDE.md is explicit
-- about not building directories/columns before a real need.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- PREREQUISITE: tasks gains the composite-unique constraint
-- meeting_note_action_items.task_id needs to reference it
-- same-customer-safely.
--
-- Purely additive; nothing about tasks' existing behaviour changes.
-- This is the identical move 20260911120000 made to `leads` when tasks
-- first needed to point at it, and 20260913120000 made to `contacts`
-- when contact_duplicate_dismissals needed the same — third time, same
-- pattern, deliberately not a new one.
-- ---------------------------------------------------------------------

alter table public.tasks
  add constraint tasks_customer_id_key unique (customer_id, id);

-- =====================================================================
-- 1. meeting_notes
-- =====================================================================

create table public.meeting_notes (
  id uuid primary key default gen_random_uuid(),

  -- The tenant boundary, immutable after creation (trigger below).
  customer_id uuid not null references public.customers (id) on delete cascade,

  -- WHOSE meeting this is, as a customer_users id — NOT an auth.users
  -- id. This is the column RLS keys on, and is_customer_user_visible()
  -- takes a customer_users id, so it has to be this type. Mirrors
  -- tasks.assigned_to exactly (including RESTRICT: the column is NOT
  -- NULL, so ON DELETE SET NULL is impossible, the same note
  -- customer_user_invitations.invited_by already carries).
  owner_id uuid not null,

  -- Optional: a note may be a general call with no lead yet. When set,
  -- the composite FK makes a cross-tenant lead impossible, and SET NULL
  -- means deleting a lead does not destroy the meeting record of it.
  lead_id uuid,

  -- --- What the model extracted -------------------------------------
  title text not null,

  -- Nullable because the extraction prompt itself returns `date: null`
  -- when the source does not state one, and inventing "today" would be
  -- exactly the fabrication that prompt forbids. Named meeting_date
  -- rather than `date` so it never collides with the type name in a
  -- query or an ORDER BY.
  meeting_date date,

  -- Literal names as written in the source. text[], not a join table —
  -- see the header. Empty array, never NULL, matching contacts.tags.
  attendees text[] not null default '{}',

  summary text not null,

  -- --- Provenance ----------------------------------------------------
  -- Whether this came from pasted text or an uploaded image. The
  -- discriminator that makes the private-bucket fast-follow additive
  -- (see header), and useful on its own: a summary derived from a
  -- photo of a whiteboard deserves more scrutiny than one from a
  -- pasted transcript.
  source_kind text not null check (source_kind in ('Text', 'Image')),

  -- The pasted text, or the text the model read out of the image. Kept
  -- so a questionable summary can be checked against what was actually
  -- submitted — without it, a wrong extraction is unfalsifiable.
  raw_source text not null,

  -- Which model actually served the extraction. OpenRouter routes
  -- across providers and this feature has a three-tier fallback chain,
  -- so without this there is no way to tell which tier produced a bad
  -- result. Stored, not derived: the chain's behaviour changes over
  -- time and a historical row must still say what produced it.
  model_used text not null,

  -- --- Convention columns --------------------------------------------
  -- Active/Inactive exactly as every other record in this app. There is
  -- no DELETE policy or grant below: a note is deactivated, never
  -- hard-deleted, so an action item that already produced a real task
  -- can never become an orphan.
  status text not null default 'Active' check (status in ('Active', 'Inactive')),

  -- The auth user who ran the extraction, for audit. Distinct from
  -- owner_id, which is a membership and drives visibility. Same pair
  -- tasks and contacts already carry.
  created_by uuid references auth.users (id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint meeting_notes_title_not_blank check (btrim(title) <> ''),
  constraint meeting_notes_summary_not_blank check (btrim(summary) <> ''),
  constraint meeting_notes_raw_source_not_blank check (btrim(raw_source) <> ''),

  -- Needed so meeting_note_action_items can reference a specific note
  -- same-customer-safely — the same reason leads/contacts/tasks each
  -- gained one.
  constraint meeting_notes_customer_id_key unique (customer_id, id),

  constraint meeting_notes_owner_same_customer_fkey
    foreign key (customer_id, owner_id)
    references public.customer_users (customer_id, id)
    on delete restrict,

  constraint meeting_notes_lead_same_customer_fkey
    foreign key (customer_id, lead_id)
    references public.leads (customer_id, id)
    on delete set null (lead_id)
);

create index meeting_notes_customer_id_idx on public.meeting_notes (customer_id);
create index meeting_notes_owner_id_idx on public.meeting_notes (owner_id);
create index meeting_notes_lead_id_idx on public.meeting_notes (lead_id);
create index meeting_notes_status_idx on public.meeting_notes (status);
-- The list query: this customer's notes, newest first, paginated.
create index meeting_notes_customer_created_at_idx
  on public.meeting_notes (customer_id, created_at desc);

create trigger meeting_notes_set_updated_at
  before update on public.meeting_notes
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- Identity protection: customer_id, owner_id and the extraction inputs
-- are what this row fundamentally IS. Same pattern as
-- protect_task_identity_columns / protect_contact_identity_columns.
--
-- raw_source and model_used are frozen alongside the tenant columns on
-- purpose: they are the EVIDENCE for the summary. If they could be
-- edited after the fact, a note could claim to have been extracted from
-- text it never saw, by a model that never ran — which would make the
-- provenance columns worse than not having them. Re-extracting is a new
-- row, not an edit.
--
-- Deliberately editable: title, meeting_date, attendees, summary,
-- lead_id, status. The model gets things wrong and a human must be able
-- to correct the output and attach the note to the right lead.
-- ---------------------------------------------------------------------

create or replace function public.protect_meeting_note_identity_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.customer_id is distinct from old.customer_id then
    raise exception 'A meeting note cannot be moved to another customer.';
  end if;
  if new.owner_id is distinct from old.owner_id then
    raise exception 'A meeting note cannot be reassigned to another member.';
  end if;
  if new.source_kind is distinct from old.source_kind
     or new.raw_source is distinct from old.raw_source
     or new.model_used is distinct from old.model_used then
    raise exception 'The original source and model of a meeting note cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger meeting_notes_protect_identity_columns
  before update on public.meeting_notes
  for each row execute function public.protect_meeting_note_identity_columns();

-- ---------------------------------------------------------------------
-- RLS — hierarchy-aware, mirroring tasks exactly.
--
-- SELECT keys on owner_id alone, NOT on the linked lead. That is the
-- same choice tasks made (its SELECT policy is
-- is_customer_user_visible(assigned_to), with lead visibility required
-- only on INSERT) and it is deliberate rather than convenient: a note's
-- lead_id is nullable and editable, so making visibility depend on it
-- would mean a note could appear and disappear from someone's list as
-- the lead link changed. Whose meeting it was does not change.
--
-- Consequence, which is the requested behaviour: ADMIN sees the whole
-- customer, MANAGER/SENIOR_SALES_REP see themselves plus their
-- recursive reports, and a SALES_REP sees only their own notes — as an
-- emergent property of is_customer_user_visible(), not a role branch.
-- ---------------------------------------------------------------------

alter table public.meeting_notes enable row level security;

create policy "hierarchy-aware meeting note visibility"
  on public.meeting_notes for select
  to authenticated
  using (public.is_customer_user_visible(owner_id));

-- INSERT: any active member may record their own meeting note, and only
-- their own — owner_id must be the caller's own membership, not merely
-- someone they can see. An admin creating a note "for" a rep would be
-- putting words in that rep's mouth, which is different from assigning
-- them a task, so this is stricter than tasks' INSERT on purpose.
--
-- When a lead is attached it must be one the caller can currently see —
-- the same EXISTS-against-leads check tasks' own INSERT policy uses,
-- restated here rather than extracted into a new shared helper, per
-- that migration's own note.
create policy "members create their own meeting notes"
  on public.meeting_notes for insert
  to authenticated
  with check (
    public.is_customer_member(customer_id)
    and owner_id = (
      select cu.id from public.customer_users cu
      where cu.user_id = auth.uid()
        and cu.customer_id = meeting_notes.customer_id
        and cu.status = 'Active'
    )
    and (
      lead_id is null
      or exists (
        select 1 from public.leads l
        where l.id = meeting_notes.lead_id
          and l.customer_id = meeting_notes.customer_id
      )
    )
  );

-- UPDATE: correcting the extraction, re-linking a lead, deactivating.
-- Scoped to notes the caller can see; the identity trigger above is
-- what stops the editable set from including the provenance columns.
create policy "owners or admins can update a meeting note"
  on public.meeting_notes for update
  to authenticated
  using (
    public.is_customer_admin(customer_id)
    or owner_id = (
      select cu.id from public.customer_users cu
      where cu.user_id = auth.uid()
        and cu.customer_id = meeting_notes.customer_id
        and cu.status = 'Active'
    )
  )
  with check (
    public.is_customer_admin(customer_id)
    or owner_id = (
      select cu.id from public.customer_users cu
      where cu.user_id = auth.uid()
        and cu.customer_id = meeting_notes.customer_id
        and cu.status = 'Active'
    )
  );

-- No DELETE policy and no DELETE grant — deactivate, never hard-delete.
revoke all on public.meeting_notes from anon, authenticated;
grant select, insert, update on public.meeting_notes to authenticated;

-- =====================================================================
-- 2. meeting_note_action_items
--
-- One row per extracted action item. Every "suggested_" column is the
-- MODEL'S SUGGESTION and nothing more — and two columns deliberately do
-- not exist at all:
--
--   * There is NO suggested_lead_id and NO suggested_assignee_id. The
--     model is given no ids and could only invent them. tasks.lead_id
--     and tasks.assigned_to are both NOT NULL with composite
--     same-customer FKs, so a guess would be rejected by the database
--     anyway — but the real reason is that a task silently assigned to
--     the wrong person is worse than no task at all. A human picks both
--     in the existing dialog, every time.
--
--   * suggested_assignee is therefore TEXT: the literal name as written
--     in the source. Resolving it to a real member is the application's
--     job (a fuzzy match against the existing team directory, shown as
--     a hint, never auto-selected) and that match is computed at render
--     time rather than stored — storing it would make a guess look like
--     a decision.
-- =====================================================================

create table public.meeting_note_action_items (
  id uuid primary key default gen_random_uuid(),

  -- Denormalized tenant key, carried for the composite FKs below (the
  -- same reason tasks and contacts carry it). Kept consistent with the
  -- parent by the note FK itself, not by trust.
  customer_id uuid not null references public.customers (id) on delete cascade,

  meeting_note_id uuid not null,

  -- The model's own ordering. Stored because a checklist that reshuffles
  -- between renders is unusable, and "the order the model listed them"
  -- is the only meaningful order available — these have no date, status
  -- or ranking that would give a stable alternative.
  display_order integer not null,

  subject text not null,
  description text,

  -- A literal name from the source, or NULL when the source names
  -- nobody. Never an id — see the table note above.
  suggested_assignee text,

  -- NULL whenever the source gave no date, or a relative one the model
  -- could not anchor. NOT defaulted: tasks.due_date is NOT NULL, so the
  -- human supplies one in the dialog, and inventing a plausible date
  -- here would quietly become a real deadline nobody chose.
  suggested_due_date date,

  -- The same vocabularies as tasks' own CHECK constraints, so a
  -- hallucinated value is rejected on write rather than discovered when
  -- the dialog refuses to submit. Defaults match tasks' defaults.
  suggested_priority text not null default 'Medium'
    check (suggested_priority in ('Low', 'Medium', 'High')),
  suggested_type text not null default 'Other'
    check (suggested_type in ('Call', 'Meeting', 'Email', 'Other')),

  -- Set once a human has confirmed this item through the normal task
  -- dialog. The ONLY link between an extraction and a real task, and it
  -- stores a RELATIONSHIP rather than a copy of any status — the same
  -- choice customer_user_invitations.accepted_customer_user_id makes,
  -- for the same reason: a separate "converted" boolean could drift,
  -- whereas "is this NULL" cannot.
  --
  -- Deliberately no converted_at either. If the task is later deleted
  -- this returns to NULL and the item stops showing struck through —
  -- correct, not a bug: the work is outstanding again.
  task_id uuid,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint meeting_note_action_items_subject_not_blank check (btrim(subject) <> ''),

  constraint meeting_note_action_items_note_same_customer_fkey
    foreign key (customer_id, meeting_note_id)
    references public.meeting_notes (customer_id, id)
    on delete cascade,

  constraint meeting_note_action_items_task_same_customer_fkey
    foreign key (customer_id, task_id)
    references public.tasks (customer_id, id)
    on delete set null (task_id)
);

create index meeting_note_action_items_note_id_idx
  on public.meeting_note_action_items (meeting_note_id, display_order);
create index meeting_note_action_items_customer_id_idx
  on public.meeting_note_action_items (customer_id);

-- One task per action item, and one action item per task: two items
-- pointing at the same task would render two checklist entries both
-- claiming to have produced it. Partial, because NULL is the normal
-- state for every unconverted item and those must not collide.
create unique index meeting_note_action_items_unique_task
  on public.meeting_note_action_items (customer_id, task_id)
  where task_id is not null;

create trigger meeting_note_action_items_set_updated_at
  before update on public.meeting_note_action_items
  for each row execute function public.set_updated_at();

-- Identity protection: an action item belongs to one note in one
-- customer, permanently. Everything a human legitimately changes
-- (task_id on conversion, or correcting a suggestion first) stays
-- editable.
create or replace function public.protect_meeting_note_action_item_identity_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.customer_id is distinct from old.customer_id
     or new.meeting_note_id is distinct from old.meeting_note_id then
    raise exception 'An action item cannot be moved to another meeting note or customer.';
  end if;
  return new;
end;
$$;

create trigger meeting_note_action_items_protect_identity_columns
  before update on public.meeting_note_action_items
  for each row execute function public.protect_meeting_note_action_item_identity_columns();

-- ---------------------------------------------------------------------
-- RLS — derived from the parent, never restated independently.
--
-- Each policy asks "can I see the note this belongs to" via an EXISTS
-- against public.meeting_notes. That subquery runs under the CALLER's
-- own RLS, so the parent's hierarchy-aware policy does the real work
-- and there is no second copy of is_customer_user_visible() here to
-- drift out of step with it. is_customer_member(customer_id) is added
-- on the write policies as a cheap tenant backstop — the same
-- belt-and-braces shape tasks' own INSERT policy uses.
--
-- The practical result is the requested one: a SALES_REP cannot read
-- another rep's action items any more than they can read that rep's
-- note, or that rep's leads.
-- ---------------------------------------------------------------------

alter table public.meeting_note_action_items enable row level security;

create policy "action items follow their meeting note's visibility"
  on public.meeting_note_action_items for select
  to authenticated
  using (
    exists (
      select 1 from public.meeting_notes mn
      where mn.id = meeting_note_action_items.meeting_note_id
    )
  );

create policy "members insert action items on notes they can see"
  on public.meeting_note_action_items for insert
  to authenticated
  with check (
    public.is_customer_member(customer_id)
    and exists (
      select 1 from public.meeting_notes mn
      where mn.id = meeting_note_action_items.meeting_note_id
        and mn.customer_id = meeting_note_action_items.customer_id
    )
  );

-- UPDATE is what links a confirmed task back to its action item.
create policy "members update action items on notes they can see"
  on public.meeting_note_action_items for update
  to authenticated
  using (
    exists (
      select 1 from public.meeting_notes mn
      where mn.id = meeting_note_action_items.meeting_note_id
    )
  )
  with check (
    public.is_customer_member(customer_id)
    and exists (
      select 1 from public.meeting_notes mn
      where mn.id = meeting_note_action_items.meeting_note_id
        and mn.customer_id = meeting_note_action_items.customer_id
    )
  );

-- No DELETE policy or grant: the parent note is deactivated instead, so
-- an item that already produced a real task can never be orphaned.
revoke all on public.meeting_note_action_items from anon, authenticated;
grant select, insert, update on public.meeting_note_action_items to authenticated;

commit;
