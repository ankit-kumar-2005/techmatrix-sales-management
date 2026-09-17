import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getCatalogItemsPage, getDistinctCatalogCategories } from "@/features/catalog/lib/get-catalog-items";
import { CatalogPageClient } from "@/features/catalog/components/catalog-page-client";

const INITIAL_PAGE_SIZE = 6;

/**
 * Auth + customer membership are already guarded by
 * app/(app)/layout.tsx before this page ever renders (see
 * SalesManagementPage's own identical note) — this page only fetches
 * what it needs to display.
 *
 * Only fetches page 1 (no search/category filter, the default page
 * size) — CatalogItemsGrid takes it from there, fetching every
 * subsequent page/search/filter/page-size change itself via
 * getCatalogItemsPageAction, genuinely server-side (a real
 * .range()/.count() query, never the full table sliced in the
 * browser). initialTotalCount reflects the WHOLE customer's catalog
 * (no filter applied yet), so it's also the right signal for "does
 * this customer have any catalog items at all" below — a real 0 there
 * means an empty catalog, not just an empty filtered page.
 *
 * The page header (title, description, "+ Add item") and the
 * empty-state/grid branching all now live in CatalogPageClient — it
 * needs one small piece of shared client state (a refreshToken the
 * header button and CatalogItemsGrid both see) that a Server Component
 * itself can't hold, the same reason TasksPageClient/ContactsPageClient
 * exist for their own pages.
 */
export default async function CatalogPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    // /inactive for a DEACTIVATED member, /signup only for someone with
    // no membership row at all. One shared decision so this guard and
    // the (app) layout's cannot disagree — see getNoMembershipRedirect.
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  // RLS ("customer members can view their customer's catalog items")
  // already restricts both of these to exactly the caller's own
  // customer's rows — no app-level filtering needed here.
  const [initialPage, categories] = await Promise.all([
    getCatalogItemsPage(supabase, membership.customer.id, {
      search: "",
      category: "",
      page: 0,
      pageSize: INITIAL_PAGE_SIZE,
    }),
    getDistinctCatalogCategories(supabase, membership.customer.id),
  ]);

  const canManage = membership.role === "ADMIN";

  return <CatalogPageClient initialPage={initialPage} categories={categories} canManage={canManage} />;
}
