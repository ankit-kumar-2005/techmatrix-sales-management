import type { SupabaseClient } from "@supabase/supabase-js";
import type { Contact } from "@/types/contact";

export type ContactsPageParams = {
  /** Matches against name, company, email, phone, or title — "" means no
   *  search filter. */
  search: string;
  /** Exact match against lead_id — "" means every lead. Combines with
   *  `search` via AND (never OR): "Search=Ravi, Lead=ABC" means Ravi
   *  contacts belonging to ABC, not either condition alone. */
  leadId: string;
  page: number;
  pageSize: number;
};

export type ContactsPage = {
  contacts: Contact[];
  /** Total rows matching the current search (not just this page) — from
   *  the same `{ count: "exact" }` request as the row fetch, what the
   *  page's own result count and Previous/Next disabled states are
   *  computed from. */
  totalCount: number;
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
 */
export async function getContactsPage(
  supabase: SupabaseClient,
  customerId: string,
  params: ContactsPageParams,
): Promise<ContactsPage> {
  const { search, leadId, page, pageSize } = params;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let query = supabase.from("contacts").select("*", { count: "exact" }).eq("customer_id", customerId);

  if (leadId) {
    query = query.eq("lead_id", leadId);
  }

  const safeSearch = toSafeOrSearchTerm(search);
  if (safeSearch) {
    query = query.or(
      [
        `name.ilike.%${safeSearch}%`,
        `company.ilike.%${safeSearch}%`,
        `email.ilike.%${safeSearch}%`,
        `phone.ilike.%${safeSearch}%`,
        `title.ilike.%${safeSearch}%`,
      ].join(","),
    );
  }

  const { data, error, count } = await query.order("created_at", { ascending: false }).range(from, to);

  if (error || !data) {
    return { contacts: [], totalCount: 0 };
  }

  return { contacts: data as Contact[], totalCount: count ?? 0 };
}

const DUPLICATE_CANDIDATE_LIMIT = 300;

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
export async function getDuplicateCandidates(supabase: SupabaseClient, customerId: string): Promise<Contact[]> {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(DUPLICATE_CANDIDATE_LIMIT);

  if (error || !data) {
    return [];
  }

  return data as Contact[];
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
