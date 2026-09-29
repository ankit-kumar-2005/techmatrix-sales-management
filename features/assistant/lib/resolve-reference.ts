/**
 * Resolves a model's free-text `record_reference` guess against a real,
 * already-authorized set of records — the mechanism behind the
 * feature's #4 non-negotiable ("ambiguity always becomes a question,
 * never a guess... especially for identifying WHICH existing record an
 * edit or summary refers to").
 *
 * DELIBERATELY NOT FUZZY-MATCHING LIBRARY CODE. This app already has a
 * documented reason to avoid pulling one in for exactly this kind of
 * matching (see the Contacts duplicate-detection feature, which rolled
 * its own scoring rather than adding a dependency) — a plain
 * normalize-and-substring/word-overlap check is transparent, has no
 * surprising edge cases, and is easy to reason about for something that
 * gates "does this open someone's real record."
 *
 * THE MODEL NEVER SEES THIS FUNCTION'S INPUT OR OUTPUT. It only ever
 * produces the free-text guess being resolved here — this is where
 * that guess meets real, tenant-and-role-scoped data for the first
 * time, entirely in this process, never round-tripped through the LLM.
 */

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A permissive match on purpose: this function's only two possible
 *  outcomes for anything short of exactly one match are BOTH safe
 *  (zero matches -> ask; multiple matches -> ask, listing the real
 *  candidates) — there is no silent-pick failure mode being risked by
 *  matching a little too generously, only an extra, harmless
 *  clarifying question if it over-matches. */
function isMatch(referenceNormalized: string, candidateTextNormalized: string): boolean {
  if (!referenceNormalized || !candidateTextNormalized) return false;
  if (candidateTextNormalized.includes(referenceNormalized) || referenceNormalized.includes(candidateTextNormalized)) {
    return true;
  }
  const refWords = new Set(referenceNormalized.split(" ").filter((word) => word.length >= 3));
  if (refWords.size === 0) return false;
  return candidateTextNormalized
    .split(" ")
    .filter((word) => word.length >= 3)
    .some((word) => refWords.has(word));
}

export type ReferenceResolution<T> =
  | { status: "none" }
  | { status: "one"; match: T }
  | { status: "many"; matches: T[] };

/** MAX candidates ever listed back to the user in a disambiguation
 *  question — a reference vague enough to match more than this is
 *  vague enough that the honest answer is "please be more specific,"
 *  not a wall of names. */
const MAX_LISTED_CANDIDATES = 6;

export function resolveReference<T>(
  reference: string | null,
  candidates: readonly T[],
  getSearchableText: (item: T) => string,
): ReferenceResolution<T> {
  if (!reference || !reference.trim()) {
    return { status: "none" };
  }

  const referenceNormalized = normalize(reference);
  const matches = candidates.filter((candidate) => isMatch(referenceNormalized, normalize(getSearchableText(candidate))));

  if (matches.length === 0) return { status: "none" };
  if (matches.length === 1) return { status: "one", match: matches[0] };
  return { status: "many", matches: matches.slice(0, MAX_LISTED_CANDIDATES) };
}

/** Builds the disambiguating question text from REAL matched
 *  candidates only — this message is constructed here, in code, never
 *  by the model (which never saw these records in the first place). */
export function buildDisambiguationQuestion<T>(matches: T[], getLabel: (item: T) => string, nounSingular: string): string {
  const labels = matches.map(getLabel);
  return `I found ${labels.length} ${nounSingular}s matching that — ${labels.join(", ")}. Which one did you mean?`;
}

export function buildNoMatchQuestion(nounSingular: string): string {
  return `I couldn't find a ${nounSingular} matching that. Could you give me a name, company, or other detail to identify it?`;
}
