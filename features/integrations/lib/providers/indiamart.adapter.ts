import { z } from "zod";
import type { LeadProviderAdapter, NormalizedLead, ParseResult } from "./provider.interface";

/**
 * IndiaMART's Push API payload, and the one function that turns it into
 * this app's generic lead shape. Every IndiaMART-specific decision in
 * the whole Lead Capture feature lives in this one file: field names,
 * which fields fall back to which, and how the address and notes
 * columns get composed. ingest_lead() and the webhook controller both
 * know nothing about any of it.
 */

/**
 * EVERY FIELD IS OPTIONAL AND EVERY FIELD IS A STRING-OR-NUMBER.
 *
 * This is not laziness about validation — it is the correct shape for
 * this particular input. IndiaMART is a third party pushing to us on a
 * schedule we do not control, and it DEACTIVATES AN INTEGRATION AFTER
 * 48 CONTINUOUS HOURS of non-200 responses. A strict schema that 400s
 * on an unexpected extra key, a renamed field, or a numeric
 * UNIQUE_QUERY_ID would convert a cosmetic upstream change into a
 * silent, total loss of the tenant's lead feed two days later.
 *
 * So this schema's job is narrow: confirm the envelope is shaped like
 * an IndiaMART push at all, and coerce whatever arrived into strings.
 * Everything that actually protects the database — same-customer FKs,
 * the stage/owner re-validation, the dedupe index, NOT NULL fallbacks —
 * lives in ingest_lead(), where it cannot be bypassed by any payload.
 */
const leadFieldSchema = z.union([z.string(), z.number()]).optional().nullable();

const responseSchema = z.object({
  UNIQUE_QUERY_ID: leadFieldSchema,
  SENDER_NAME: leadFieldSchema,
  SENDER_MOBILE: leadFieldSchema,
  SENDER_EMAIL: leadFieldSchema,
  SENDER_COMPANY: leadFieldSchema,
  // The five location fields that get joined into one `address` value
  // below. Each is independently optional — IndiaMART sends whatever
  // the buyer actually filled in, which is routinely a subset.
  SENDER_ADDRESS: leadFieldSchema,
  SENDER_CITY: leadFieldSchema,
  SENDER_STATE: leadFieldSchema,
  SENDER_PINCODE: leadFieldSchema,
  SENDER_COUNTRY_ISO: leadFieldSchema,
  QUERY_PRODUCT_NAME: leadFieldSchema,
  QUERY_MESSAGE: leadFieldSchema,
});

type IndiaMartResponse = z.infer<typeof responseSchema>;

/**
 * RESPONSE arrives as an OBJECT for a single lead, but IndiaMART's own
 * documentation and their test tool have both shown it as a
 * single-element ARRAY. Accepting either costs one union and removes a
 * whole class of "works in test, 400s in production" failure — see the
 * 48-hour note above for why that matters more here than tidiness.
 */
const payloadSchema = z.object({
  RESPONSE: z.union([responseSchema, z.array(responseSchema).min(1)]),
});

/** Whatever arrived, trimmed to a real value or null. Local to this
 *  adapter — a different source's payload may not even have this
 *  string-or-number leniency problem, so this is not promoted anywhere
 *  shared. */
function clean(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Joins IndiaMART's five separate location fields into the single
 * `address` column, in this exact order: street, city, state, pincode,
 * country. Comma-space between values PRESENT after cleaning, never
 * between raw slots — that is what keeps a missing pincode from leaving
 * a stray double comma (", ,") rather than just closing the gap. All
 * five missing/empty produces null, never an empty string.
 *
 * NOT the newline-separated style buildNotes() below uses — an address
 * reads as a single line ("12 MG Road, Pune, Maharashtra, 411001, IN"),
 * never as a paragraph.
 */
function buildAddress(response: IndiaMartResponse): string | null {
  const parts = [
    clean(response.SENDER_ADDRESS),
    clean(response.SENDER_CITY),
    clean(response.SENDER_STATE),
    clean(response.SENDER_PINCODE),
    clean(response.SENDER_COUNTRY_ISO),
  ].filter((part): part is string => part !== null);

  return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Combines what product the buyer asked about and what they actually
 * typed into the single `notes` column, newline-separated — the
 * paragraph shape that is wrong for buildAddress() above is exactly
 * right here. Skips a missing product name without leaving a stray
 * leading newline; all missing produces null.
 */
function buildNotes(response: IndiaMartResponse): string | null {
  const productName = clean(response.QUERY_PRODUCT_NAME);
  const message = clean(response.QUERY_MESSAGE);

  const lines = [productName ? `Product: ${productName}` : null, message].filter(
    (line): line is string => line !== null,
  );

  return lines.length > 0 ? lines.join("\n") : null;
}

function normalize(response: IndiaMartResponse): NormalizedLead {
  const contactName = clean(response.SENDER_NAME);

  return {
    external_id: clean(response.UNIQUE_QUERY_ID),
    contact_name: contactName,
    // IndiaMART's SENDER_COMPANY is routinely empty for an individual
    // buyer — this is the vendor-specific fallback design note 10 talks
    // about: falling an empty company back to the person's own name is
    // a decision about THIS vendor's payload, not a universal ingestion
    // rule. Left as null (not a placeholder string) when both are
    // empty — ingest_lead() applies the one genuinely universal
    // last-resort fallback for that case, built from the source name
    // rather than a value this adapter would have to invent.
    company: clean(response.SENDER_COMPANY) ?? contactName,
    email: clean(response.SENDER_EMAIL),
    phone: clean(response.SENDER_MOBILE),
    address: buildAddress(response),
    notes: buildNotes(response),
  };
}

export const indiaMartAdapter: LeadProviderAdapter = {
  parse(rawBody: unknown): ParseResult {
    const parsed = payloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      // PATHS AND CODES ONLY, NEVER VALUES — see provider.interface.ts's
      // own note on ParseError.detail. "RESPONSE.SENDER_NAME
      // invalid_type" is the whole diagnosis anyway, and it is what
      // tells a maintainer whether IndiaMART renamed a field or
      // something else entirely is posting here.
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
        .join(", ");
      return { ok: false, detail: `RESPONSE shape mismatch (${issues})` };
    }

    const response = Array.isArray(parsed.data.RESPONSE) ? parsed.data.RESPONSE[0] : parsed.data.RESPONSE;

    return { ok: true, lead: normalize(response) };
  },
};
