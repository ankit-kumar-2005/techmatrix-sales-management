-- Contacts — a first-class, customer-scoped directory entry, always tied
-- to exactly one Lead (the only relationship this first version needs;
-- there is no existing many-to-many Contact<->Lead architecture to
-- preserve, so the simplest correct model is used). No new role/
-- hierarchy system: reuses is_customer_member, is_customer_admin,
-- is_customer_user_visible, and set_updated_at() exactly as they already
-- exist (20260904140000, 20260906120000, 20260911120000).
--
-- Design notes:
--   * RELATIONSHIP: contacts.lead_id is required (not null) — same shape
--     as tasks.lead_id. contacts.customer_id is stored directly (not
--     derived via a join every time), and the composite FK
--     (customer_id, lead_id) -> leads(customer_id, id) is the same
--     same-customer-safe pattern tasks_lead_same_customer_fkey already
--     established — this is what makes "Contact.customer_id = Customer A,
--     Contact.lead_id = a Customer B lead" a constraint violation, not
--     just an application convention. leads_customer_id_key (the unique
--     constraint the tasks migration added) already covers what this
--     composite FK needs to reference; nothing new is required on leads.
--   * OWNERSHIP: contacts.owner_id is a SECOND, INDEPENDENT relationship
--     from lead_id — a Contact's owner does not have to be its Lead's
--     owner (e.g. Lead owned by a MANAGER, Contact owned by one of that
--     MANAGER's reports). NOT NULL, same-customer-safe composite FK
--     (customer_id, owner_id) -> customer_users(customer_id, id), the
--     same relationship shape leads.owner_id already uses — but
--     ON DELETE RESTRICT rather than leads' SET NULL, because this column
--     is required (a NOT NULL column can't be nulled by a delete anyway),
--     the same reasoning tasks.assigned_to already used for the same
--     required-vs-optional distinction (20260911120000).
--   * VISIBILITY = DERIVED FROM THE CONTACT'S OWN OWNER, NOT THE LINKED
--     LEAD: this is a deliberate correction of this migration's original
--     design (Contacts initially had no owner of their own, so visibility
--     was derived from the linked Lead's owner instead — that is no
--     longer the model now that owner_id exists). is_customer_user_visible
--     (owner_id) ALONE is the complete SELECT/UPDATE predicate — exactly
--     tasks.assigned_to's own reasoning restated for owner_id: ADMIN's
--     branch inside is_customer_user_visible already returns true for
--     ANY target in the customer, so a separate is_customer_admin() OR
--     is not needed; MANAGER/SENIOR_SALES_REP get self + recursive
--     descendants; SALES_REP (a leaf, no reports) ends up seeing only
--     contacts they themselves own — an emergent property of the existing
--     recursive definition, not a separate role-name branch. No new
--     hierarchy helper, no new authorization primitive — is_customer_
--     user_visible is reused completely unchanged.
--   * INSERT/UPDATE reuse the identical is_customer_user_visible(owner_id)
--     predicate — any role may create a Contact (per spec), but the
--     owner_id they assign it to must be within their own visible
--     hierarchy (ADMIN: anyone in the customer; MANAGER/SENIOR_SALES_REP:
--     self + descendants; SALES_REP: self only — again an emergent
--     property, not a special case). UPDATE re-checks the same predicate
--     on the NEW owner_id via WITH CHECK, so a caller can reassign a
--     Contact only to someone else within their own visible hierarchy —
--     this intentionally mirrors tasks' own UPDATE authorization shape,
--     not leads' stricter ADMIN-only-to-change-owner rule: the spec's own
--     Contact-editing requirements ("MANAGER: can change owner within
--     permitted hierarchy") are broader than what leads.owner_id allows
--     today, so no protect_contact_owner_change trigger exists — RLS's
--     WITH CHECK is already the complete, correct enforcement for the
--     rule actually asked for here, with no gap between what RLS allows
--     and what's wanted (unlike leads, where that trigger exists
--     specifically because the desired owner-change rule is narrower than
--     the general "owners or admins can update a lead" RLS policy).
--     lead_id itself carries NO caller-visibility gate on INSERT/UPDATE —
--     only the composite same-customer FK below, which is unconditional
--     and independent of who's asking. This is what makes the "Lead owned
--     by Manager A, Contact owned by Sales Rep B" example work at all: an
--     ADMIN (or anyone whose visible hierarchy includes Sales Rep B)
--     creating that Contact does not also need visibility into Manager
--     A's Lead specifically — only into the customer_user they're
--     assigning ownership to.
--   * IDENTITY PROTECTION: a BEFORE UPDATE trigger
--     (protect_contact_identity_columns) rejects any change to
--     customer_id or lead_id once a contact exists — identical pattern
--     and reasoning to protect_task_identity_columns (20260911120000):
--     a Contact's tenant and its Lead are what define what the row
--     fundamentally IS, not something an ordinary edit should be able to
--     silently repoint.
--   * TAGS: a plain `text[]`, not a join table — the spec's own reference
--     UI is a single free-text "comma-separated" input with no shared/
--     curated taxonomy requirement, so a real relationship table would be
--     unrequested modeling for something that is, today, just a list of
--     strings on one row (see database-design skill: avoid an array
--     column standing in for a relationship — this isn't one, there is no
--     second entity "tag" is a relationship to).
--   * DELETION: no DELETE policy or grant at all — same "deactivate/
--     complete, never hard-delete" posture already used for tasks,
--     customer_lead_stages, and customer_catalog_items. No Contact
--     deletion requirement exists yet, so none is introduced.
--   * DUPLICATE DISMISSAL: "Not a duplicate" must persist (re-running
--     duplicate detection must not keep resurfacing a pair a user already
--     dismissed) — contact_duplicate_dismissals is a small, customer-
--     scoped, append-only table for exactly that, canonically ordered
--     (contact_id_a < contact_id_b) so a pair is represented once
--     regardless of which contact a caller happened to dismiss "against."
--     Requires contacts to have its own (customer_id, id) unique
--     constraint for the same composite-FK-safety reason leads needed
--     leads_customer_id_key.
--   * MERGE is deliberately NOT implemented at the database level in this
--     migration — no merge function, no destructive write path. The
--     business rules a real merge needs (which record survives, field-
--     precedence, what happens to the losing record's own relationships/
--     history) are not defined anywhere in this project yet, and
--     inventing them here would be exactly the "invented destructive
--     business rule" the spec explicitly warns against. The UI still
--     shows a "Merge records" affordance (matching the reference design)
--     but it does not perform any write.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

-- ---------------------------------------------------------------------
-- contacts
-- ---------------------------------------------------------------------

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  lead_id uuid not null,
  owner_id uuid not null,
  name text not null,
  company text,
  title text,
  email text,
  phone text,
  tags text[] not null default '{}',
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contacts_name_not_blank check (btrim(name) <> ''),
  constraint contacts_lead_same_customer_fkey
    foreign key (customer_id, lead_id)
    references public.leads (customer_id, id)
    on delete cascade,
  constraint contacts_owner_same_customer_fkey
    foreign key (customer_id, owner_id)
    references public.customer_users (customer_id, id)
    on delete restrict
);

-- Needed so contact_duplicate_dismissals below can reference a specific
-- contact same-customer-safely, the same reason leads_customer_id_key
-- was added when tasks first needed it.
alter table public.contacts
  add constraint contacts_customer_id_key unique (customer_id, id);

create index contacts_customer_id_idx on public.contacts (customer_id);
create index contacts_lead_id_idx on public.contacts (lead_id);
create index contacts_owner_id_idx on public.contacts (owner_id);
create index contacts_email_idx on public.contacts (email);
create index contacts_phone_idx on public.contacts (phone);
create index contacts_created_at_idx on public.contacts (created_at);

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

create or replace function public.protect_contact_identity_columns()
returns trigger
language plpgsql
as $$
begin
  if new.customer_id is distinct from old.customer_id then
    raise exception 'A contact''s customer cannot be changed.';
  end if;
  if new.lead_id is distinct from old.lead_id then
    raise exception 'A contact''s lead cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger contacts_protect_identity_columns
  before update on public.contacts
  for each row
  execute function public.protect_contact_identity_columns();

-- ---------------------------------------------------------------------
-- Row Level Security — visibility derived from the CONTACT'S OWN owner_id
-- (see design notes above for why this replaced the original lead-
-- derived model). is_customer_user_visible(owner_id) alone is the
-- complete predicate for all three policies — no is_customer_admin() OR
-- needed (ADMIN is already unconditionally true inside that function),
-- no null-guard needed (owner_id is NOT NULL) — exactly
-- tasks.assigned_to's own "hierarchy-aware task visibility" /
-- "visible-hierarchy members can update a task" shape (20260911120000),
-- restated here for owner_id.
-- ---------------------------------------------------------------------

alter table public.contacts enable row level security;

create policy "hierarchy-aware contact visibility"
  on public.contacts for select
  to authenticated
  using (public.is_customer_user_visible(owner_id));

-- INSERT: any active member may create a contact (every role can, per
-- spec), for any Lead in their own customer (the composite same-customer
-- FK is the only gate on lead_id — no caller-visibility check on the
-- LEAD itself, see design notes above), as long as the owner they assign
-- it to is within their own visible hierarchy — ADMIN -> anyone in the
-- customer, MANAGER/SENIOR_SALES_REP -> self + descendants, SALES_REP ->
-- self only (emergent from is_customer_user_visible's own recursive
-- definition, no separate SALES_REP-specific clause exists or is
-- needed).
create policy "members create contacts owned within their visible hierarchy"
  on public.contacts for insert
  to authenticated
  with check (
    public.is_customer_member(customer_id)
    and public.is_customer_user_visible(owner_id)
  );

-- UPDATE: same visibility predicate on both the existing row (USING) and
-- the resulting row (WITH CHECK) — a caller can only update a contact
-- they can currently see, and can only reassign it (owner_id) to someone
-- else within their own visible hierarchy, never outside it.
-- customer_id/lead_id are separately locked by the identity-protection
-- trigger above regardless of what this policy would otherwise allow.
create policy "visible-hierarchy members can update a contact"
  on public.contacts for update
  to authenticated
  using (public.is_customer_user_visible(owner_id))
  with check (public.is_customer_user_visible(owner_id));

-- No DELETE policy or grant — see design notes above.
revoke all on public.contacts from anon, authenticated;
grant select, insert, update on public.contacts to authenticated;

-- ---------------------------------------------------------------------
-- contact_duplicate_dismissals — persistent "Not a duplicate" record.
-- Append-only: no UPDATE/DELETE policy, no undo. Canonically ordered
-- (contact_id_a < contact_id_b, enforced) so the same pair can never be
-- stored twice regardless of which side a caller dismissed from.
-- ---------------------------------------------------------------------

create table public.contact_duplicate_dismissals (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  contact_id_a uuid not null,
  contact_id_b uuid not null,
  dismissed_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint contact_duplicate_dismissals_ordered_pair check (contact_id_a < contact_id_b),
  constraint contact_duplicate_dismissals_unique_pair unique (customer_id, contact_id_a, contact_id_b),
  constraint contact_duplicate_dismissals_contact_a_same_customer_fkey
    foreign key (customer_id, contact_id_a)
    references public.contacts (customer_id, id)
    on delete cascade,
  constraint contact_duplicate_dismissals_contact_b_same_customer_fkey
    foreign key (customer_id, contact_id_b)
    references public.contacts (customer_id, id)
    on delete cascade
);

alter table public.contact_duplicate_dismissals enable row level security;

create policy "members can view their customer's duplicate dismissals"
  on public.contact_duplicate_dismissals for select
  to authenticated
  using (public.is_customer_member(customer_id));

create policy "members can dismiss duplicate contact pairs for their customer"
  on public.contact_duplicate_dismissals for insert
  to authenticated
  with check (public.is_customer_member(customer_id));

-- No UPDATE/DELETE policy or grant — a dismissal is permanent, same
-- append-only posture as the rest of this migration.
revoke all on public.contact_duplicate_dismissals from anon, authenticated;
grant select, insert on public.contact_duplicate_dismissals to authenticated;

commit;
