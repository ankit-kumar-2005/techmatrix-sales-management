import type { SupabaseClient } from "@supabase/supabase-js";
import { getLeadLabelsByIds, type LeadLabel } from "@/features/leads/lib/get-lead-labels";
import type { Contact } from "@/types/contact";

/** What ContactList/ContactRow/EditContactDialog actually read off a
 *  listed contact — traced consumer by consumer (Phase 3 column
 *  projection), not guessed: the row itself (name, company, title,
 *  email, phone, tags), the Lead badge (lead_id), the Edit action
 *  (owner_id, plus everything the row already needed for its own
 *  defaultValues), and `id` for all of the above. customer_id (filtered
 *  on, never displayed), created_by, created_at, and updated_at
 *  (sorted on, never displayed) are confirmed unused by any consumer and
 *  dropped from the query's own select list below. */
export type ContactListItem = Pick<
  Contact,
  "id" | "lead_id" | "owner_id" | "name" | "company" | "title" | "email" | "phone" | "tags"
>;

export type ContactsPageParams = {
  /** A single unified search — matches if the term appears in the
   *  contact's own name, company, email, phone, or title, OR in the
   *  linked lead's own contact_name/company (see getContactsPage's own
   *  comment for how the latter is resolved). "" means no search
   *  filter. Replaces the former separate exact-lead-id filter
   *  entirely — there is no longer a way to filter by a specific lead
   *  without matching its name/company as text, by design (Contacts
   *  UI-consolidation request). */
  search: string;
  page: number;
  pageSize: number;
};

export type ContactsPage = {
  contacts: ContactListItem[];
  /** Total rows matching the current search (not just this page) — from
   *  the same `{ count: "exact" }` request as the row fetch, what the
   *  page's own result count and Previous/Next disabled states are
   *  computed from. */
  totalCount: number;
  /** Labels for exactly the Leads THIS page's contacts link to (never
   *  the customer's whole Lead table) — what ContactList's row badges,
   *  and EditContactDialog's locked-lead field, resolve `lead_id` into.
   *  Bounded to at most `pageSize` distinct ids. */
  leadLabels: LeadLabel[];
};

// PostgREST's `.or(...)` takes a small filter-expression DSL as a plain
// string; `,` and `(`/`)` are that DSL's own delimiters, so a search term
// containing them is stripped down to spaces first — same reasoning and
// same helper shape as features/tasks/lib/get-tasks.ts's own
// toSafeOrSearchTerm, not a SQL-injection concern (the client still
// parameterizes the final query) but a filter-structure-integrity one.
function toSafeOrSearchTerm(value: string): string {
  return value.replace(/[,()]/g, " ").trim();
}

// Bounds how many matching Leads can feed into the search below — not a
// pagination concern (nothing here is displayed), but the same
// "don't leave a query structurally unbounded" standard this project
// holds every list query to (see .claude/skills/performance-and-security-
// standards). A customer's Lead table is realistically small enough that
// this is a generous ceiling, not a real limit in practice — ordered by
// updated_at so, if a search term is ever generic enough to exceed it,
// the leads that get dropped are the least-recently-active ones, not an
// arbitrary DB-order cutoff.
const SEARCH_MATCHED_LEADS_LIMIT = 200;

/**
 * Server-side only: exactly one page of this customer's Contacts matching
 * the given search — a real `.range(from, to)` request against Postgres,
 * never the full table sliced in JS, the same shape
 * getTasksBucketPage/getCatalogItems already use. RLS ("hierarchy-aware
 * contact visibility") is the enforcing layer for who may see which
 * contacts at all; this adds the search/pagination the Contacts page's
 * toolbar needs. Shared by the page's own initial (server-rendered) fetch
 * and getContactsPageAction's subsequent client-driven re-fetches, so the
 * two can never drift into two different query shapes.
 *
 * SEARCHING THE LINKED LEAD'S NAME/COMPANY: contacts has no column of its
 * own that holds the linked lead's name — lead_id and owner_id are two
 * independent relationships (a Contact's own `company` is its own field,
 * a separate value from its lead's `company`; see the contacts
 * migration's design notes) — so "does this search term match the linked
 * lead" can't be a plain `.ilike()` on this table. Resolved as a small,
 * separate lookup against `leads` (RLS-scoped exactly like any other
 * query — a caller only ever gets back leads they can already see),
 * whose matching ids are folded into the SAME `.or()` as this table's own
 * ilike conditions via `lead_id.in.(...)`. PostgREST can do this in one
 * round trip via an embedded `leads!inner(...)` join with a cross-table
 * `.or()`, but that combination is untested against this specific
 * project (no generated Database types, no live database available while
 * building this) — the two-query approach here reuses the exact
 * `.in("id", ...)` pattern already proven in getLeadLabelsByIds, trading
 * one extra bounded round trip for something already known to work
 * rather than a novel filter this environment can't verify.
 */
export async function getContactsPage(
  supabase: SupabaseClient,
  customerId: string,
  params: ContactsPageParams,
): Promise<ContactsPage> {
  const { search, page, pageSize } = params;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("contacts")
    .select("id, lead_id, owner_id, name, company, title, email, phone, tags", { count: "exact" })
    .eq("customer_id", customerId);

  const safeSearch = toSafeOrSearchTerm(search);
  if (safeSearch) {
    const orConditions = [
      `name.ilike.%${safeSearch}%`,
      `company.ilike.%${safeSearch}%`,
      `email.ilike.%${safeSearch}%`,
      `phone.ilike.%${safeSearch}%`,
      `title.ilike.%${safeSearch}%`,
    ];

    const { data: matchedLeads } = await supabase
      .from("leads")
      .select("id")
      .eq("customer_id", customerId)
      .or(`contact_name.ilike.%${safeSearch}%,company.ilike.%${safeSearch}%`)
      .order("updated_at", { ascending: false })
      .limit(SEARCH_MATCHED_LEADS_LIMIT);

    if (matchedLeads && matchedLeads.length > 0) {
      const leadIds = matchedLeads.map((lead) => lead.id as string);
      orConditions.push(`lead_id.in.(${leadIds.join(",")})`);
    }

    query = query.or(orConditions.join(","));
  }

  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

  if (error || !data) {
    return { contacts: [], totalCount: 0, leadLabels: [] };
  }

  const contacts = data as ContactListItem[];
  // Bounded to THIS page's own contacts (≤ pageSize distinct ids) —
  // never the customer's whole Lead table. Depends on `contacts` above,
  // so it's necessarily sequential after the main query, not something
  // that could join the Promise.all callers of this function already run
  // their other, genuinely independent queries in.
  const leadLabels = await getLeadLabelsByIds(supabase, customerId, contacts.map((contact) => contact.lead_id));

  return { contacts, totalCount: count ?? 0, leadLabels };
}

const DUPLICATE_CANDIDATE_LIMIT = 300;

/** What duplicate-detection.ts's own matching (name/company/title/email/
 *  phone) and the "possible duplicates" panel's own display
 *  (DuplicateContactCard) read off a candidate — traced consumer by
 *  consumer, deliberately narrower than ContactListItem above: this
 *  candidate set has no Lead badge or Edit action, so lead_id and
 *  owner_id aren't needed here even though the LIST page's own
 *  projection needs them. */
export type DuplicateCandidateContact = Pick<Contact, "id" | "name" | "company" | "title" | "email" | "phone">;

/**
 * Server-side only: a BOUNDED, customer-scoped slice of recent contacts
 * to run duplicate detection against — never the full table. RLS still
 * scopes this to the caller's own customer regardless, but the explicit
 * `.eq("customer_id", ...)` + `.limit(...)` here is what keeps this a
 * deliberately small candidate set rather than "fetch everything and
 * filter in JS" (see CLAUDE.md Section O). Most-recently-created first:
 * a genuine near-duplicate is far more likely to be a RECENT double-entry
 * than two contacts created years apart, so capping at the most recent
 * N is a reasonable, explainable tradeoff rather than an arbitrary one.
 */
export async function getDuplicateCandidates(
  supabase: SupabaseClient,
  customerId: string,
): Promise<DuplicateCandidateContact[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("id, name, company, title, email, phone")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(DUPLICATE_CANDIDATE_LIMIT);

  if (error || !data) {
    return [];
  }

  return data as DuplicateCandidateContact[];
}

/** One already-dismissed pair, canonically ordered (a < b) — see the
 *  contact_duplicate_dismissals migration's own design notes. */
export type DismissedPair = { contactIdA: string; contactIdB: string };

export async function getDismissedDuplicatePairs(
  supabase: SupabaseClient,
  customerId: string,
): Promise<DismissedPair[]> {
  const { data, error } = await supabase
    .from("contact_duplicate_dismissals")
    .select("contact_id_a, contact_id_b")
    .eq("customer_id", customerId);

  if (error || !data) {
    return [];
  }

  return data.map((row) => ({ contactIdA: row.contact_id_a as string, contactIdB: row.contact_id_b as string }));
}
