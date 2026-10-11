-- ---------------------------------------------------------------------
-- MCP platform: company AI-connection settings, person blocks,
-- connections, audit log, idempotency reservations.
--
-- WHAT THIS ADDS (additive only — no existing table, policy or function
-- is altered)
--   * customer_mcp_settings    one row per customer: is "AI connections"
--                              on, and are changes ("writes") allowed.
--   * customer_mcp_tools       per-customer overrides of the code
--                              registry's default on/off per tool.
--   * mcp_user_blocks          admin blocks, PER PERSON — possible before
--                              the person ever connects.
--   * mcp_connections          one row per (person, OAuth client) the
--                              person approved on the consent page, with
--                              the person's own one-way disconnect flag.
--   * mcp_audit_log            insert-only activity log of every tool
--                              call: ids and parameter NAMES only.
--   * mcp_idempotency_keys     atomic reservations so a retried create
--                              produces one record, not two.
--   * get_my_mcp_context()     the caller's OWN company configuration in
--                              one round trip, for the MCP server and the
--                              consent screen.
--
-- DESIGN NOTES
--
-- 1. THE MCP SERVER HOLDS ONLY THE USER'S OWN TOKEN. Every read and
--    write below happens as the signed-in person through PostgREST, so
--    RLS here is the real boundary. There is no service-role path, and
--    nothing in this migration grants anything to anon.
--
--    CONSEQUENCE, STATED ONCE: anything the MCP server writes with the
--    person's token, the person could also write directly with that same
--    token. The policies and triggers below therefore make sure a person
--    can only ever affect THEIR OWN rows, and that the rows that matter
--    for security (blocks, disconnects) only move in the safe direction.
--
-- 2. WHY get_my_mcp_context() IS SECURITY DEFINER. customer_mcp_settings,
--    customer_mcp_tools and mcp_user_blocks are admin-only (precedent:
--    customer_integrations), but a Sales Rep's MCP call still has to know
--    whether their company turned the feature on and whether they are
--    blocked. The function answers exactly that for the caller's OWN
--    active membership (resolved from auth.uid(), never from an argument)
--    and cannot be pointed at another person or customer. Its one
--    argument only selects which of the caller's OWN connection rows to
--    report on.
--
-- 3. BLOCKING IS PER PERSON, in its own table. Claude registers a NEW
--    OAuth client on every fresh connection (Dynamic Client
--    Registration), so a block on connection rows alone could be
--    sidestepped by reconnecting — and could not be placed before the
--    first connection at all. An mcp_user_blocks row stops every MCP
--    request for that person (checked on every request through
--    get_my_mcp_context) and stops them registering any new connection
--    (mcp_connections INSERT policy). Admin-only; blocked_by and
--    created_at are stamped by trigger. Unblocking deletes the row: a
--    block is an access-control switch, not a business record.
--
-- 4. DISCONNECT IS ONE-WAY. revoked_at on mcp_connections can be set by
--    the row's owner and never cleared — not by the owner, not by an
--    admin. A stolen access token can therefore not undo its own
--    disconnect, and since (person, client) is unique, it cannot insert a
--    fresh row for the same client either. Reconnecting means the AI
--    client registering a NEW OAuth client (removing and re-adding the
--    connector), which goes through the consent screen again.
--
-- 5. COLUMN OWNERSHIP ON mcp_connections (trigger, the same
--    protect_*_columns pattern tasks/contacts/invitations use):
--      identity (customer, person, client, created_at)   immutable
--      revoked_at                                        owner, set once
--      last_used_at, client_name, redirect_domain        owner only
--    created_at is stamped at INSERT; last_used_at must start null.
--
-- 6. THE AUDIT LOG IS AN ACTIVITY LOG, NOT SECURITY EVIDENCE.
--    Insert-only, created_at stamped by trigger (no edit, no back-dating),
--    and a row can only ever be attributed to the inserter themselves
--    within their own customer. But per note 1, a person could append
--    rows about THEMSELVES directly. Treat it as tamper-evident for
--    everyone except the actor. It stores tool name, outcome, duration,
--    record ids, allowlisted parameter NAMES and a SHA-256 hash of the
--    idempotency key — never argument values.
--
--    RETAINED WHEN A PERSON IS DELETED: customer_user_id deliberately has
--    no foreign key to customer_users, so deleting a membership or an
--    auth user does not delete their history. The insert policy checks
--    (customer_id, customer_user_id) against the caller's own active
--    membership, so the value is always valid when written. Deleting the
--    whole customer still cascades.
--
--    RETENTION: 90 days (MCP_AUDIT_RETENTION_DAYS in
--    features/mcp/config/limits.ts). Cleanup is an operator task, run as
--    the database owner — see docs/mcp.md, "Audit retention". No
--    authenticated role has UPDATE or DELETE on this table.
--
-- 7. IDEMPOTENCY uses its own table rather than a column on leads/tasks/
--    contacts, so the core tables and the Server Actions that write them
--    are untouched. unique (customer_id, idempotency_key) makes the
--    reservation atomic. A reservation starts 'pending' with no record;
--    the only transitions are pending -> succeeded (the one moment
--    record_id may be set), pending -> failed, failed -> pending; a
--    succeeded reservation never changes. Per note 1 a person could still
--    mark their own reservation succeeded with some id, so the server
--    re-reads that id through RLS before answering a replay.
--
-- 8. NO SECRETS. No column here holds a token, client secret, or any
--    auth material. oauth_client_id is a public identifier; idempotency
--    keys are hashed in the audit log.
--
-- 9. SESSION LIVENESS. Supabase access tokens stay valid until they
--    expire even after sign-out ("Access Tokens of revoked sessions
--    remain valid until their expiry time" — Supabase sign-out docs). Its
--    documented remedy is to check that the token's session_id still has a
--    row in auth.sessions. get_my_mcp_context() does exactly that, plus
--    the time-box (not_after) and an active ban (auth.users.banned_until),
--    inside the one call the MCP server already makes per request, and
--    reports session_state: active | ended | missing_claim | unknown. The
--    MCP server accepts only 'active'. This reads Supabase's own auth
--    tables from a SECURITY DEFINER function (the same privilege this
--    project's get_visible_team_directory uses to read auth.users), and is
--    wrapped so a read problem degrades to 'unknown' — refused by MCP, but
--    never breaking the consent screen or anything else that reads the
--    context. Whether password changes delete OTHER sessions is Supabase's
--    behaviour, not this function's: if the session row is gone, the token
--    is refused; if it is not, it is not.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Is (customer, customer_user) the CALLER'S OWN active membership? Answers
-- only about the caller: for anybody else's ids it is false whether or not
-- they exist, so it discloses nothing.
create or replace function public.mcp_is_own_membership(target_customer_id uuid, target_customer_user_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.customer_users cu
    where cu.id = target_customer_user_id
      and cu.customer_id = target_customer_id
      and cu.user_id = auth.uid()
      and cu.status = 'Active'
  );
$$;

-- ---------------------------------------------------------------------
-- customer_mcp_settings
-- ---------------------------------------------------------------------

create table public.customer_mcp_settings (
  customer_id uuid primary key references public.customers (id) on delete cascade,
  enabled boolean not null default false,
  allow_writes boolean not null default false,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger customer_mcp_settings_set_updated_at
  before update on public.customer_mcp_settings
  for each row execute function public.set_updated_at();

alter table public.customer_mcp_settings enable row level security;

create policy "admins can view their customer's MCP settings"
  on public.customer_mcp_settings for select
  to authenticated
  using (public.is_customer_admin(customer_id));

create policy "admins can create their customer's MCP settings"
  on public.customer_mcp_settings for insert
  to authenticated
  with check (public.is_customer_admin(customer_id));

create policy "admins can update their customer's MCP settings"
  on public.customer_mcp_settings for update
  to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

revoke all on public.customer_mcp_settings from anon, authenticated;
grant select, insert, update on public.customer_mcp_settings to authenticated;

-- ---------------------------------------------------------------------
-- customer_mcp_tools — overrides only. A tool with no row here takes
-- the code registry's default (read tools on, write tools off). Names
-- are validated against the registry by the application; the CHECK
-- only bounds their shape.
-- ---------------------------------------------------------------------

create table public.customer_mcp_tools (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  tool_name text not null check (tool_name ~ '^[a-z][a-z_]{0,62}$'),
  enabled boolean not null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_mcp_tools_unique unique (customer_id, tool_name)
);

create trigger customer_mcp_tools_set_updated_at
  before update on public.customer_mcp_tools
  for each row execute function public.set_updated_at();

alter table public.customer_mcp_tools enable row level security;

create policy "admins can view their customer's MCP tools"
  on public.customer_mcp_tools for select
  to authenticated
  using (public.is_customer_admin(customer_id));

create policy "admins can create their customer's MCP tools"
  on public.customer_mcp_tools for insert
  to authenticated
  with check (public.is_customer_admin(customer_id));

create policy "admins can update their customer's MCP tools"
  on public.customer_mcp_tools for update
  to authenticated
  using (public.is_customer_admin(customer_id))
  with check (public.is_customer_admin(customer_id));

revoke all on public.customer_mcp_tools from anon, authenticated;
grant select, insert, update on public.customer_mcp_tools to authenticated;

-- ---------------------------------------------------------------------
-- mcp_user_blocks — per-person admin block. See design note 3.
-- ---------------------------------------------------------------------

create table public.mcp_user_blocks (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  customer_user_id uuid not null,
  blocked_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),

  constraint mcp_user_blocks_user_fkey
    foreign key (customer_id, customer_user_id)
    references public.customer_users (customer_id, id)
    on delete cascade,

  constraint mcp_user_blocks_unique unique (customer_id, customer_user_id)
);

create index mcp_user_blocks_user_idx on public.mcp_user_blocks (customer_user_id);

create or replace function public.stamp_mcp_user_block()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.blocked_by := auth.uid();
  new.created_at := now();
  return new;
end;
$$;

create trigger mcp_user_blocks_stamp
  before insert on public.mcp_user_blocks
  for each row execute function public.stamp_mcp_user_block();

alter table public.mcp_user_blocks enable row level security;

create policy "admins can view their customer's MCP blocks"
  on public.mcp_user_blocks for select
  to authenticated
  using (public.is_customer_admin(customer_id));

create policy "admins can block people in their customer"
  on public.mcp_user_blocks for insert
  to authenticated
  with check (public.is_customer_admin(customer_id));

create policy "admins can unblock people in their customer"
  on public.mcp_user_blocks for delete
  to authenticated
  using (public.is_customer_admin(customer_id));

revoke all on public.mcp_user_blocks from anon, authenticated;
grant select, insert, delete on public.mcp_user_blocks to authenticated;

-- Is the CALLER blocked? No argument, so it can never be asked about
-- anybody else (a colleague or another customer's member).
create or replace function public.mcp_caller_is_blocked()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.mcp_user_blocks b
    join public.customer_users cu
      on cu.id = b.customer_user_id
     and cu.customer_id = b.customer_id
    where cu.user_id = auth.uid()
      and cu.status = 'Active'
  );
$$;

-- ---------------------------------------------------------------------
-- mcp_connections
-- ---------------------------------------------------------------------

create table public.mcp_connections (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  customer_user_id uuid not null,
  oauth_client_id text not null check (char_length(oauth_client_id) between 1 and 255),
  client_name text not null check (char_length(client_name) between 1 and 200),
  redirect_domain text not null check (char_length(redirect_domain) between 1 and 255),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint mcp_connections_user_fkey
    foreign key (customer_id, customer_user_id)
    references public.customer_users (customer_id, id)
    on delete cascade,

  -- Also what makes a disconnect final for that client: no second row
  -- for the same (person, client) can exist. See design note 4.
  constraint mcp_connections_unique_client unique (customer_user_id, oauth_client_id)
);

create index mcp_connections_customer_idx
  on public.mcp_connections (customer_id, last_used_at desc nulls last);

create trigger mcp_connections_set_updated_at
  before update on public.mcp_connections
  for each row execute function public.set_updated_at();

create or replace function public.stamp_mcp_connection()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger mcp_connections_stamp
  before insert on public.mcp_connections
  for each row execute function public.stamp_mcp_connection();

-- Column ownership. See design notes 4 and 5.
create or replace function public.protect_mcp_connection_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.customer_id is distinct from old.customer_id
     or new.customer_user_id is distinct from old.customer_user_id
     or new.oauth_client_id is distinct from old.oauth_client_id
     or new.created_at is distinct from old.created_at then
    raise exception 'An AI connection''s identity cannot be changed.';
  end if;

  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'A disconnected AI connection cannot be reconnected. Add the connector again.';
  end if;

  if (new.revoked_at is distinct from old.revoked_at
      or new.last_used_at is distinct from old.last_used_at
      or new.client_name is distinct from old.client_name
      or new.redirect_domain is distinct from old.redirect_domain)
     and not public.mcp_is_own_membership(old.customer_id, old.customer_user_id) then
    raise exception 'Only the person who connected can change this AI connection.';
  end if;

  return new;
end;
$$;

create trigger mcp_connections_protect_columns
  before update on public.mcp_connections
  for each row execute function public.protect_mcp_connection_columns();

alter table public.mcp_connections enable row level security;

create policy "people see their own AI connections, admins their customer's"
  on public.mcp_connections for select
  to authenticated
  using (
    public.mcp_is_own_membership(customer_id, customer_user_id)
    or public.is_customer_admin(customer_id)
  );

create policy "people register their own AI connections unless blocked"
  on public.mcp_connections for insert
  to authenticated
  with check (
    public.mcp_is_own_membership(customer_id, customer_user_id)
    and revoked_at is null
    and last_used_at is null
    and not public.mcp_caller_is_blocked()
  );

create policy "people update their own AI connections"
  on public.mcp_connections for update
  to authenticated
  using (public.mcp_is_own_membership(customer_id, customer_user_id))
  with check (public.mcp_is_own_membership(customer_id, customer_user_id));

-- No DELETE: a connection is disconnected, never deleted, so the audit
-- trail keeps something to point at.
revoke all on public.mcp_connections from anon, authenticated;
grant select, insert, update on public.mcp_connections to authenticated;

-- ---------------------------------------------------------------------
-- mcp_audit_log — insert-only activity log. See design note 6.
-- ---------------------------------------------------------------------

create table public.mcp_audit_log (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  -- No foreign key on purpose: the history outlives the membership.
  customer_user_id uuid not null,
  oauth_client_id text not null check (char_length(oauth_client_id) between 1 and 255),
  tool_name text not null check (tool_name ~ '^[a-z][a-z_]{0,62}$'),
  status text not null check (status in ('ok', 'denied', 'invalid', 'error', 'rate_limited')),
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,64}$'),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  record_ids uuid[] not null default '{}' check (cardinality(record_ids) <= 100),
  field_names text[] not null default '{}' check (cardinality(field_names) <= 50),
  idempotency_key_sha256 text check (idempotency_key_sha256 is null or idempotency_key_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);

-- Rate limiting counts one person's recent rows; the admin activity feed
-- reads one customer's newest rows.
create index mcp_audit_log_user_recent_idx
  on public.mcp_audit_log (customer_user_id, created_at desc);
create index mcp_audit_log_customer_recent_idx
  on public.mcp_audit_log (customer_id, created_at desc);

create or replace function public.stamp_mcp_audit_created_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_at := now();
  return new;
end;
$$;

create trigger mcp_audit_log_stamp_created_at
  before insert on public.mcp_audit_log
  for each row execute function public.stamp_mcp_audit_created_at();

alter table public.mcp_audit_log enable row level security;

create policy "people see their own MCP activity, admins their customer's"
  on public.mcp_audit_log for select
  to authenticated
  using (
    public.mcp_is_own_membership(customer_id, customer_user_id)
    or public.is_customer_admin(customer_id)
  );

create policy "people record their own MCP activity"
  on public.mcp_audit_log for insert
  to authenticated
  with check (public.mcp_is_own_membership(customer_id, customer_user_id));

revoke all on public.mcp_audit_log from anon, authenticated;
grant select, insert on public.mcp_audit_log to authenticated;

-- ---------------------------------------------------------------------
-- mcp_idempotency_keys. See design note 7.
-- ---------------------------------------------------------------------

create table public.mcp_idempotency_keys (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  customer_user_id uuid not null,
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 128),
  tool_name text not null check (tool_name ~ '^[a-z][a-z_]{0,62}$'),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  record_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint mcp_idempotency_keys_user_fkey
    foreign key (customer_id, customer_user_id)
    references public.customer_users (customer_id, id)
    on delete cascade,

  constraint mcp_idempotency_keys_unique unique (customer_id, idempotency_key)
);

create trigger mcp_idempotency_keys_set_updated_at
  before update on public.mcp_idempotency_keys
  for each row execute function public.set_updated_at();

create or replace function public.stamp_mcp_idempotency_key()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create trigger mcp_idempotency_keys_stamp
  before insert on public.mcp_idempotency_keys
  for each row execute function public.stamp_mcp_idempotency_key();

create or replace function public.protect_mcp_idempotency_columns()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.customer_id is distinct from old.customer_id
     or new.customer_user_id is distinct from old.customer_user_id
     or new.idempotency_key is distinct from old.idempotency_key
     or new.tool_name is distinct from old.tool_name
     or new.created_at is distinct from old.created_at then
    raise exception 'An idempotency reservation''s identity cannot be changed.';
  end if;

  if new.status = old.status then
    if new.record_id is distinct from old.record_id then
      raise exception 'An idempotency reservation''s result cannot be changed.';
    end if;
    return new;
  end if;

  if old.status = 'pending' and new.status = 'succeeded' then
    return new;
  elsif old.status = 'pending' and new.status = 'failed' and new.record_id is null then
    return new;
  elsif old.status = 'failed' and new.status = 'pending' and new.record_id is null then
    return new;
  end if;

  raise exception 'This idempotency reservation change is not allowed.';
end;
$$;

create trigger mcp_idempotency_keys_protect_columns
  before update on public.mcp_idempotency_keys
  for each row execute function public.protect_mcp_idempotency_columns();

alter table public.mcp_idempotency_keys enable row level security;

create policy "people see their own idempotency reservations"
  on public.mcp_idempotency_keys for select
  to authenticated
  using (public.mcp_is_own_membership(customer_id, customer_user_id));

create policy "people create their own pending idempotency reservations"
  on public.mcp_idempotency_keys for insert
  to authenticated
  with check (
    public.mcp_is_own_membership(customer_id, customer_user_id)
    and status = 'pending'
    and record_id is null
  );

create policy "people update their own idempotency reservations"
  on public.mcp_idempotency_keys for update
  to authenticated
  using (public.mcp_is_own_membership(customer_id, customer_user_id))
  with check (public.mcp_is_own_membership(customer_id, customer_user_id));

revoke all on public.mcp_idempotency_keys from anon, authenticated;
grant select, insert, update on public.mcp_idempotency_keys to authenticated;

-- ---------------------------------------------------------------------
-- get_my_mcp_context(). See design note 2.
-- ---------------------------------------------------------------------

create or replace function public.get_my_mcp_context(p_oauth_client_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer_user_id uuid;
  v_customer_id uuid;
  v_user_name text;
  v_company_name text;
  v_role_name text;
  v_enabled boolean := false;
  v_allow_writes boolean := false;
  v_tools jsonb := '{}'::jsonb;
  v_connection jsonb := null;
  v_session_id text;
  v_session_state text := 'unknown';
begin
  select cu.id, cu.customer_id, cu.name, coalesce(c.company_name, c.name), r.name
    into v_customer_user_id, v_customer_id, v_user_name, v_company_name, v_role_name
  from public.customer_users cu
  join public.roles r on r.id = cu.role_id
  join public.customers c on c.id = cu.customer_id
  where cu.user_id = auth.uid()
    and cu.status = 'Active';

  if v_customer_user_id is null then
    return null;
  end if;

  select s.enabled, s.allow_writes
    into v_enabled, v_allow_writes
  from public.customer_mcp_settings s
  where s.customer_id = v_customer_id;

  select coalesce(jsonb_object_agg(t.tool_name, t.enabled), '{}'::jsonb)
    into v_tools
  from public.customer_mcp_tools t
  where t.customer_id = v_customer_id;

  if p_oauth_client_id is not null then
    select jsonb_build_object(
             'id', mc.id,
             'revoked', mc.revoked_at is not null,
             'last_used_at', mc.last_used_at
           )
      into v_connection
    from public.mcp_connections mc
    where mc.customer_user_id = v_customer_user_id
      and mc.oauth_client_id = p_oauth_client_id;
  end if;

  -- SESSION LIVENESS (design note 9). Is the sign-in this token belongs
  -- to still alive? Supabase's documented check: the token's session_id
  -- must still have a row in auth.sessions (sign-out deletes it), within
  -- its time-box (not_after), and the user must not be banned. Any
  -- problem reading these (e.g. privileges) yields 'unknown', which the
  -- MCP server treats as "not verified" — it fails closed.
  begin
    v_session_id := auth.jwt() ->> 'session_id';
    if exists (
      select 1 from auth.users u
      where u.id = auth.uid()
        and u.banned_until is not null
        and u.banned_until > now()
    ) then
      v_session_state := 'ended';
    elsif v_session_id is null
       or v_session_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      v_session_state := 'missing_claim';
    elsif exists (
      select 1 from auth.sessions s
      where s.id = v_session_id::uuid
        and s.user_id = auth.uid()
        and (s.not_after is null or s.not_after > now())
    ) then
      v_session_state := 'active';
    else
      v_session_state := 'ended';
    end if;
  exception when others then
    v_session_state := 'unknown';
  end;

  return jsonb_build_object(
    'session_state', v_session_state,
    'customer_id', v_customer_id,
    'customer_user_id', v_customer_user_id,
    'user_name', v_user_name,
    'company_name', v_company_name,
    'role', v_role_name,
    'mcp_enabled', coalesce(v_enabled, false),
    'allow_writes', coalesce(v_allow_writes, false),
    'tool_overrides', v_tools,
    'person_blocked', exists (
      select 1 from public.mcp_user_blocks b
      where b.customer_id = v_customer_id
        and b.customer_user_id = v_customer_user_id
    ),
    'connection', v_connection
  );
end;
$$;

revoke all on function public.mcp_is_own_membership(uuid, uuid) from public, anon;
grant execute on function public.mcp_is_own_membership(uuid, uuid) to authenticated;

revoke all on function public.mcp_caller_is_blocked() from public, anon;
grant execute on function public.mcp_caller_is_blocked() to authenticated;

revoke all on function public.get_my_mcp_context(text) from public, anon;
grant execute on function public.get_my_mcp_context(text) to authenticated;

revoke all on function public.protect_mcp_connection_columns() from public, anon, authenticated;
revoke all on function public.protect_mcp_idempotency_columns() from public, anon, authenticated;
revoke all on function public.stamp_mcp_audit_created_at() from public, anon, authenticated;
revoke all on function public.stamp_mcp_connection() from public, anon, authenticated;
revoke all on function public.stamp_mcp_idempotency_key() from public, anon, authenticated;
revoke all on function public.stamp_mcp_user_block() from public, anon, authenticated;

commit;
