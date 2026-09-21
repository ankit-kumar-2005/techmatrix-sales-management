import type { IntegrationSource } from "@/types/integration";

/**
 * THE one place a source's display identity is decided. Every UI
 * surface in this feature reads a source's name/initials from here —
 * `IndiaMART` (exact casing: capital I, capital MART) never appears as
 * a second, independently-typed string literal anywhere else in
 * features/integrations/ or app/(app)/lead-capture/.
 *
 * Deliberately separate from provider.interface.ts/registry.ts: those
 * are about PARSING a source's payload (a backend concern with zero UI
 * dependency); this is purely presentational. A future adapter could
 * exist without a metadata entry (it just couldn't be shown in the UI
 * yet), and this file has zero reason to import anything from the
 * adapters — keeping the two apart means a display-copy change is a
 * change to ONLY this file, never a risk to the ingestion path, and
 * vice versa.
 *
 * NO PER-VENDOR BRAND COLORS. Every badge below uses this app's own
 * blue-to-violet gradient — the same one the sidebar's active state,
 * every section's accent underline, and every primary button already
 * use. IndiaMART's real brand color is a saturated yellow; using it
 * here would make the IndiaMART card look like a pasted-in widget from
 * another product instead of a native part of this one, and would set
 * an precedent where every future source's card looks like a different
 * product's ad. One accent, every source — a JustDial card is a visual
 * sibling of this one, not a competing style.
 */

export type SourceMetadata = {
  /** Exact display casing — never re-derive this from the `source`
   *  column value by any transform (capitalize/uppercase/etc.); some
   *  vendor names have irregular internal casing ("IndiaMART" itself is
   *  the proof — no capitalization rule produces "MART" from "mart"). */
  displayName: string;
  /** 1-3 characters for the badge. Kept short on purpose — this sits in
   *  a fixed h-10 w-10 circle (SourceCard) and a h-2 w-2-adjacent small
   *  badge (RecentlyCaptured); anything longer stops being legible at
   *  the smaller size. */
  initials: string;
  /** The one-line description under the source's name on its card. */
  description: string;
};

export const SOURCE_METADATA: Record<IntegrationSource, SourceMetadata> = {
  IndiaMART: {
    displayName: "IndiaMART",
    initials: "IM",
    description: "Buyer enquiries pushed from your IndiaMART seller account.",
  },
};

/**
 * WHAT ADDING JustDial HERE WOULD LOOK LIKE (described, not built — you
 * asked for the proof, not the feature):
 *
 *   JustDial: {
 *     displayName: "JustDial",
 *     initials: "JD",
 *     description: "Buyer enquiries pushed from your JustDial seller account.",
 *   },
 *
 * That is the ENTIRE display-layer change. Every consumer below already
 * takes `source: IntegrationSource` and calls getSourceMetadata(source)
 * — none of them contains a source name, so none of them needs to
 * change. The badge renders "JD" in the same gradient circle
 * automatically. The only things still needed OUTSIDE this file to
 * actually ship JustDial are the two items already flagged as deferred
 * in the provider-registry work: a generic connect action/button (today
 * still IndiaMART-specific), and a per-source setup-instructions slot
 * (today JustDial's Lead Manager/Push API equivalent has nowhere to
 * live) — both untouched here, per your explicit "don't build these
 * yet" instruction.
 */

/** Every real call site already has a real `IntegrationSource`, never
 *  an arbitrary string — so this takes the typed union, not `string`,
 *  and needs no fallback branch for an unregistered value. (Contrast
 *  registry.ts's getLeadProviderAdapter(), which DOES take a bare
 *  string and DOES need a null case — that one resolves an UNTRUSTED
 *  URL segment from an outside caller; this one only ever resolves a
 *  value this app itself already validated when it was written to the
 *  database.) */
export function getSourceMetadata(source: IntegrationSource): SourceMetadata {
  return SOURCE_METADATA[source];
}
