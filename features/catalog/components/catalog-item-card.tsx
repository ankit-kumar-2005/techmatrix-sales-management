import { currencyFormatter } from "@/utils/format";
import { CatalogItemStatusMenu } from "./catalog-item-status-menu";
import { EditCatalogItemDialog } from "./edit-catalog-item-dialog";
import { TagIcon } from "@/features/sales-management/components/icons";
import type { CatalogItem } from "@/types/catalog";

/** Matches the pricing_unit CHECK constraint's exact stored values —
 *  lowercased only for display, per the reference screenshot ("one-time",
 *  not "One-time"), never used to alter what's actually stored/submitted. */
const PRICING_UNIT_LABELS: Record<string, string> = {
  "One-time": "one-time",
  Monthly: "monthly",
  Yearly: "yearly",
};

type CatalogItemCardProps = {
  item: CatalogItem;
  /** Only an ADMIN gets the "⋮" activate/deactivate menu and the Edit
   *  control — everyone else still sees the status badge, just not
   *  either control. UX only: the real boundary is
   *  setCatalogItemStatusAction/updateCatalogItemAction's own role
   *  check plus RLS, both independent of this prop. */
  canManage: boolean;
  /** Called after a successful edit or status change — the paginated
   *  grid uses this to re-fetch whatever page/search/filter it's
   *  currently showing, so the card's own updated data actually
   *  appears without the user navigating away and back. */
  onItemChanged: () => void;
};

/**
 * Plain text rendering throughout — name/category/description are all
 * customer-provided data, rendered as React children (never
 * dangerouslySetInnerHTML), so React's default escaping is what keeps
 * this XSS-safe.
 *
 * INACTIVE STYLING: a purely visual state mapping — what "Active"/
 * "Inactive" means, and how it's toggled, is untouched. An inactive
 * item mutes every color accent (icon chip, category label, price
 * strip) to gray and slightly reduces the whole card's opacity, so it
 * visibly recedes next to Active cards in the same grid without ever
 * making its own text illegible.
 */
export function CatalogItemCard({ item, canManage, onItemChanged }: CatalogItemCardProps) {
  const isActive = item.status === "Active";

  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-2xl shadow-sm ring-1 ring-black/5 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg ${
        isActive
          ? "bg-gradient-to-br from-white to-teal-50/50 hover:ring-teal-900/10"
          : "bg-gradient-to-br from-white to-neutral-50 opacity-90 hover:ring-neutral-900/10"
      }`}
    >
      <div className="flex flex-1 flex-col p-6">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${
                isActive ? "bg-teal-50 text-teal-700 ring-teal-100" : "bg-neutral-100 text-neutral-400 ring-neutral-200"
              }`}
            >
              <TagIcon className="h-4 w-4" />
            </span>
            <p
              className={`truncate text-[11px] font-semibold tracking-wider uppercase ${
                isActive ? "text-teal-700" : "text-neutral-400"
              }`}
            >
              {item.category}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors duration-150 ${
                isActive ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-100" : "bg-neutral-100 text-neutral-500 ring-1 ring-neutral-200"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${isActive ? "bg-emerald-500" : "bg-neutral-400"}`} aria-hidden="true" />
              {item.status}
            </span>
            {canManage ? (
              <>
                <EditCatalogItemDialog item={item} onSuccess={onItemChanged} />
                <CatalogItemStatusMenu item={item} onChanged={onItemChanged} />
              </>
            ) : null}
          </div>
        </div>

        <h3 className="mt-3 text-lg font-bold tracking-tight text-neutral-900">{item.name}</h3>
        {item.description ? <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{item.description}</p> : null}
      </div>

      <div
        className={`mt-auto flex items-end justify-between gap-3 border-t px-6 py-4 ${
          isActive ? "border-teal-100 bg-teal-50/60" : "border-neutral-200 bg-neutral-50"
        }`}
      >
        <p className="text-2xl font-bold tracking-tight text-neutral-900">{currencyFormatter.format(item.price)}</p>
        <span className="shrink-0 pb-0.5 text-xs font-medium text-neutral-500">
          {PRICING_UNIT_LABELS[item.pricing_unit] ?? item.pricing_unit}
        </span>
      </div>
    </div>
  );
}
