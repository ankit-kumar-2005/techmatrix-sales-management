"use client";

import { useState } from "react";
import { CatalogItemsGrid } from "./catalog-items-grid";
import { NewCatalogItemDialog } from "./new-catalog-item-dialog";
import { CatalogIcon } from "@/features/sales-management/components/icons";
import type { CatalogItemsPage } from "../lib/get-catalog-items";

type CatalogPageClientProps = {
  initialPage: CatalogItemsPage;
  categories: string[];
  canManage: boolean;
};

/**
 * The single client boundary the Catalog page needs, owning exactly one
 * piece of shared state (`refreshToken`) — the "+ Add item" button now
 * lives in the page HEADER (top-right, next to the heading, matching
 * where Tasks'/Contacts' own header buttons already live —
 * TasksPageClient/ContactsPageClient) while the grid it needs to refresh
 * (CatalogItemsGrid) is a sibling further down the page; lifting just
 * this one token to their nearest common ancestor is the same pattern
 * those two already use.
 *
 * The empty-state branch below is UNCHANGED from what page.tsx used to
 * render directly — moved here verbatim, not modified, per the explicit
 * "do not change existing empty states" requirement. It doesn't need
 * refreshToken at all: creating the customer's very first item triggers
 * createCatalogItemAction's own revalidatePath("/catalog"), which
 * re-runs the Server Component and switches straight to the
 * CatalogItemsGrid branch with real data — nothing was mounted yet for
 * stale local state to get stuck in, unlike the populated case.
 *
 * The header's own NewCatalogItemDialog is a SEPARATE, independent mount
 * from the grid's own trailing "ghost card" trigger (exactly like those
 * two were already independent of each other before this change) — its
 * onSuccess only bumps this shared refreshToken rather than also
 * resetting CatalogItemsGrid's own search/category/page (which remain
 * entirely internal to that component, untouched, per "do not modify
 * existing filter/pagination logic"). A newly created item that doesn't
 * match the grid's current filter won't be visible until the filter is
 * cleared — the same tradeoff Tasks'/Contacts' own header "+ Add"
 * buttons already make relative to their in-grid equivalents.
 */
export function CatalogPageClient({ initialPage, categories, canManage }: CatalogPageClientProps) {
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">
            Product &amp; service catalog
          </h1>
          <p className="mt-1.5 text-sm text-neutral-500">
            What you sell, with pricing reps can attach to a proposal straight from a lead.
          </p>
        </div>

        {canManage ? <NewCatalogItemDialog onSuccess={() => setRefreshToken((token) => token + 1)} /> : null}
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
          externalRefreshToken={refreshToken}
        />
      )}
    </div>
  );
}
