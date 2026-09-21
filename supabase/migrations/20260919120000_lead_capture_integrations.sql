-- ---------------------------------------------------------------------
-- Lead Capture: inbound integrations (IndiaMART first)
--
-- WHAT THIS ADDS
--   * leads.notes              the buyer's own enquiry text had nowhere
--                              to live; see below.
--   * leads.external_source_id the source's own id for the enquiry, and
--                              the entire dedupe mechanism for this
--                              phase.
--   * leads.address             a single free-text postal address column;
--                              see the adapter-layer note in design note
--                              1 for why the FIVE separate fields a
--                              source might send are joined before they
--                              ever reach this migration.
--   * customer_integrations              one row per (customer, source).
--   * customer_integration_participants  the ADMIN-PICKED round-robin
--                              roster. Explicitly not "everyone".
--   * ingest_lead()  the whole write path, SECURITY DEFINER, and
--                              DELIBERATELY GENERIC — see design note 10.
--
-- ---------------------------------------------------------------------
-- DESIGN NOTES
-- ---------------------------------------------------------------------
--
-- 1. WHY leads.notes AND leads.address EXIST
--    IndiaMART's payload carries QUERY_MESSAGE (what the buyer actually
--    typed) and QUERY_PRODUCT_NAME (what they enquired about). Those are
--    the most useful fields in the whole push, and `leads` had nowhere
--    to put them: the only free-text column was next_step, which means
--    "what to do next" everywhere else in this app and renders under
--    that label in the Pipeline. Reusing it would have made an inbound
--    enquiry read as an outbound plan. One nullable column instead.
--
--    address is the same idea for IndiaMART's five separate location
--    fields (SENDER_ADDRESS, SENDER_CITY, SENDER_STATE, SENDER_PINCODE,
--    SENDER_COUNTRY_ISO). Neither concatenation happens in this
--    migration: joining QUERY_PRODUCT_NAME with QUERY_MESSAGE into one
--    notes string, and joining the five address parts into one address
--    string, are both decisions about how ONE vendor's payload maps onto
--    these generic columns — that belongs in that vendor's own adapter
--    (features/integrations/lib/providers/), not in ingest_lead(), which
--    only ever sees the single already-composed p_notes and p_address
--    values by the time it runs. See design note 10.
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
--    RLS. A lead-source webhook is unauthenticated by nature — the
--    vendor posts to a URL, it does not hold a session. There is no
--    auth.uid(), so every RLS policy in this schema evaluates to false
--    and an ordinary insert cannot work. The alternative is a
--    service-role key in the request path, which this project does not
--    have and does not want (CLAUDE.md Section E). A SECURITY DEFINER
--    function granted to `anon` keeps the privileged step inside the
--    database, where its inputs are a fixed signature rather than an
--    arbitrary query.
--
--    ATOMICITY. Round-robin reads last_assigned_owner_id, computes who
--    is next, and writes it back. Done in application code that is a
--    read-modify-write race: two pushes arriving together both read the
--    same last_assigned_owner_id and both assign the same person,
--    forever. Inside one function with SELECT ... FOR UPDATE on the
--    integration row it is serialized and correct.
--
--    The function takes p_token and NORMALIZED payload FIELDS only —
--    generic ones (p_contact_name, p_company, ...), never a vendor's own
--    field names (see design note 10). It never accepts a customer_id:
--    the tenant is resolved from the token and from nothing else, which
--    is the property that makes the endpoint safe to expose. Same shape
--    as accept_customer_user_invitation(), which likewise derives
--    everything trustworthy itself.
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
--    line it is: `source` is never user input. On the write side it is
--    written by connectIndiamartAction from a typed constant; on the
--    ingest side ingest_lead() writes v_integration.source — the value
--    already sitting in the row a webhook_token resolved to, never a
--    literal and never the caller's own claim — so a blank value has no
--    path in either way.
--
-- 10. WHY ingest_lead() IS GENERIC, AND WHAT THE p_source PARAMETER
--     ACTUALLY GUARDS
--     Originally this function was ingest_indiamart_lead(), took
--     IndiaMART's own field names as parameters (p_sender_name,
--     p_query_message, ...), and filtered its token lookup by
--     `and source = 'IndiaMART'`. That welded two unrelated jobs
--     together: parsing one vendor's payload shape, and the universal
--     mechanics every source needs regardless of vendor (token
--     resolution, dedupe, round-robin, stage/owner fallback, the
--     insert). Adding a second source would have meant either
--     duplicating every one of those universal pieces into a second
--     function, or somehow parameterizing vendor-specific field names
--     into one function — both wrong. The vendor-specific parsing now
--     lives entirely in features/integrations/lib/providers/ (one
--     adapter per source, TypeScript, no SQL); this function knows
--     nothing about any vendor's field names and never will.
--
--     THE TOKEN LOOKUP IS BY webhook_token ALONE, NOT ALSO BY source.
--     webhook_token already carries a UNIQUE constraint, so it already
--     uniquely determines both which tenant a push belongs to AND which
--     source that tenant's integration actually is — filtering by
--     source too would be redundant at best.
--
--     p_source (what the URL's own :source segment claimed) is checked
--     SEPARATELY, immediately after resolving the token, and ONLY as a
--     belt-and-braces sanity check: if it disagrees with
--     v_integration.source (the true source the token belongs to), this
--     returns the exact same 'unknown_token' a truly unknown token
--     would — never a distinct answer. That is deliberate: a token
--     pasted into the wrong vendor's URL slot (e.g. IndiaMART's token
--     posted to a /justdial/ path) is caught without needing a second
--     security mechanism, and without ever revealing to an
--     unauthenticated caller that the token is real but was used wrong
--     — which would leak more than a flat 404 does.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- leads: the buyer's message, and the external id that dedupes retries
-- ---------------------------------------------------------------------

alter table public.leads
  add column notes text,
  add column external_source_id text,
  add column address text;

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
-- ingest_lead — the entire webhook write path, and DELIBERATELY GENERIC.
-- See design notes 4, 5, 6 and 10.
-- ---------------------------------------------------------------------

create or replace function public.ingest_lead(
  p_token text,
  p_source text,
  p_external_id text,
  p_contact_name text,
  p_company text,
  p_email text,
  p_phone text,
  p_address text,
  p_notes text
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
  v_email text;
  v_phone text;
  v_address text;
  v_notes text;
  v_inserted uuid;
begin
  -- 1. THE ONLY TENANT RESOLUTION THERE IS. Everything downstream uses
  --    v_integration.customer_id (and v_integration.source — see step 2
  --    below); nothing in the payload is ever consulted for either.
  --    FOR UPDATE because step 4 may write last_assigned_owner_id back
  --    and two pushes must not interleave (design note 4).
  --
  --    BY webhook_token ALONE, not also filtered by source — see design
  --    note 10 for why that would be redundant.
  select * into v_integration
  from public.customer_integrations
  where webhook_token = p_token
    and status = 'Active'
  for update;

  -- Unknown token, or a deactivated integration, are one answer, so the
  -- caller can return a generic 404 that distinguishes neither.
  if not found then
    return 'unknown_token';
  end if;

  -- Belt-and-braces (design note 10): the URL's own :source segment
  -- must agree with what the token actually belongs to. A mismatch gets
  -- the EXACT SAME answer as a truly unknown token — never a distinct
  -- one, which would tell an unauthenticated caller the token is real.
  if v_integration.source is distinct from p_source then
    return 'unknown_token';
  end if;

  -- 2. Dedupe BEFORE resolving the owner. A retried push must not
  --    advance the round-robin rotation — otherwise every retry burns a
  --    participant's turn. The unique index is still the real guarantee
  --    (see the ON CONFLICT below); this is what keeps the common case
  --    from having side effects. Scoped by v_integration.source (the
  --    TRUE source the token resolved to), not p_source — the two are
  --    confirmed equal by this point, but v_integration.source is the
  --    one that was never merely a caller's claim.
  v_external_id := nullif(btrim(coalesce(p_external_id, '')), '');

  if v_external_id is not null and exists (
    select 1 from public.leads
    where customer_id = v_integration.customer_id
      and source = v_integration.source
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

  -- 5. Normalize the ALREADY-PARSED fields into this app's own lead
  --    shape. Every vendor-specific fallback chain (design note 10's
  --    whole point) already ran in that vendor's own adapter before
  --    this function was ever called — a source-specific "if this field
  --    is empty, fall back to that one" decision belongs there, not
  --    here (see features/integrations/lib/providers/ for the concrete
  --    per-source example).
  --
  --    What remains here is the ONE fallback that is genuinely
  --    universal rather than vendor-specific: leads.company and
  --    leads.contact_name are both NOT NULL, and a source can still
  --    send neither (an adapter's own chain can legitimately end in
  --    null). Built from p_source rather than a hardcoded vendor name,
  --    so this produces "IndiaMART enquiry" today with zero code here
  --    devoted to IndiaMART specifically, and "JustDial enquiry" for a
  --    future source with zero changes to this function at all.
  v_contact := nullif(btrim(coalesce(p_contact_name, '')), '');
  v_company := nullif(btrim(coalesce(p_company, '')), '');
  v_company := coalesce(v_company, v_contact, p_source || ' enquiry');
  v_contact := coalesce(v_contact, p_source || ' enquiry');

  v_email := nullif(btrim(coalesce(p_email, '')), '');
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_address := nullif(btrim(coalesce(p_address, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');

  -- 6. Insert. ON CONFLICT DO NOTHING is the backstop for a genuine
  --    race that slipped past step 2 — two retries landing at once.
  --    source is v_integration.source (design note 10's "the true
  --    source", never p_source and never a literal) — same value used
  --    for the dedupe check in step 2, so the two can never disagree.
  --
  --    whatsapp_phone = v_phone, same as before this split: this
  --    function still has no dedicated "this IS a WhatsApp number"
  --    input, because the signature Phase 1 specified has none. That
  --    was true for IndiaMART's own mobile field and is kept
  --    byte-identical here rather than silently dropped or silently
  --    kept without comment — but it is a real, inherited assumption
  --    ("a source's phone number doubles as its WhatsApp number") that
  --    will not hold for every future source, and is flagged here for
  --    whoever adds one where it does not.
  insert into public.leads (
    customer_id, company, contact_name, email, phone, whatsapp_phone,
    address, stage_id, owner_id, source, external_source_id, notes,
    deal_value, status
  ) values (
    v_integration.customer_id,
    v_company,
    v_contact,
    v_email,
    v_phone,
    v_phone,
    v_address,
    v_stage_id,
    v_owner_id,
    v_integration.source,
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
revoke all on function public.ingest_lead(
  text, text, text, text, text, text, text, text, text
) from public;
grant execute on function public.ingest_lead(
  text, text, text, text, text, text, text, text, text
) to anon, authenticated;

commit;
