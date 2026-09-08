-- Adds a person's name to customers (the signup requester / "Client
-- Name") and customer_users (the individual member's own name), and one
-- narrow new function needed for a friendlier login error message.
--
-- Design notes:
--   * customers.name is the NAME COLLECTED AT SIGNUP — the person who
--     created this customer, displayed later as "Client Name" in Company
--     Information. customer_users.name is that SAME name, copied onto
--     the ADMIN membership row create_customer_with_admin() creates for
--     that same person — the two are intentionally duplicated once, at
--     creation time, not kept in permanent sync by a trigger, because
--     they answer different questions going forward: customers.name is
--     "who originally registered this company" (stays fixed), while
--     customer_users.name is "this particular member's own name" (a
--     future per-member-editable field, once that's built — out of
--     scope here). This mirrors how company_name/email already work:
--     each table owns its own copy of data that happened to originate
--     from the same signup moment.
--   * NULLABLE, not NOT NULL, on both columns. customers and
--     customer_users already have rows from before this feature existed
--     (every customer created by create_customer_with_admin() prior to
--     this migration), and this environment has no live connection to
--     the actual Supabase project to inspect or backfill that data — so
--     a NOT NULL constraint here would be a guess that could break an
--     existing deployment outright. Application code (the signup Zod
--     schema, and create_customer_with_admin() below) makes `name`
--     effectively required for every NEW row from this point forward;
--     a later migration can safely add NOT NULL once real data is
--     confirmed backfilled. A CHECK constraint still rules out the one
--     thing that's always wrong regardless of backfill state: a
--     non-null value that's blank/whitespace-only — same pattern
--     customer_lead_stages.stage already uses.
--   * create_customer_with_admin() gains a 9th parameter, p_name text
--     default null. This CANNOT be done with a bare CREATE OR REPLACE
--     the way the stage-seeding migration (20260907120000) redefined
--     this same function — that prior replace kept the identical
--     8-parameter signature and only changed the body, which is exactly
--     the case CREATE OR REPLACE supports. PostgreSQL identifies a
--     function by name + input parameter TYPE LIST, and that list's
--     length is part of the identity regardless of which parameters
--     have defaults — an 8-arg and a 9-arg declaration are different
--     signatures no matter how similar they look. A bare CREATE OR
--     REPLACE with a 9th parameter would therefore NOT replace the
--     existing 8-arg function; it would silently create a SECOND,
--     overloaded function alongside the untouched original — and any
--     RPC call omitting p_name (naming only p_email/p_phone/
--     p_company_name, as every call before this feature did) would then
--     be ambiguous between the two, since both satisfy "every omitted
--     parameter has a default." Supabase's PostgREST .rpc() always
--     calls by parameter name, which is exactly what makes this
--     ambiguity reachable in practice, not just a theoretical corner
--     case. So instead: DROP FUNCTION targeting the exact original
--     8-arg signature (verified via pg_depend beforehand — see this
--     migration's own validation queries — that nothing else in the
--     database references it: no trigger, view, or RLS policy calls
--     create_customer_with_admin; its only caller is SetPasswordForm's
--     supabase.rpc(...)), then CREATE FUNCTION with the new 9-arg
--     signature. This leaves exactly one function in the catalog
--     afterward, eliminating the overload/ambiguity risk entirely
--     rather than accepting it. Its own "already belongs to a customer"
--     exception text is preserved verbatim: SetPasswordForm string-
--     matches on that exact phrase to treat a retried/refreshed signup
--     completion as success rather than an error. DROP removes the
--     function's existing grant along with it (grants attach to the
--     specific catalog object) — the grant to `authenticated` is
--     reissued explicitly below, identical to what the original had.
--   * auth_email_has_account(): a new, narrow SECURITY DEFINER function
--     so the login page can tell "no account with this email" apart
--     from "wrong password for an existing account" — boolean return
--     only, same shape as is_customer_member/is_customer_admin. WORTH
--     CALLING OUT EXPLICITLY: this is a deliberate, narrow exception to
--     this project's otherwise consistent anti-enumeration stance (see
--     ForgotPasswordForm's own comment on why Supabase's password-reset
--     flow deliberately never reveals this). It is granted to `anon` —
--     the first function in this project granted to that role — because
--     the check must run before a session exists. Checks auth.users
--     directly (not customer_users), because a user who signed up but
--     hasn't verified their email yet has no customer_users row at all,
--     and telling THAT person "we couldn't find an account, please sign
--     up" would be actively wrong and misleading.
--
-- Wrapped in a transaction like every prior migration in this project.

begin;

alter table public.customers
  add column name text,
  add constraint customers_name_not_blank check (name is null or btrim(name) <> '');

alter table public.customer_users
  add column name text,
  add constraint customer_users_name_not_blank check (name is null or btrim(name) <> '');

-- Explicit signature-qualified DROP, not relying on CREATE OR REPLACE
-- alone — see the design notes above for why a 9th parameter can't be
-- added that way. IF EXISTS + the exact original 8-arg type list means
-- this only ever removes that one, specific, already-verified-
-- unreferenced function — never a different overload. On a first run
-- this drops the old 8-arg function; on a re-run (the migration already
-- applied successfully once) this is a safe no-op, since by then no
-- function with that 8-arg signature exists any more — the CREATE OR
-- REPLACE below is what makes a re-run safe overall, matching the
-- 9-arg signature that already exists at that point instead of erroring.
drop function if exists public.create_customer_with_admin(
  text, text, text, text, text, text, text, text
);

create or replace function public.create_customer_with_admin(
  p_email text,
  p_phone text,
  p_company_name text default null,
  p_website text default null,
  p_address text default null,
  p_city text default null,
  p_state text default null,
  p_country text default null,
  p_name text default null
)
returns public.customers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid := auth.uid();
  v_admin_role_id uuid;
  v_customer public.customers;
begin
  if v_user_id is null then
    raise exception 'Not authenticated';
  end if;

  if exists (select 1 from public.customer_users where user_id = v_user_id) then
    raise exception 'User already belongs to a customer';
  end if;

  select id into v_admin_role_id from public.roles where name = 'ADMIN';
  if v_admin_role_id is null then
    raise exception 'ADMIN role is not configured';
  end if;

  insert into public.customers (name, company_name, email, phone, created_by, website, address, city, state, country)
  values (p_name, p_company_name, p_email, p_phone, v_user_id, p_website, p_address, p_city, p_state, p_country)
  returning * into v_customer;

  insert into public.customer_users (customer_id, user_id, role_id, name, status)
  values (v_customer.id, v_user_id, v_admin_role_id, p_name, 'Active');

  insert into public.customer_lead_stages (customer_id, stage, display_order, status, is_closed)
  values
    (v_customer.id, 'New', 1, 'Active', false),
    (v_customer.id, 'Contacted', 2, 'Active', false),
    (v_customer.id, 'Qualified', 3, 'Active', false),
    (v_customer.id, 'Proposal', 4, 'Active', false),
    (v_customer.id, 'Won', 5, 'Active', true),
    (v_customer.id, 'Lost', 6, 'Active', true);

  return v_customer;
end;
$$;

-- DROP removed the previous grant along with the old function object —
-- reissued here, identical to the original migration's grant (execute
-- for authenticated only; anon and public get nothing). Explicit type
-- list, matching the new 9-arg signature exactly, so this can never be
-- misapplied to a different overload even if one existed.
revoke all on function public.create_customer_with_admin(
  text, text, text, text, text, text, text, text, text
) from public;
grant execute on function public.create_customer_with_admin(
  text, text, text, text, text, text, text, text, text
) to authenticated;

-- stable, not immutable: its result depends on the live contents of
-- auth.users, which changes over time (immutable would incorrectly
-- claim the result never changes for a given input, regardless of
-- database state). Normalizes both sides (lower + btrim) so a stray
-- space or case difference can't produce a false negative. Null/blank
-- input is guarded explicitly rather than left to fall through to
-- exists() returning false implicitly — same outcome, but this makes
-- "no unnecessary lookup for obviously-invalid input" an explicit,
-- readable part of the function rather than an accident of NULL
-- comparison semantics. No exception path exists to leak a raw DB
-- error to the frontend — a single guarded boolean expression, nothing
-- else this function can do but return true or false.
create or replace function public.auth_email_has_account(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    p_email is not null
    and btrim(p_email) <> ''
    and exists (
      select 1 from auth.users where lower(btrim(email)) = lower(btrim(p_email))
    );
$$;

revoke all on function public.auth_email_has_account from public;
grant execute on function public.auth_email_has_account to anon, authenticated;

commit;
