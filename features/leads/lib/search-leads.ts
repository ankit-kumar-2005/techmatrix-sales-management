import type { SupabaseClient } from "@supabase/supabase-js";

const MAX_RESULTS = 50;

/** Just enough of a Lead for LeadSearchSelect's own dropdown row (name,
 *  company, email, phone) plus the id it actually submits — never the
 *  full 17-column Lead row a picker has no use for. */
export type LeadSearchResult = {
  id: string;
  contact_name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
};

// PostgREST's `.or(...)` takes a small filter-expression DSL as a plain
// string; `,` and `(`/`)` are that DSL's own delimiters, so a search term
// containing them is stripped down to spaces first — the same helper
// shape (deliberately re-declared here rather than imported) that
// features/contacts/lib/get-contacts.ts's and features/tasks/lib/
// get-tasks.ts's own toSafeOrSearchTerm already use, not a SQL-injection
// concern (the client still parameterizes the final query) but a
// filter-structure-integrity one.
function toSafeOrSearchTerm(value: string): string {
  return value.replace(/[,()]/g, " ").trim();
}

/**
 * Server-side only: up to MAX_RESULTS Leads matching `query` against
 * contact_name/company/email/phone — a real, bounded, customer-scoped
 * query, replacing LeadSearchSelect's previous "filter the customer's
 * entire Lead list in memory" approach. RLS ("hierarchy-aware lead
 * visibility") is still the enforcing layer for who may see which leads
 * at all; this adds the search/limit/ordering LeadSearchSelect's own
 * dropdown needs.
 *
 * An empty `query` (the picker's "show something on focus before the
 * user types" case) returns the most recently updated leads instead of
 * applying no filter at all — the same "no search filter" semantics
 * getContactsPage/getCatalogItemsPage already use for their own empty-
 * search case, and the same ordering getLeadsForCustomer already applies
 * to its full-table fetch, just bounded here to MAX_RESULTS.
 */
export async function searchLeadsForPicker(
  supabase: SupabaseClient,
  customerId: string,
  query: string,
): Promise<LeadSearchResult[]> {
  let builder = supabase
    .from("leads")
    .select("id, contact_name, company, email, phone")
    .eq("customer_id", customerId);

  const safeQuery = toSafeOrSearchTerm(query);
  if (safeQuery) {
    builder = builder.or(
      [
        `contact_name.ilike.%${safeQuery}%`,
        `company.ilike.%${safeQuery}%`,
        `email.ilike.%${safeQuery}%`,
        `phone.ilike.%${safeQuery}%`,
      ].join(","),
    );
  }

  const { data, error } = await builder.order("updated_at", { ascending: false }).limit(MAX_RESULTS);

  if (error || !data) {
    return [];
  }

  return data as LeadSearchResult[];
}
