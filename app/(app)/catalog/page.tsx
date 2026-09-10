import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getCatalogItemsPage, getDistinctCatalogCategories } from "@/features/catalog/lib/get-catalog-items";
import { CatalogItemsGrid } from "@/features/catalog/components/catalog-items-grid";
import { NewCatalogItemDialog } from "@/features/catalog/components/new-catalog-item-dialog";
import { CatalogIcon } from "@/features/sales-management/components/icons";

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
 * "+ New item" (both the header-style button and the ghost card) now
 * renders from inside CatalogItemsGrid instead of here — it needs to
 * share the grid's own refresh callback (reset filters + page 1 on
 * create) directly, and the two were siblings under this Server
 * Component before, which had no way to hand that callback across.
 */
export default async function CatalogPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    redirect("/signup");
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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">
          Product &amp; service catalog
        </h1>
        <p className="mt-1.5 text-sm text-neutral-500">
          What you sell, with pricing reps can attach to a proposal straight from a lead.
        </p>
      </div>

      {initialPage.totalCount === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-white py-14 text-center shadow-sm ring-1 ring-black/5">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-teal-50 text-teal-700">
            <CatalogIcon className="h-6 w-6" />
          </span>
          {canManage ? (
            <div className="flex flex-col items-center gap-3">
              <div>
                <p className="text-sm font-semibold text-neutral-700">No catalog items yet</p>
                <p className="mt-1 max-w-xs text-sm text-neutral-500">
                  Click &ldquo;New item&rdquo; to add the first thing you sell.
                </p>
              </div>
              {/* This page's own Server Component re-renders once
                  createCatalogItemAction's revalidatePath("/catalog")
                  resolves, swapping straight to the CatalogItemsGrid
                  branch below with the real data — no onSuccess/refresh
                  wiring needed for this one-off "first item" case. */}
              <NewCatalogItemDialog />
            </div>
          ) : (
            <p className="text-sm font-semibold text-neutral-700">No catalog items are currently available.</p>
          )}
        </div>
      ) : (
        <CatalogItemsGrid
          initialItems={initialPage.items}
          initialTotalCount={initialPage.totalCount}
          categories={categories}
          canManage={canManage}
        />
      )}
    </div>
  );
}
