-- ---------------------------------------------------------------------
-- PRE-MIGRATION CLEANUP — invitation feature only.
--
-- Removes every database object created by:
--   20260914120000_customer_user_invitations.sql
--   20260914130000_accept_customer_user_invitation.sql
--   20260914140000_pending_invitation_lookup.sql
--   20260914150000_invitation_context.sql
-- so that 20260914170000 can recreate the feature as one clean unit.
--
-- ⚠ THIS DESTROYS INVITATION DATA. ⚠
-- Dropping public.customer_user_invitations deletes every invitation row
-- — PENDING, ACCEPTED, CANCELLED and EXPIRED alike. The feature's own
-- rule that "invitation history is retained" refers to normal operation
-- (there is no DELETE policy and no DELETE grant); it cannot survive the
-- table itself being dropped. If this database holds invitations you
-- care about, take the backup below FIRST and restore afterwards.
-- On a database whose invitations are only test rows, no backup is
-- needed.
--
-- OPTIONAL BACKUP — run as a SEPARATE statement BEFORE this migration,
-- not inside it (a backup table that this transaction creates would be
-- rolled back with it if anything failed):
--
--   create table public.customer_user_invitations_backup_20260914 as
--     select * from public.customer_user_invitations;
--
-- After 20260914170000 has been applied you can re-insert from it, then
-- drop the backup table. Note the recreated table's triggers and
-- constraints all apply to those inserts.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH — these are SHARED project
-- objects that the invitation migrations only USED, never created:
--   public.set_updated_at()          (20260904140000)
--   public.is_customer_admin(uuid)   (20260904140000)
--   public.customers, public.customer_users, public.roles, auth.users
-- Dropping any of them would break customers, leads, tasks, contacts and
-- catalog. Nothing below references them except by leaving them alone.
--
-- Grants and revokes are not undone explicitly: privileges live ON an
-- object, so dropping the table and the functions removes their ACLs
-- with them. A REVOKE on an object that no longer exists would only
-- error.
--
-- Every statement is IF EXISTS, so this is safe to run when some objects
-- are already absent — notably 20260914150000, which may never have been
-- applied.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- 1. FUNCTIONS THAT DEPEND ON THE TABLE — dropped first.
--
-- Order matters for exactly one of these:
-- get_pending_invitation_for_current_user is `language sql`, whose body
-- PostgreSQL parses and records a real catalog dependency for. Dropping
-- the table while it exists would either fail or force a CASCADE that
-- silently takes the function with it. The two plpgsql functions have no
-- such dependency (their bodies are not resolved until runtime), but
-- they are dropped here too so the ordering reads as one deliberate
-- sequence rather than a coincidence.
--
-- Exact signatures on every DROP — never a bare name — so an unrelated
-- overload could not be removed by accident.
-- ---------------------------------------------------------------------

drop function if exists public.get_invitation_context(uuid);
drop function if exists public.get_pending_invitation_for_current_user();
drop function if exists public.accept_customer_user_invitation(uuid);

-- ---------------------------------------------------------------------
-- 2. POLICIES.
--
-- Dropping the table would remove these anyway; naming them explicitly
-- keeps this file a readable inventory of what the four migrations
-- created, and makes it work even if a future edit stops short of
-- dropping the table.
-- ---------------------------------------------------------------------

drop policy if exists "admins can view their customer's invitations"
  on public.customer_user_invitations;
drop policy if exists "admins can create invitations for their customer"
  on public.customer_user_invitations;
drop policy if exists "admins can update their customer's invitations"
  on public.customer_user_invitations;

-- ---------------------------------------------------------------------
-- 3. TRIGGERS — before the functions they execute (section 5).
--
-- customer_user_invitations_set_updated_at is dropped, but NOT the
-- shared public.set_updated_at() function it calls: that same function
-- backs the updated_at trigger on customers, customer_users, leads,
-- tasks, contacts and catalog.
-- ---------------------------------------------------------------------

drop trigger if exists customer_user_invitations_validate
  on public.customer_user_invitations;
drop trigger if exists customer_user_invitations_protect_identity_columns
  on public.customer_user_invitations;
drop trigger if exists customer_user_invitations_set_updated_at
  on public.customer_user_invitations;

-- ---------------------------------------------------------------------
-- 4. INDEXES.
--
-- All six belong to the invitation table and go with it; listed for the
-- same inventory reason as the policies above. The primary key
-- (customer_user_invitations_pkey) and the two composite foreign keys
-- into customer_users are constraints, not standalone indexes, and are
-- removed by the table drop.
-- ---------------------------------------------------------------------

drop index if exists public.customer_user_invitations_unique_pending_email_per_customer;
drop index if exists public.customer_user_invitations_customer_invited_at_idx;
drop index if exists public.customer_user_invitations_role_id_idx;
drop index if exists public.customer_user_invitations_manager_id_idx;
drop index if exists public.customer_user_invitations_invited_by_idx;
drop index if exists public.customer_user_invitations_accepted_membership_idx;

-- ---------------------------------------------------------------------
-- 5. THE TABLE, then its trigger functions.
--
-- No CASCADE: by this point nothing is left depending on the table, so a
-- plain DROP is correct AND is the safer choice — if some object this
-- audit did not anticipate still referenced the table, this errors and
-- rolls the whole migration back rather than silently destroying it.
--
-- The two trigger functions are invitation-specific (they name
-- customer_user_invitations columns and raise invitation-specific
-- messages) and have no other caller, so they go too.
-- ---------------------------------------------------------------------

drop table if exists public.customer_user_invitations;

drop function if exists public.validate_customer_user_invitation();
drop function if exists public.protect_customer_user_invitation_identity_columns();

commit;
