-- ---------------------------------------------------------------------
-- Lead Capture: inbound integrations (IndiaMART first)
--
-- WHAT THIS ADDS
--   * leads.notes              the buyer's own enquiry text had nowhere
--                              to live; see below.
--   * leads.external_source_id the source's own id for the enquiry, and
--                              the entire dedupe mechanism for this
--                              phase.
--   * customer_integrations              one row per (customer, source).
--   * customer_integration_participants  the ADMIN-PICKED round-robin
--                              roster. Explicitly not "everyone".
--   * ingest_indiamart_lead()  the whole write path, SECURITY DEFINER.
--
-- ---------------------------------------------------------------------
-- DESIGN NOTES
-- ---------------------------------------------------------------------
--
-- 1. WHY leads.notes EXISTS
--    IndiaMART's payload carries QUERY_MESSAGE (what the buyer actually
--    typed) and QUERY_PRODUCT_NAME (what they enquired about). Those are
--    the most useful fields in the whole push, and `leads` had nowhere
--    to put them: the only free-text column was next_step, which means
--    "what to do next" everywhere else in this app and renders under
--    that label in the Pipeline. Reusing it would have made an inbound
--    enquiry read as an outbound plan. One nullable column instead.
--
-- 2. WHY THE DEDUPE IS A PARTIAL UNIQUE INDEX AND NOT A LOG TABLE
--    IndiaMART retries a push it did not see a 200 for, so the same
--    UNIQUE_QUERY_ID can arrive several times. The index makes a second
--    insert impossible at the database level rather than relying on the
--    application to remember what it has seen. Partial (WHERE
--    external_source_id IS NOT NULL) so that the thousands of
--    hand-created leads, which have no external id, are not forced into
--    a single-row-per-(customer, source) corner.
--
--    NOT COVERED, deliberately: a push with no UNIQUE_QUERY_ID at all.
--    The partial index cannot constrain NULLs, so such a push inserts
--    every time it is retried. IndiaMART always sends the field in its
--    documented shape; this is recorded as a known edge rather than
--    papered over with a synthetic id, which would defeat the whole
--    point by making every retry look unique.
--
-- 3. WHY SELECT ON customer_integrations IS ADMIN-ONLY
--    This is a DELIBERATE DEVIATION from the convention that
--    customer_lead_stages and customer_catalog_items follow, where
--    SELECT is is_customer_member() and only writes are admin-gated.
--    Those tables hold configuration. This one holds webhook_token,
--    which is a BEARER SECRET: whoever has it can post leads into this
--    tenant. Under the member convention every SALES_REP could read
--    their organization's ingest URL. So every policy here is
--    is_customer_admin(), and the settings UI is admin-only to match.
--
-- 4. WHY THE WHOLE WRITE PATH IS ONE SECURITY DEFINER FUNCTION
--    Two independent reasons, either of which alone would force it.
--
--    RLS. The webhook is unauthenticated by nature — IndiaMART posts to
--    a URL, it does not hold a session. There is no auth.uid(), so every
--    RLS policy in this schema evaluates to false and an ordinary insert
--    cannot work. The alternative is a service-role key in the request
--    path, which this project does not have and does not want (CLAUDE.md
--    Section E). A SECURITY DEFINER function granted to `anon` keeps the
--    privileged step inside the database, where its inputs are a fixed
--    signature rather than an arbitrary query.
--
--    ATOMICITY. Round-robin reads last_assigned_owner_id, computes who
--    is next, and writes it back. Done in application code that is a
--    read-modify-write race: two pushes arriving together both read the
--    same last_assigned_owner_id and both assign the same person,
--    forever. Inside one function with SELECT ... FOR UPDATE on the
--    integration row it is serialized and correct.
--
--    The function takes p_token and payload FIELDS only. It never
--    accepts a customer_id: the tenant is resolved from the token and
--    from nothing else, which is the property that makes the endpoint
--    safe to expose. Same shape as accept_customer_user_invitation(),
--    which likewise derives everything trustworthy itself.
--
-- 5. WHY THE STAGE IS RE-VALIDATED INSTEAD OF TRUSTED
--    leads has a BEFORE INSERT trigger (protect_lead_stage_transition)
--    that RAISES unless the target stage exists, belongs to the same
--    customer, and is status = 'Active'. default_stage_id is a plain FK
--    and nothing stops an admin deactivating that stage afterwards. If
--    the function passed it through blindly, every push would start
--    failing — and IndiaMART DEACTIVATES AN INTEGRATION after 48
--    continuous hours of non-200 responses, so a deactivated stage would
--    silently cost the tenant their lead feed. The function therefore
--    only uses default_stage_id while it is still Active, and otherwise
--    falls back to the customer's lowest-display_order Active stage.
--
-- 6. WHY THE OWNER IS RE-VALIDATED TOO
--    Same class of problem. The composite FKs guarantee an owner belongs
--    to the right customer, but not that their membership is still
--    Active. A lead assigned to a deactivated member is invisible to the
--    whole hierarchy (get_visible_team_directory and
--    is_customer_user_visible are both Active-only), so it would land
--    nowhere anybody can see it. Resolution falls back to unassigned,
--    which at least shows up for an admin.
--
-- 7. WHY THE TOKEN IS TWO UUIDS AND NOT gen_random_bytes
--    encode(gen_random_bytes(32), 'hex') would be the obvious call, but
--    it needs pgcrypto, and which schema that extension lives in varies
--    by Supabase project age. gen_random_uuid() is core Postgres 13+ and
--    already used as the default for every primary key in this schema.
--    Two of them, hyphens stripped, is 64 hex characters drawn from 244
--    bits of CSPRNG entropy — unguessable by any standard that matters
--    here, with no extension dependency to get wrong.
--
--    The UNIQUE constraint on webhook_token IS its index; Postgres
--    builds one to enforce uniqueness, so no separate CREATE INDEX.
--    Regeneration is `set webhook_token = default`, which re-runs this
--    expression — no application-side token generation anywhere.
--
-- 8. ROSTER ORDER IS (created_at, id), NOT created_at
--    Rotation has to be a total order or "whoever comes after X" is
--    ambiguous. Two participants added in the same statement share a
--    created_at, so id breaks the tie deterministically.
--
-- 9. source HAS NO CHECK CONSTRAINT, AND THAT IS THE POINT
--    Every other vocabulary column in this schema is a CHECK
--    (status, assignment_mode, pricing_unit, ...) and following that
--    habit here would be wrong. Those vocabularies are closed: there
--    will never be a third value of `status` beyond Active/Inactive.
--    The set of lead SOURCES is open by design — JustDial, TradeIndia,
--    a website form, whatever comes next — and the architecture
--    requirement for this table is that adding one is INSERTING A ROW,
--    with no schema change at all.
--
--    A CHECK would break exactly that: every new source would need an
--    ALTER TABLE, i.e. a migration, a deploy, and a review, to store a
--    string the application already knows. Plain `text not null`
--    instead. The closed set that does exist lives in the application
--    (INTEGRATION_SOURCES in types/integration.ts), where widening it
--    is a code change in the layer that actually has to learn how to
--    parse the new source's payload anyway.
--
--    Not constrained to non-blank either, deliberately kept as the one
--    line it is: `source` is never user input. It is written by
--    ingest_indiamart_lead() as a literal and by connectIndiamartAction
--    from a typed constant, so a blank value has no path in.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- leads: the buyer's message, and the external id that dedupes retries
-- ---------------------------------------------------------------------

alter table public.leads
  add column notes text,
  add column external_source_id text;

-- Partial: only rows that actually came from an external source are
-- constrained. See design note 2.
create unique index leads_external_source_unique
  on public.leads (customer_id, source, external_source_id)
  where external_source_id is not null;

-- ---------------------------------------------------------------------
-- customer_integrations
-- ---------------------------------------------------------------------

create table public.customer_integrations (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  -- DELIBERATELY UNCONSTRAINED — see design note 9. Adding JustDial or
  -- TradeIndia later must be inserting a row, never altering this
  -- table. A CHECK here would make every new source a schema change,
  -- which is the exact thing the Open/Closed requirement rules out.
  source text not null,
  webhook_token text not null unique
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  status text not null default 'Active' check (status in ('Active', 'Inactive')),
  default_stage_id uuid,
  assignment_mode text not null default 'Fixed'
    check (assignment_mode in ('Fixed', 'RoundRobin')),
  default_owner_id uuid,
  last_assigned_owner_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- One integration per source per customer. Without this an admin
  -- could end up with two IndiaMART rows and two live webhook URLs,
  -- each with its own rotation state.
  constraint customer_integrations_source_key unique (customer_id, source),

  -- Needed so customer_integration_participants can carry a composite
  -- FK back to (customer_id, id) — the same thing leads, contacts and
  -- tasks each had to add when something first pointed at them.
  constraint customer_integrations_customer_id_key unique (customer_id, id),

  constraint customer_integrations_stage_same_customer_fkey
    foreign key (customer_id, default_stage_id)
    references public.customer_lead_stages (customer_id, id)
    on delete set null (default_stage_id),

  constraint customer_integrations_default_owner_same_customer_fkey
    foreign key (customer_id, default_owner_id)
    references public.customer_users (customer_id, id)
    on delete set null (default_owner_id),

  constraint customer_integrations_last_owner_same_customer_fkey
    foreign key (customer_id, last_assigned_owner_id)
    references public.customer_users (customer_id, id)
    on delete set null (last_assigned_owner_id)
);

create index customer_integrations_customer_id_idx
  on public.customer_integrations (customer_id);

create trigger customer_integrations_set_updated_at
  before update on public.customer_integrations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------
-- customer_integration_participants — the admin-picked round-robin
-- roster. Adding or removing somebody is adding or removing a row.
-- ---------------------------------------------------------------------

create table public.customer_integration_participants (
  id uuid primary key default gen_random_uuid(),
  -- Denormalized so both composite FKs below can be same-customer
  -- enforced, the pattern this schema uses everywhere.
  customer_id uuid not null,
  integration_id uuid not null,
  customer_user_id uuid not null,
  created_at timestamptz not null default now(),

  constraint customer_integration_participants_integration_fkey
    foreign key (customer_id, integration_id)
    references public.customer_integrations (customer_id, id)
    on delete cascade,

  constraint customer_integration_participants_user_fkey
    foreign key (customer_id, customer_user_id)
    references public.customer_users (customer_id, id)
    on delete cascade,

  constraint customer_integration_participants_unique
    unique (integration_id, customer_user_id)
);

-- Rotation reads this in (created_at, id) order for one integration.
create index customer_integration_participants_rotation_idx
  on public.customer_integration_participants (integration_id, created_at, id);

-- ---------------------------------------------------------------------
-- RLS — admin-only throughout, including SELECT. See design note 3.
-- ---------------------------------------------------------------------

alter table public.customer_integrations enable row level security;

create policy "admins can view their customer's integrations"
  on public.customer_integrations for select
  to authenticated
  using (public.is_customer_admin(customer_id));

create policy "admins can create integrations for their customer"
  on public.customer_integrations for insert
  to authenticated
  with check (public.is_customer_admin(customer_id));

create policy "admins can update their customer's integrations"
  on public.customer_integrations for update
  to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

-- No DELETE policy: an integration is deactivated (status = 'Inactive'),
-- never deleted, so the leads it produced keep a source row to point
-- back at. Same stance as customer_catalog_items and
-- customer_lead_stages.
revoke all on public.customer_integrations from anon, authenticated;
grant select, insert, update on public.customer_integrations to authenticated;

alter table public.customer_integration_participants enable row level security;

create policy "admins can view their customer's integration participants"
  on public.customer_integration_participants for select
  to authenticated
  using (public.is_customer_admin(customer_id));

create policy "admins can add integration participants for their customer"
  on public.customer_integration_participants for insert
  to authenticated
  with check (public.is_customer_admin(customer_id));

-- DELETE *is* granted here, unlike everywhere else in this schema:
-- removing somebody from a rotation roster is not archiving a business
-- record, it is un-checking a checkbox. There is nothing to preserve
-- and no history that depends on the row — the leads already assigned
-- to that person keep their owner_id regardless.
create policy "admins can remove integration participants for their customer"
  on public.customer_integration_participants for delete
  to authenticated
  using (public.is_customer_admin(customer_id));

revoke all on public.customer_integration_participants from anon, authenticated;
grant select, insert, delete on public.customer_integration_participants to authenticated;

-- ---------------------------------------------------------------------
-- ingest_indiamart_lead — the entire webhook write path.
-- See design notes 4, 5 and 6.
-- ---------------------------------------------------------------------

create or replace function public.ingest_indiamart_lead(
  p_token text,
  p_unique_query_id text,
  p_sender_name text,
  p_sender_mobile text,
  p_sender_email text,
  p_sender_company text,
  p_query_product_name text,
  p_query_message text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_integration public.customer_integrations;
  v_stage_id uuid;
  v_owner_id uuid;
  v_total integer;
  v_current_rn integer;
  v_external_id text;
  v_company text;
  v_contact text;
  v_notes text;
  v_inserted uuid;
begin
  -- 1. THE ONLY TENANT RESOLUTION THERE IS. Everything downstream uses
  --    v_integration.customer_id; nothing in the payload is ever
  --    consulted for it. FOR UPDATE because step 3 may write
  --    last_assigned_owner_id back and two pushes must not interleave
  --    (design note 4).
  select * into v_integration
  from public.customer_integrations
  where webhook_token = p_token
    and source = 'IndiaMART'
    and status = 'Active'
  for update;

  -- Unknown token, wrong source, or deactivated integration are one
  -- answer, so the caller can return a generic 404 that distinguishes
  -- none of them.
  if not found then
    return 'unknown_token';
  end if;

  -- 2. Dedupe BEFORE resolving the owner. A retried push must not
  --    advance the round-robin rotation — otherwise every retry burns a
  --    participant's turn. The unique index is still the real guarantee
  --    (see the ON CONFLICT below); this is what keeps the common case
  --    from having side effects.
  v_external_id := nullif(btrim(coalesce(p_unique_query_id, '')), '');

  if v_external_id is not null and exists (
    select 1 from public.leads
    where customer_id = v_integration.customer_id
      and source = 'IndiaMART'
      and external_source_id = v_external_id
  ) then
    return 'duplicate';
  end if;

  -- 3. Stage: the configured default only while it is still Active,
  --    else the lowest-display_order Active stage (design note 5).
  select cls.id into v_stage_id
  from public.customer_lead_stages cls
  where cls.id = v_integration.default_stage_id
    and cls.customer_id = v_integration.customer_id
    and cls.status = 'Active';

  if v_stage_id is null then
    select cls.id into v_stage_id
    from public.customer_lead_stages cls
    where cls.customer_id = v_integration.customer_id
      and cls.status = 'Active'
    order by cls.display_order, cls.id
    limit 1;
  end if;

  -- A customer with no Active stage at all cannot hold a lead, because
  -- leads.stage_id is NOT NULL. Reported distinctly so the caller can
  -- log something actionable rather than a generic failure.
  if v_stage_id is null then
    return 'no_active_stage';
  end if;

  -- 4. Owner.
  if v_integration.assignment_mode = 'Fixed' then
    -- Re-checked for Active (design note 6); null when unset or stale.
    select cu.id into v_owner_id
    from public.customer_users cu
    where cu.id = v_integration.default_owner_id
      and cu.customer_id = v_integration.customer_id
      and cu.status = 'Active';
  else
    -- ROTATION BY POSITION, not by "whoever sorts after X".
    --
    -- The obvious form is `where (created_at, id) > (the last assignee's
    -- (created_at, id))`, which reads well but compares a row
    -- constructor against a scalar subquery of anonymous record type —
    -- something Postgres accepts only in some shapes, and this is not a
    -- place to find out which. Numbering the roster and doing modular
    -- arithmetic on the position is unambiguous, and it makes all three
    -- wrap cases fall out of one expression instead of a second query.
    --
    -- Only Active members count, for the reason in design note 6.
    select count(*) into v_total
    from public.customer_integration_participants p
    join public.customer_users cu
      on cu.id = p.customer_user_id
     and cu.customer_id = p.customer_id
    where p.integration_id = v_integration.id
      and cu.status = 'Active';

    if v_total = 0 then
      -- Empty roster (or everyone on it deactivated). Falls through to
      -- an unassigned lead rather than an error.
      v_owner_id := null;
    else
      -- The last assignee's 1-based position, or NULL when the rotation
      -- has never run or they are no longer on the roster.
      select r.rn into v_current_rn
      from (
        select p.customer_user_id,
               row_number() over (order by p.created_at, p.id) as rn
        from public.customer_integration_participants p
        join public.customer_users cu
          on cu.id = p.customer_user_id
         and cu.customer_id = p.customer_id
        where p.integration_id = v_integration.id
          and cu.status = 'Active'
      ) r
      where r.customer_user_id = v_integration.last_assigned_owner_id;

      -- One expression, three cases:
      --   never run / removed  -> 0 % n + 1 = 1   (start of roster)
      --   at position k < n    -> k + 1           (next)
      --   at the last position -> n % n + 1 = 1   (wrap)
      v_current_rn := (coalesce(v_current_rn, 0) % v_total) + 1;

      select r.customer_user_id into v_owner_id
      from (
        select p.customer_user_id,
               row_number() over (order by p.created_at, p.id) as rn
        from public.customer_integration_participants p
        join public.customer_users cu
          on cu.id = p.customer_user_id
         and cu.customer_id = p.customer_id
        where p.integration_id = v_integration.id
          and cu.status = 'Active'
      ) r
      where r.rn = v_current_rn;
    end if;

    -- Only advanced when somebody was actually chosen. An empty roster
    -- leaves the rotation exactly where it was and the lead unassigned
    -- — an admin who switched on round-robin before adding anybody must
    -- not cause failed ingestion.
    if v_owner_id is not null then
      update public.customer_integrations
        set last_assigned_owner_id = v_owner_id
      where id = v_integration.id;
    end if;
  end if;

  -- 5. Normalize the payload into this app's own lead shape.
  --    leads.company and leads.contact_name are both NOT NULL, and
  --    IndiaMART's SENDER_COMPANY is routinely empty for an individual
  --    buyer — so company falls back to the person's name, and the
  --    literal marker is a last resort rather than a blank row.
  v_contact := nullif(btrim(coalesce(p_sender_name, '')), '');
  v_company := coalesce(
    nullif(btrim(coalesce(p_sender_company, '')), ''),
    v_contact,
    'IndiaMART enquiry'
  );
  v_contact := coalesce(v_contact, 'IndiaMART enquiry');

  -- concat_ws skips NULL parts, so an enquiry with only a message and
  -- no product name does not end up with a stray leading newline.
  v_notes := nullif(btrim(concat_ws(
    E'\n',
    case
      when btrim(coalesce(p_query_product_name, '')) <> ''
      then 'Product: ' || btrim(p_query_product_name)
    end,
    nullif(btrim(coalesce(p_query_message, '')), '')
  )), '');

  -- 6. Insert. ON CONFLICT DO NOTHING is the backstop for a genuine
  --    race that slipped past step 2 — two retries landing at once.
  insert into public.leads (
    customer_id, company, contact_name, email, phone, whatsapp_phone,
    stage_id, owner_id, source, external_source_id, notes, deal_value, status
  ) values (
    v_integration.customer_id,
    v_company,
    v_contact,
    nullif(btrim(coalesce(p_sender_email, '')), ''),
    nullif(btrim(coalesce(p_sender_mobile, '')), ''),
    nullif(btrim(coalesce(p_sender_mobile, '')), ''),
    v_stage_id,
    v_owner_id,
    'IndiaMART',
    v_external_id,
    v_notes,
    0,
    'Active'
  )
  on conflict do nothing
  returning id into v_inserted;

  if v_inserted is null then
    return 'duplicate';
  end if;

  return 'created';
end;
$$;

-- Granted to anon because the caller has no session by definition — the
-- webhook is a machine posting to a URL. That is the entire reason this
-- function is SECURITY DEFINER and takes a token rather than a
-- customer_id: see design note 4.
revoke all on function public.ingest_indiamart_lead(
  text, text, text, text, text, text, text, text
) from public;
grant execute on function public.ingest_indiamart_lead(
  text, text, text, text, text, text, text, text
) to anon, authenticated;

commit;
