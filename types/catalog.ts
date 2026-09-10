import type { RecordStatus } from "./customer";

/** Fixed vocabulary, CHECK-constrained in the database — not
 *  customer-configurable the way lead stages are, so a plain union
 *  (not a lookup table) is the right shape here. */
export const PRICING_UNITS = ["One-time", "Monthly", "Yearly"] as const;
export type PricingUnit = (typeof PRICING_UNITS)[number];

/** A row from public.customer_catalog_items. */
export type CatalogItem = {
  id: string;
  customer_id: string;
  name: string;
  category: string;
  /** numeric(12,2) in the database — always a real number here, never
   *  a formatted string; ₹-formatting happens only at render time. */
  price: number;
  pricing_unit: PricingUnit;
  description: string | null;
  status: RecordStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
