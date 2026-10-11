-- ---------------------------------------------------------------------
-- MCP: restrict what an OAuth-client token can do directly through the
-- Supabase Data API (PostgREST).
--
-- Requires 20261010120000_mcp_platform.sql (customer_mcp_settings).
--
-- THE PROBLEM. An access token issued by Supabase's OAuth 2.1 server to
-- an AI client (Claude, …) is a normal user JWT. Besides calling
-- /api/mcp, whoever holds it could call PostgREST directly with the
-- public key and do anything that person can do in the app — skipping
-- every MCP-only control ("Allow changes", tool switches, output
-- allowlists, rate limit, session check, audit). For an admin that
-- includes turning "Allow changes" on, reading integration webhook
-- tokens, and creating automations.
--
-- HOW AN OAUTH-CLIENT TOKEN IS RECOGNISED. Supabase documents that OAuth
-- access tokens carry a `client_id` claim and recommends exactly this
-- test in RLS: (auth.jwt() ->> 'client_id') is not null
-- (docs: Auth → OAuth 2.1 Server → Token Security and Row Level
-- Security). PostgREST verifies the JWT signature before exposing its
-- claims as request.jwt.claims, so the claim cannot be forged or added by
-- the caller. Ordinary app sessions (password, magic link, signup) have
-- no client_id and are completely unaffected by everything below.
--
-- WHAT THIS DOES — additive RESTRICTIVE policies only. A restrictive
-- policy is AND-ed with the existing permissive ones: it can only take
-- access away, never grant it, and only from requests whose token has a
-- client_id. No existing policy, grant, table or function is altered.
--
--   Blocked for OAuth-client tokens (write = insert/update/delete as the
--   table allows today):
--     customer_mcp_settings, customer_mcp_tools, mcp_user_blocks
--     customer_integrations (and SELECT — webhook tokens),
--     customer_integration_participants
--     customer_automations, customer_automation_versions
--     customer_user_invitations
--     customers (company details)
--     customer_lead_stages, customer_catalog_items
--     meeting_notes, meeting_note_action_items
--     contact_duplicate_dismissals
--     mcp_connections INSERT (connections are created only by the
--       consent screen, which uses the browser session)
--
--   Allowed for OAuth-client tokens ONLY when the company has AI
--   connections on AND "Allow changes" on:
--     leads, tasks, contacts — INSERT and UPDATE (still subject to every
--     existing permissive policy and trigger, i.e. the person's own
--     permissions)
--
--   Deliberately NOT restricted (the MCP server itself needs them with
--   the person's OAuth token): reads of leads/tasks/contacts/stages/team
--   and forecast functions; mcp_audit_log INSERT; mcp_idempotency_keys
--   INSERT/UPDATE; mcp_connections UPDATE (last use, disconnect).
--
-- WHAT IS NOT AFFECTED: SECURITY DEFINER functions owned by the table
-- owner (the automation worker, Lead Capture ingest_lead, the
-- automation-event triggers on leads/tasks/contacts, get_my_mcp_context)
-- bypass RLS as before — none of these tables uses FORCE ROW LEVEL
-- SECURITY. anon is unaffected (it has no access to these tables).
--
-- WHAT IT CANNOT DO: with "Allow changes" on, a direct Data API write to
-- leads/tasks/contacts is still not limited to the enabled MCP tools or
-- to the fields an MCP tool would send; only the person's normal RLS and
-- triggers apply. Reads remain possible for everything the person can
-- read in the app except customer_integrations. See docs/mcp.md.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------

-- Is the current request authenticated with an OAuth-client token?
-- SECURITY INVOKER: it only reads the request's own verified claims.
create or replace function public.mcp_request_is_oauth_client()
returns boolean
language sql
stable
set search_path = public
as $$
  select nullif(auth.jwt() ->> 'client_id', '') is not null;
$$;

-- May an OAuth-client token write leads/tasks/contacts in this company?
-- Only if the caller is an active member of it and the company has AI
-- connections AND "Allow changes" on. SECURITY DEFINER because
-- customer_mcp_settings is admin-only; it answers false for any company
-- the caller does not belong to, so it discloses nothing about others.
create or replace function public.mcp_oauth_writes_allowed(target_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_customer_member(target_customer_id)
     and exists (
       select 1
       from public.customer_mcp_settings s
       where s.customer_id = target_customer_id
         and s.enabled
         and s.allow_writes
     );
$$;

revoke all on function public.mcp_request_is_oauth_client() from public, anon;
grant execute on function public.mcp_request_is_oauth_client() to authenticated;

revoke all on function public.mcp_oauth_writes_allowed(uuid) from public, anon;
grant execute on function public.mcp_oauth_writes_allowed(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Blocked for OAuth-client tokens. `(select …)` lets Postgres evaluate
-- the claim test once per statement instead of once per row.
-- ---------------------------------------------------------------------

-- MCP configuration
create policy "oauth clients cannot create MCP settings" on public.customer_mcp_settings
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change MCP settings" on public.customer_mcp_settings
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

create policy "oauth clients cannot create MCP tool switches" on public.customer_mcp_tools
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change MCP tool switches" on public.customer_mcp_tools
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

create policy "oauth clients cannot block people" on public.mcp_user_blocks
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot unblock people" on public.mcp_user_blocks
  as restrictive for delete to authenticated
  using (not (select public.mcp_request_is_oauth_client()));

create policy "oauth clients cannot register AI connections" on public.mcp_connections
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));

-- Integrations (webhook credentials)
create policy "oauth clients cannot read integrations" on public.customer_integrations
  as restrictive for select to authenticated
  using (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot create integrations" on public.customer_integrations
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change integrations" on public.customer_integrations
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

create policy "oauth clients cannot add integration participants" on public.customer_integration_participants
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot remove integration participants" on public.customer_integration_participants
  as restrictive for delete to authenticated
  using (not (select public.mcp_request_is_oauth_client()));

-- Automations
create policy "oauth clients cannot create automations" on public.customer_automations
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change automations" on public.customer_automations
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

create policy "oauth clients cannot create automation versions" on public.customer_automation_versions
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));

-- Invitations
create policy "oauth clients cannot create invitations" on public.customer_user_invitations
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change invitations" on public.customer_user_invitations
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

-- Company details
create policy "oauth clients cannot change company details" on public.customers
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

-- Lead stages and catalog
create policy "oauth clients cannot create lead stages" on public.customer_lead_stages
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change lead stages" on public.customer_lead_stages
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

create policy "oauth clients cannot create catalog items" on public.customer_catalog_items
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change catalog items" on public.customer_catalog_items
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

-- Meeting notes and duplicate dismissals (no MCP tool writes these)
create policy "oauth clients cannot create meeting notes" on public.meeting_notes
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change meeting notes" on public.meeting_notes
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

create policy "oauth clients cannot create meeting note action items" on public.meeting_note_action_items
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));
create policy "oauth clients cannot change meeting note action items" on public.meeting_note_action_items
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()))
  with check (not (select public.mcp_request_is_oauth_client()));

create policy "oauth clients cannot dismiss duplicate contacts" on public.contact_duplicate_dismissals
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()));

-- ---------------------------------------------------------------------
-- Leads, tasks, contacts: OAuth-client writes only with "Allow changes".
-- The existing permissive policies and triggers still decide everything
-- else (ownership, hierarchy, closed-lead lock, identity columns).
-- ---------------------------------------------------------------------

create policy "oauth clients write leads only when changes are allowed" on public.leads
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id));
create policy "oauth clients update leads only when changes are allowed" on public.leads
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id))
  with check (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id));

create policy "oauth clients write tasks only when changes are allowed" on public.tasks
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id));
create policy "oauth clients update tasks only when changes are allowed" on public.tasks
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id))
  with check (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id));

create policy "oauth clients write contacts only when changes are allowed" on public.contacts
  as restrictive for insert to authenticated
  with check (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id));
create policy "oauth clients update contacts only when changes are allowed" on public.contacts
  as restrictive for update to authenticated
  using (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id))
  with check (not (select public.mcp_request_is_oauth_client()) or public.mcp_oauth_writes_allowed(customer_id));

commit;
