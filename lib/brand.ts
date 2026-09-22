/**
 * This product's own name and logo — the ONE place either is defined.
 *
 * NOT FOR TENANT DATA. A customer's own company name
 * (`customers.name`/`company_name`, shown e.g. in the sidebar under
 * this product's own logo) is real tenant data read from the database
 * at request time, same as it always was — it has nothing to do with
 * this file and must never be confused with it. This file exists
 * ONLY for places the app identifies ITSELF: the browser tab title,
 * the login/signup screens, the sidebar/footer product lockup, an
 * outbound API call's own "who is calling" header, and so on.
 *
 * Before this file existed, "Techmatrix Sales Management" was
 * hardcoded independently in over a dozen places, each one a chance
 * to rename 11 of them and miss the 12th. Every product-brand string
 * and asset path in the app now reads from here instead.
 */
export const BRAND_NAME = "Pipeway";

export const BRAND_DESCRIPTION = `Manage your sales activities efficiently and securely with ${BRAND_NAME}.`;

/**
 * The icon mark alone (no wordmark) — a tight square crop of the
 * source logo's "P" glyph, opaque on a near-white background rather
 * than a transparent cutout.
 *
 * WHY OPAQUE, NOT TRANSPARENT: every place this asset is used against
 * a dark surface (the sidebar header, the marketing footer) already
 * wraps it in its own explicit white rounded card
 * (`rounded-xl bg-white p-2` / `rounded-lg bg-white/95 p-2`) — a
 * deliberate existing convention, not an oversight. A naive
 * near-white chroma-key on the source PNG (no professional
 * image-editing tool is available in this environment) left a faint
 * light fringe around the glyph's curved edges when composited
 * directly onto a dark background — visibly worse than just keeping
 * the clean opaque square and letting the existing white-card wrapper
 * do its job, which it was already built to do.
 */
export const BRAND_MARK_SRC = "/pipeway-mark.png";
export const BRAND_MARK_WIDTH = 512;
export const BRAND_MARK_HEIGHT = 512;
