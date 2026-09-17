-- ---------------------------------------------------------------------
-- search_meeting_notes() — server-side search for the Recent Notes list.
--
-- WHY AN RPC AND NOT A POSTGREST QUERY: the list has to be searchable by
-- ATTENDEE NAME, and attendees is a text[]. PostgREST's .or() filter DSL
-- can express `title.ilike.*term*` and `summary.ilike.*term*`, but for an
-- array it only offers `cs` (contains), which is an EXACT element match —
-- so "Kiran" would never find "Kiran Pande". There is no cast operator in
-- the filter language to reach array_to_string().
--
-- The alternative was a generated/trigger-maintained search column. That
-- was rejected: a GENERATED column requires an IMMUTABLE expression and
-- array_to_string()'s volatility is not something to bet a migration on
-- without being able to run it first, and a trigger-maintained column
-- means a second copy of the searchable text that can drift from the
-- source columns.
--
-- SECURITY INVOKER (the default — deliberately NOT definer), exactly like
-- the four forecast aggregates. public.meeting_notes already carries the
-- policy this needs:
--     "hierarchy-aware meeting note visibility"
--        using (is_customer_user_visible(owner_id))
-- Running as the invoker means that policy is evaluated INSIDE this
-- function for the real caller, so:
--   * there is no p_customer_id parameter — nothing to pass, nothing to
--     forge; the tenant is whatever RLS says it is,
--   * ADMIN searches the whole customer, MANAGER/SENIOR_SALES_REP their
--     own branch, SALES_REP only their own notes,
--   * the role-visibility rule stays defined in exactly one place, and
--     it is not here.
-- A SECURITY DEFINER version would have had to re-implement the
-- recursive hierarchy predicate by hand.
--
-- NO TRIGRAM INDEX. An ILIKE '%term%' cannot use a B-tree, so this is a
-- scan — bounded by RLS to one tenant's (and often one person's) notes,
-- which is the same trade getContactsPage's own search already documents
-- and accepts for the same reason. pg_trgm would be the answer if a
-- tenant ever accumulates enough notes for it to matter; enabling an
-- extension is not something to do speculatively.
--
-- Wrapped in a transaction like every prior migration in this project.
-- ---------------------------------------------------------------------

begin;

create or replace function public.search_meeting_notes(
  p_search text default null,
  p_limit integer default 10,
  p_offset integer default 0
)
returns table (
  id uuid,
  customer_id uuid,
  owner_id uuid,
  lead_id uuid,
  title text,
  meeting_date date,
  attendees text[],
  summary text,
  source_kind text,
  raw_source text,
  model_used text,
  status text,
  created_by uuid,
  created_at timestamptz,
  updated_at timestamptz,
  -- The number of notes matching the search BEFORE limit/offset, so the
  -- caller gets the page and its total in one round trip instead of
  -- issuing a second count query that could disagree with it.
  total_count bigint
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_pattern text;
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  -- NULL pattern means "no search" — every Active note the caller can
  -- see. nullif() collapses '' and whitespace into that same case, so
  -- an empty search box is not a search for the empty string.
  --
  -- % and _ in the user's own term are ESCAPED rather than treated as
  -- wildcards: someone searching for "50%" means the literal characters,
  -- and an unescaped "%" would silently match every note. The backslash
  -- is escaped first, otherwise escaping the other two would corrupt it.
  v_pattern := case
    when nullif(btrim(coalesce(p_search, '')), '') is null then null
    else '%' || replace(replace(replace(btrim(p_search), '\', '\'), '%', '\%'), '_', '\_') || '%'
  end;

  return query
  with matching as (
    select mn.*
    from public.meeting_notes mn
    where mn.status = 'Active'
      and (
        v_pattern is null
        or mn.title ilike v_pattern escape '\'
        or mn.summary ilike v_pattern escape '\'
        -- The reason this function exists: the array flattened to text
        -- so a partial name matches one attendee among several.
        or array_to_string(mn.attendees, ' ') ilike v_pattern escape '\'
      )
  )
  select
    m.id, m.customer_id, m.owner_id, m.lead_id, m.title, m.meeting_date,
    m.attendees, m.summary, m.source_kind, m.raw_source, m.model_used,
    m.status, m.created_by, m.created_at, m.updated_at,
    -- Window function: computed over every matching row, before
    -- LIMIT/OFFSET are applied, which is exactly the total needed.
    count(*) over () as total_count
  from matching m
  order by m.created_at desc
  limit v_limit
  offset v_offset;
end;
$$;

revoke all on function public.search_meeting_notes(text, integer, integer) from public, anon;
grant execute on function public.search_meeting_notes(text, integer, integer) to authenticated;

commit;
