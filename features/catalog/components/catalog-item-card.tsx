import { currencyFormatter } from "@/utils/format";
import { CatalogItemActionsMenu } from "./catalog-item-actions-menu";
import { EditCatalogItemDialog } from "./edit-catalog-item-dialog";
import { CubeIcon, SettingsIcon, TagIcon } from "@/features/sales-management/components/icons";
import type { CatalogItemListItem } from "../lib/get-catalog-items";

/** Matches the pricing_unit CHECK constraint's exact stored values —
 *  lowercased only for display, per the reference screenshot ("one-time",
 *  not "One-time"), never used to alter what's actually stored/submitted. */
const PRICING_UNIT_LABELS: Record<string, string> = {
  "One-time": "one-time",
  Monthly: "monthly",
  Yearly: "yearly",
};

/** category is free text (no CHECK constraint — see
 *  customer_catalog_items migration and the Category field's own "e.g.
 *  Support" placeholder), so this can only special-case the two values
 *  the reference design actually shows; anything else falls back to a
 *  neutral tag icon/gradient rather than guessing at a third color. Case/
 *  whitespace-insensitive so "product", "Product ", etc. all match. */
function getCategoryIconChip(category: string) {
  const normalized = category.trim().toLowerCase();
  if (normalized === "product") {
    return { Icon: CubeIcon, gradientClass: "bg-gradient-to-br from-violet-500 to-purple-600" };
  }
  if (normalized === "service") {
    return { Icon: SettingsIcon, gradientClass: "bg-gradient-to-br from-teal-400 to-teal-600" };
  }
  return { Icon: TagIcon, gradientClass: "bg-gradient-to-br from-neutral-400 to-neutral-500" };
}

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
  const { Icon: CategoryIcon, gradientClass } = getCategoryIconChip(item.category);

  return (
    <div
      className={`flex h-full flex-col rounded-2xl border-l-[3px] shadow-sm ring-1 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md ${
        isActive
          ? "border-l-teal-500 bg-teal-50/60 ring-teal-100 hover:ring-teal-300"
          : "border-l-neutral-300 bg-white ring-neutral-200 hover:ring-neutral-300"
      }`}
    >
      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-white shadow-sm ${gradientClass}`}
            >
              <CategoryIcon className="h-6 w-6" />
            </span>
            <p className="text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">{item.category}</p>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${
              isActive ? "bg-teal-100 text-teal-800 ring-teal-200" : "bg-neutral-100 text-neutral-600 ring-neutral-200"
            }`}
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${isActive ? "bg-teal-500" : "bg-neutral-400"}`} aria-hidden="true" />
            {item.status}
          </span>
        </div>

        <h3 className="mt-2.5 text-lg font-bold tracking-tight text-neutral-900">{item.name}</h3>
        {/* No placeholder rendered when there's no description (never
            was) — the dead space a no-description card used to show
            wasn't a phantom empty line, it was this flex-1 content
            area stretching to match the row's tallest sibling (needed
            to keep the footer pinned to the same bottom edge across a
            row — see the footer's own mt-auto below). Shrinking this
            section's own padding/margins is what shrinks that shared
            row height at the source, for every card in the row at
            once, rather than something to "fix" per-card. */}
        {item.description ? <p className="mt-1 text-sm leading-relaxed text-neutral-600">{item.description}</p> : null}
      </div>

      {/* rounded-b-2xl here (not overflow-hidden on the outer card, which
          this component used to rely on) — this footer strip is the only
          child that paints its own distinct background, so it's the only
          one that needs its bottom corners individually rounded to match
          the card's own. Dropping the outer overflow-hidden entirely is
          what lets CatalogItemActionsMenu's dropdown (mounted inside this
          footer row now) actually render below the card instead of being
          clipped at the card's own bottom edge — see
          CatalogItemsGrid's matching change for the other half of this
          (its own wrapper had the same clipping problem one level up). */}
      <div
        className={`mt-auto flex items-center justify-between gap-3 rounded-b-2xl border-t px-5 py-3 ${
          isActive ? "border-teal-100 bg-teal-50/50" : "border-neutral-100 bg-neutral-50/60"
        }`}
      >
        <div className="flex flex-col">
          <p className="text-2xl font-bold tracking-tight text-neutral-900">{currencyFormatter.format(item.price)}</p>
          <span className="text-xs font-medium text-neutral-500">
            {PRICING_UNIT_LABELS[item.pricing_unit] ?? item.pricing_unit}
          </span>
        </div>
        {canManage ? (
          <EditCatalogItemDialog
            item={item}
            onSuccess={onItemChanged}
            renderTrigger={(open) => <CatalogItemActionsMenu item={item} onEdit={open} onChanged={onItemChanged} />}
          />
        ) : null}
      </div>
    </div>
  );
}
