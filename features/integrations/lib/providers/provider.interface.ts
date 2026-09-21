/**
 * The one contract every lead-source adapter implements. Nothing else
 * about a source — its webhook path segment, its display name, its
 * setup instructions — is decided here; this interface exists purely
 * to turn "whatever a vendor's webhook posted" into this app's own,
 * generic lead shape.
 */

/**
 * A lead, already translated out of one vendor's field names into the
 * names ingest_lead() actually takes. Every field is the FINAL value —
 * any vendor-specific fallback chain (e.g. "if company is blank, use
 * the person's name instead") has already run by the time this exists.
 * null means "this source genuinely didn't send anything for this
 * field", not "still needs resolving" — the one remaining, genuinely
 * universal fallback (what to do when BOTH company and contact_name are
 * still null) is the database function's job, not the adapter's — see
 * the migration's design note 10.
 */
export type NormalizedLead = {
  /** The source's own id for this specific enquiry — IndiaMART's
   *  UNIQUE_QUERY_ID, for instance. null when the source sent nothing
   *  usable, which means this particular push CANNOT be deduped against
   *  a retry (see the migration's design note 2 on that known edge). */
  external_id: string | null;
  contact_name: string | null;
  company: string | null;
  email: string | null;
  phone: string | null;
  /** One already-composed postal address string — joining whatever
   *  separate address fields a vendor sends into this single value is
   *  entirely this adapter's job; ingest_lead() only ever sees the
   *  result. */
  address: string | null;
  /** One already-composed free-text field — combining a vendor's
   *  separate "what product" / "what did they say" fields (if it even
   *  has more than one) into this single value is also entirely this
   *  adapter's job. */
  notes: string | null;
};

/** Returned instead of a NormalizedLead when the raw body did not even
 *  match this source's documented shape. `detail` is a SHORT, SAFE,
 *  log-only diagnostic — field paths and Zod issue codes, matching this
 *  app's existing "paths and codes only, never values" convention
 *  (CLAUDE.md Section P) — never anything derived from the actual
 *  values in the payload, which can carry a real buyer's name, phone
 *  and email. */
export type ParseError = {
  ok: false;
  detail: string;
};

export type ParseResult = { ok: true; lead: NormalizedLead } | ParseError;

/**
 * One adapter per lead source. `parse` is deliberately synchronous and
 * side-effect-free — it turns bytes into a NormalizedLead (or a reason
 * it couldn't), nothing more. It never touches Supabase, never knows
 * about webhook_token, never decides what an HTTP response looks like —
 * all of that is the controller's job (app/api/webhooks/leads/[source]/
 * [token]/route.ts) and the database's job (ingest_lead()), neither of
 * which an adapter needs to know exist.
 */
export interface LeadProviderAdapter {
  parse(rawBody: unknown): ParseResult;
}
