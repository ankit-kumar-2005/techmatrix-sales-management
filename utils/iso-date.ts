/**
 * Is this string a real calendar date in ISO yyyy-mm-dd?
 *
 * PROMOTED FROM features/leads/schemas.ts, which defined it locally when
 * the lead form's Expected Close Date was the only consumer. Meeting
 * Notes is the second: the extraction model returns
 * `suggested_due_date` as a bare string, and a date suggested by a model
 * needs exactly the same scrutiny as one typed by a person — arguably
 * more. Per CLAUDE.md Section M's "start local, promote once actually
 * reused", that makes this the moment it moves rather than gets copied.
 *
 * TWO CHECKS, BOTH LOAD-BEARING:
 *
 *   1. The SHAPE must be exactly yyyy-mm-dd, so "31-10-2026",
 *      "10/31/2026" and "2026-1-5" are all rejected.
 *
 *   2. The date must ROUND-TRIP. A shape check alone is not enough,
 *      because JavaScript does not reject an out-of-range day — it rolls
 *      it over: new Date("2026-02-30") silently becomes March 2nd and
 *      "2026-04-31" becomes May 1st, neither of which produces an
 *      Invalid Date, so a NaN check cannot see them. Comparing the
 *      parsed date's own y/m/d back against the three numbers that went
 *      in is the only reliable way to catch a day that does not exist in
 *      that month — and it gets leap years right for free (2024-02-29
 *      passes, 2100-02-29 does not).
 *
 * Parsed with an explicit T00:00:00Z so the comparison runs in UTC.
 * Without it the string is read as LOCAL midnight and getUTCDate() would
 * disagree with the input by one day for anyone west of UTC, turning a
 * correct date into a validation failure purely by timezone.
 */
export function isRealIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const [, year, month, day] = match;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;

  return (
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  );
}
