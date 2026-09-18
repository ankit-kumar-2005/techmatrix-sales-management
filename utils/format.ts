/** Shared across the Pipeline page (server) and the client-side Pipeline
 *  view/toolbar — kept in one place so both stay in sync. */
export const currencyFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});

export const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

const relativeTimeFormatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

/**
 * "just now" / "18 minutes ago" / "yesterday" / "3 weeks ago".
 *
 * COMPUTED FROM A SERVER-SUPPLIED `now`, never from the client clock.
 * Lead Capture renders these in a Server Component and the value must
 * be identical in the server HTML and the client hydration pass — a
 * component that read Date.now() itself would produce a hydration
 * mismatch for anybody whose machine is even a second out, and a wrong
 * local clock could invent "in 2 hours" for a lead that already
 * arrived.
 *
 * numeric: "auto" is what gives "yesterday" instead of "1 day ago";
 * Intl handles the pluralisation and wording, so there is no hand-rolled
 * unit table here to drift out of sync with a locale.
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const seconds = Math.round((then - nowMs) / 1000);
  const absolute = Math.abs(seconds);

  // Below a minute, "0 seconds ago" reads worse than the plain phrase.
  if (absolute < 45) return "just now";

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.348],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];

  let value = seconds;
  for (const [unit, step] of units) {
    if (Math.abs(value) < step) {
      return relativeTimeFormatter.format(Math.round(value), unit);
    }
    value /= step;
  }
  return relativeTimeFormatter.format(Math.round(value), "year");
}
