-- Team directory RPC + avatar storage.
--
-- Two independent, narrowly-scoped additions needed for this phase's UI
-- work (Create Lead's owner picker, Profile's manager display, and
-- profile photo upload) — neither weakens RLS; both follow the same
-- SECURITY DEFINER / storage-path patterns already established.
--
-- 1) get_customer_team_directory(): resolves customer_users rows to a
--    display-safe shape (email, role name) for the CALLER's own customer
--    only. auth.users is never exposed directly to clients (it isn't in
--    the exposed schema, and RLS on customer_users has no path to it
--    either) — this is the one narrow, audited door for "who are my
--    teammates," the same shape of exception as is_customer_member /
--    is_customer_admin / create_customer_with_admin in the prior
--    migration. customer_id is derived from the caller's own active
--    membership, never accepted as a parameter, so there is no way to
--    query another customer's roster through this function.
--
-- 2) avatars storage bucket: public read (avatars are non-sensitive,
--    same as any other publicly displayed profile picture), writes
--    restricted to the user's own folder (path convention
--    "<user_id>/<filename>"), enforced by matching the first path
--    segment against auth.uid() — the standard, documented Supabase
--    pattern for per-user upload folders. No new customer_users column:
--    the resulting public URL is stored in the existing
--    auth.users.user_metadata (already how phone/company_name are
--    carried through signup), so no migration is needed for that part.
--
-- Reviewed alongside 20260906120000_lead_hierarchy_and_optional_fields.sql
-- (customer_users_one_active_membership_per_user, added there): the
-- caller-membership lookup below no longer needs LIMIT 1 — with that
-- partial unique index in place, at most one row can ever match
-- "user_id = auth.uid() and status = 'Active'", so LIMIT 1 was never
-- picking among real candidates, only masking that the invariant wasn't
-- enforced yet.
--
-- The "users can update their own avatar" policy below was missing a
-- WITH CHECK clause — a USING-only UPDATE policy governs which existing
-- rows a user may target, but nothing then constrained what the row's
-- new `name` (path) could become, so a user could have renamed/moved
-- their own avatar object into another user's folder. WITH CHECK now
-- re-applies the same own-folder rule to the post-update row.

begin;

create or replace function public.get_customer_team_directory()
returns table (
  customer_user_id uuid,
  user_id uuid,
  email text,
  role_name text,
  manager_id uuid,
  status text
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_customer_id uuid;
begin
  select cu.customer_id into v_customer_id
  from public.customer_users cu
  where cu.user_id = auth.uid()
    and cu.status = 'Active';

  if v_customer_id is null then
    return;
  end if;

  return query
    select cu.id, cu.user_id, u.email::text, r.name, cu.manager_id, cu.status
    from public.customer_users cu
    join auth.users u on u.id = cu.user_id
    join public.roles r on r.id = cu.role_id
    where cu.customer_id = v_customer_id
      and cu.status = 'Active';
end;
$$;

revoke all on function public.get_customer_team_directory from public;
grant execute on function public.get_customer_team_directory to authenticated;

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatar images are publicly accessible"
  on storage.objects for select
  to public
  using (bucket_id = 'avatars');

create policy "users can upload their own avatar"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "users can update their own avatar"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "users can delete their own avatar"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

commit;
