import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogItem } from "@/types/catalog";

/**
 * Server-side only: every catalog item belonging to one customer, most
 * recently updated first. RLS ("customer members can view their
 * customer's catalog items") is still the enforcing layer — this just
 * adds the ordering the page wants. Deliberately returns Active and
 * Inactive items alike (matching getLeadStagesForCustomer's own
 * reasoning) — there's no "hide inactive" filter in this UI, so callers
 * get everything and can decide later.
 *
 * Superseded as the Catalog page's main data source by getCatalogItemsPage
 * below (which is genuinely paginated/filterable at the database level,
 * required once a customer's catalog can hold hundreds of items) — kept
 * as-is since nothing else currently calls it, but left in place rather
 * than deleted in case a future unpaginated need (an export, a picker
 * elsewhere) wants the full set again.
 */
export async function getCatalogItemsForCustomer(supabase: SupabaseClient, customerId: string): Promise<CatalogItem[]> {
  const { data, error } = await supabase
    .from("customer_catalog_items")
    .select("*")
    .eq("customer_id", customerId)
    .order("updated_at", { ascending: false });

  if (error || !data) {
    return [];
  }

  return data as CatalogItem[];
}

export type CatalogItemsPageParams = {
  /** Case-insensitive substring match against `name`, server-side
   *  (`.ilike`) — "" means no search filter. */
  search: string;
  /** Exact match against `category` — "" means every category. */
  category: string;
  /** 0-indexed page number. */
  page: number;
  pageSize: number;
};

export type CatalogItemsPage = {
  items: CatalogItem[];
  /** Total rows matching the current search/category filter (not just
   *  this page) — from a `{ count: "exact", head: true }`-equivalent
   *  request alongside the row fetch, what the page indicator and the
   *  Previous/Next disabled states are computed from. */
  totalCount: number;
};

/**
 * Server-side only: exactly one page of one customer's catalog items,
 * matching the given search/category filter — a real `.range(from, to)`
 * request against Postgres, never the full table sliced in JS. RLS is
 * still the enforcing layer for tenant isolation; this adds the
 * filtering/ordering/pagination the Catalog page's toolbar needs.
 * Shared by the page's own initial (server-rendered) fetch and
 * getCatalogItemsPageAction's subsequent client-driven re-fetches, so
 * the two can never drift into two different query shapes.
 */
export async function getCatalogItemsPage(
  supabase: SupabaseClient,
  customerId: string,
  params: CatalogItemsPageParams,
): Promise<CatalogItemsPage> {
  const from = params.page * params.pageSize;
  const to = from + params.pageSize - 1;

  let query = supabase
    .from("customer_catalog_items")
    .select("*", { count: "exact" })
    .eq("customer_id", customerId);

  const trimmedSearch = params.search.trim();
  if (trimmedSearch) {
    query = query.ilike("name", `%${trimmedSearch}%`);
  }
  if (params.category) {
    query = query.eq("category", params.category);
  }

  const { data, error, count } = await query.order("updated_at", { ascending: false }).range(from, to);

  if (error || !data) {
    return { items: [], totalCount: 0 };
  }

  return { items: data as CatalogItem[], totalCount: count ?? 0 };
}

/**
 * Server-side only: every distinct `category` value this customer's
 * catalog items currently use, for the toolbar's category filter
 * dropdown — deliberately not a fixed Product/Service enum (the
 * database has no CHECK constraint on this column; category is
 * free-text an admin types when creating an item, see
 * createCatalogItemSchema), so the dropdown's options must come from
 * real data, not a guessed list.
 *
 * This does fetch every row's `category` column for the customer (not
 * paginated) — a deliberate, bounded exception to "never fetch the
 * whole table": it's a single text column, not full rows, and
 * PostgREST has no first-class SQL DISTINCT in its query-builder API,
 * so de-duplicating in JS after a single lightweight column projection
 * is the pragmatic choice here rather than adding a database function
 * for it.
 */
export async function getDistinctCatalogCategories(supabase: SupabaseClient, customerId: string): Promise<string[]> {
  const { data, error } = await supabase.from("customer_catalog_items").select("category").eq("customer_id", customerId);

  if (error || !data) {
    return [];
  }

  const unique = new Set(data.map((row) => row.category as string));
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}
