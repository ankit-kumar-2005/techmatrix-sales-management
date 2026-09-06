-- Make customers.email immutable after creation.
--
-- Business rule: the email collected at signup (create_customer_with_admin,
-- in 20260904140000_customers_and_customer_users.sql) must never change
-- afterward. This is enforced with a BEFORE UPDATE trigger on
-- public.customers, not just in the UI — a direct REST/SQL update, not
-- only the Company Information form, is blocked too.
--
-- Design notes:
--   * BEFORE UPDATE only (not INSERT) — on INSERT there is no OLD row to
--     compare against, and email must still be settable at creation time
--     via create_customer_with_admin exactly as today.
--   * `NEW.email IS DISTINCT FROM OLD.email` (not `!=`) so this correctly
--     rejects any actual change while never misfiring on NULL — email is
--     NOT NULL on this table already, but IS DISTINCT FROM is the
--     correct comparison for this kind of guard regardless.
--   * Not SECURITY DEFINER — this trigger only compares two column
--     values on the row already being written and raises; it needs no
--     elevated privilege and should keep running as whichever role
--     performs the UPDATE, same as customers_set_updated_at above it.
--   * No RLS policy changes — this is a stricter, independent guard that
--     applies underneath RLS, the same way a CHECK constraint would;
--     the existing "admins can update their customer" policy still
--     decides *who* may update the row, this trigger decides *which
--     column values* an update may result in.
--   * Trigger name (customers_prevent_email_change) alphabetically
--     precedes customers_set_updated_at from the earlier migration, but
--     the two don't interact (one only touches updated_at, the other
--     only inspects email), so their relative firing order doesn't
--     matter for correctness here.
--
-- Wrapped in a transaction like the original migration: fails atomically
-- rather than leaving the trigger half-created.

begin;

create or replace function public.prevent_customer_email_change()
returns trigger
language plpgsql
as $$
begin
  if new.email is distinct from old.email then
    raise exception 'Customer email cannot be changed.';
  end if;
  return new;
end;
$$;

create trigger customers_prevent_email_change
  before update on public.customers
  for each row
  execute function public.prevent_customer_email_change();

commit;
