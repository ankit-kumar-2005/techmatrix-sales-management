/** Shared across the Pipeline page (server) and the client-side Pipeline
 *  view/toolbar — kept in one place so both stay in sync. */
export const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
