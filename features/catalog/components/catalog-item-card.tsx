import { currencyFormatter } from "@/utils/format";
import { CatalogItemActionsMenu } from "./catalog-item-actions-menu";
import { EditCatalogItemDialog } from "./edit-catalog-item-dialog";
import type { CatalogItemListItem } from "../lib/get-catalog-items";

/** Matches the pricing_unit CHECK constraint's exact stored values —
 *  lowercased only for display, per the reference screenshot ("one-time",
 *  not "One-time"), never used to alter what's actually stored/submitted. */
const PRICING_UNIT_LABELS: Record<string, string> = {
  "One-time": "one-time",
  Monthly: "monthly",
  Yearly: "yearly",
};

type CatalogItemCardProps = {
  item: CatalogItemListItem;
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
 * STATUS STYLING: this is the second iteration of this card's status
 * treatment. The first version colored the whole card by status
 * (too loud); the second made status ONLY a small badge (client
 * feedback: too subtle to scan at a glance across a grid). This
 * version splits the difference deliberately: the card SURFACE (a flat
 * pale teal tint for Active, plain white for Inactive) plus a thin left
 * accent bar carry the at-a-glance signal, while name/description/price
 * stay full-strength `neutral-900`/`neutral-600` on every card — no
 * opacity reduction, no strikethrough, nothing that reads as "disabled."
 * The badge is still present and still the explicit, readable label;
 * it's just no longer the ONLY thing that changes.
 */
export function CatalogItemCard({ item, canManage, onItemChanged }: CatalogItemCardProps) {
  const isActive = item.status === "Active";

  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-2xl border-l-[3px] shadow-sm ring-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        isActive
          ? "border-l-teal-500 bg-teal-50/60 ring-teal-100 hover:ring-teal-300"
          : "border-l-neutral-300 bg-white ring-neutral-200 hover:ring-neutral-300"
      }`}
    >
      <div className="flex flex-1 flex-col p-6">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 truncate text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">{item.category}</p>
          <div className="flex shrink-0 items-center gap-1.5">
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                isActive ? "bg-teal-100 text-teal-800 ring-teal-200" : "bg-neutral-100 text-neutral-600 ring-neutral-200"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-teal-500" : "bg-neutral-400"}`} aria-hidden="true" />
              {item.status}
            </span>
            {canManage ? (
              <EditCatalogItemDialog
                item={item}
                onSuccess={onItemChanged}
                renderTrigger={(open) => (
                  <CatalogItemActionsMenu item={item} onEdit={open} onChanged={onItemChanged} />
                )}
              />
            ) : null}
          </div>
        </div>

        <h3 className="mt-3 text-lg font-bold tracking-tight text-neutral-900">{item.name}</h3>
        {item.description ? <p className="mt-1.5 text-sm leading-relaxed text-neutral-600">{item.description}</p> : null}
      </div>

      <div
        className={`mt-auto flex items-end justify-between gap-3 border-t px-6 py-4 ${
          isActive ? "border-teal-100 bg-teal-50/50" : "border-neutral-100 bg-neutral-50/60"
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
