import Fuse from "fuse.js";
import { getOwnerDisplayLabels } from "@/features/leads/lib/owner-display";
import type { TeamDirectoryEntry } from "@/types/lead";

/**
 * Resolve a literal NAME the model read out of meeting notes to the
 * closest member of the caller's own visible team directory.
 *
 * WHAT THIS IS NOT: an assignment. The result only ever annotates one
 * option in the existing Assign picker and explains where the
 * suggestion came from; it is never that select's default value. A
 * fuzzy match is a statement about what the notes said, not a decision
 * about who owns the work — and the schema reflects that too, which is
 * why no matched id is ever stored on the action item.
 *
 * REUSES THE EXISTING TOOLING, per the spec's own instruction not to
 * build a second lookup:
 *   * fuse.js — already a dependency, already used for exactly this kind
 *     of name fuzziness in features/contacts/lib/duplicate-detection.ts.
 *   * getOwnerDisplayLabels — the one place that decides what a member
 *     is called (name, falling back to email). Matching against the same
 *     label the picker displays is what makes "the closest teammate is
 *     marked below" true rather than approximately true.
 *   * The directory itself comes from get_visible_team_directory(), so
 *     the candidate set is already hierarchy-scoped: a match can only
 *     ever be someone the caller may actually assign to.
 *
 * COMPUTED SERVER-SIDE. The card is a Server Component and passes the
 * result down as a plain string id, so Fuse and the whole directory stay
 * out of the client bundle for this feature.
 */

/**
 * Stricter than duplicate-detection's 0.35, deliberately.
 *
 * That function searches a composite profile (email + phone + name +
 * company + title) where several weak signals legitimately add up. This
 * one has a single short field to go on — a person's name — so the same
 * threshold would be far looser in practice. 0.3 accepts a real
 * variation ("Karthik" -> "Karthik Menon", a transposed surname, a
 * missing initial) while rejecting a coincidental first-name collision,
 * which is the failure that matters here: marking the wrong teammate as
 * "suggested by the notes" is worse than marking nobody, because the
 * user might trust it.
 */
const FUSE_THRESHOLD = 0.3;

/** Below two characters there is nothing to match on and Fuse will
 *  happily return something. Matches duplicate-detection's own
 *  minMatchCharLength reasoning. */
const MIN_NAME_LENGTH = 2;

export type AssigneeMatch = {
  /** The literal name from the source, passed through unchanged for the
   *  UI to quote back. */
  sourceName: string;
  /** customer_users.id of the closest teammate, or null when nothing was
   *  close enough. Null is a useful answer, not a failure — "the notes
   *  say Rahul and no teammate matched" is worth telling the user. */
  matchedCustomerUserId: string | null;
};

export function matchSuggestedAssignee(
  suggestedName: string | null,
  owners: TeamDirectoryEntry[],
): AssigneeMatch | null {
  // No name in the source means no hint to show at all — distinct from
  // "a name that matched nobody", which does get a hint.
  const sourceName = suggestedName?.trim() ?? "";
  if (!sourceName) return null;

  if (sourceName.length < MIN_NAME_LENGTH || owners.length === 0) {
    return { sourceName, matchedCustomerUserId: null };
  }

  const labelById = getOwnerDisplayLabels(owners);

  // Searched over BOTH the display label and the raw email local-part:
  // a member with no name on file falls back to their email in the
  // picker, and "rahul.verma@..." should still match a note that says
  // "Rahul Verma".
  const docs = owners.map((owner) => ({
    customerUserId: owner.customer_user_id,
    label: labelById.get(owner.customer_user_id) ?? owner.email,
    emailLocalPart: owner.email.split("@")[0].replace(/[._-]+/g, " "),
  }));

  const fuse = new Fuse(docs, {
    keys: [
      { name: "label", weight: 0.8 },
      { name: "emailLocalPart", weight: 0.2 },
    ],
    includeScore: true,
    threshold: FUSE_THRESHOLD,
    ignoreLocation: true,
    minMatchCharLength: MIN_NAME_LENGTH,
  });

  const best = fuse.search(sourceName)[0];
  return {
    sourceName,
    matchedCustomerUserId: best ? best.item.customerUserId : null,
  };
}
