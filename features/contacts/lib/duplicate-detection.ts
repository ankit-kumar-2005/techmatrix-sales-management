import Fuse from "fuse.js";
import type { DismissedPair, DuplicateCandidateContact } from "./get-contacts";

const MAX_DUPLICATE_PAIRS = 20;

// Fuse's own match threshold: 0 requires a near-exact match, 1 matches
// almost anything. 0.35 is deliberately on the stricter side — this
// panel is meant to surface genuinely likely duplicates, not "contains
// the same common first name." Tuned against the two worked examples
// this feature was speced against: two "Ravi Deshmukh / Vindhya
// Precision Manufacturing / COO" contacts with only their email's
// local-part differing (ravi.deshmukh@... vs r.deshmukh@...) must match;
// "Ravi Sharma" vs "Ravi Deshmukh" (different surname, and in practice a
// different company/title/email too) must not, purely from sharing the
// first name "Ravi".
const FUSE_THRESHOLD = 0.35;

/** trim + collapse internal whitespace + lowercase — comparison only,
 *  never mutates what's stored (see createContactAction). */
function normalizeName(value: string | null): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeEmail(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

// Strips everything but digits, then keeps only the last 10 — enough to
// treat "+91 98765 43210" and "9876543210" as the same number (a bare
// 10-digit Indian mobile number with or without a leading country/trunk
// prefix) without needing a full phone-number-parsing library for a
// single normalization step used only for duplicate-comparison, never
// for storage or validation.
function normalizePhone(value: string | null): string {
  const digitsOnly = (value ?? "").replace(/\D/g, "");
  return digitsOnly.length > 10 ? digitsOnly.slice(-10) : digitsOnly;
}

type DuplicateSearchDoc = {
  id: string;
  name: string;
  company: string;
  title: string;
  normalizedEmail: string;
  normalizedPhone: string;
  /** The composite text queried against every OTHER candidate's own
   *  weighted keys below — see this module's file-level comment on why
   *  a single composite query (rather than Fuse's extended per-key query
   *  syntax) is used here. */
  profile: string;
};

function toSearchDoc(contact: DuplicateCandidateContact): DuplicateSearchDoc {
  const name = normalizeName(contact.name);
  const company = normalizeName(contact.company);
  const title = normalizeName(contact.title);
  const normalizedEmail = normalizeEmail(contact.email);
  const normalizedPhone = normalizePhone(contact.phone);

  return {
    id: contact.id,
    name,
    company,
    title,
    normalizedEmail,
    normalizedPhone,
    profile: [name, company, title, normalizedEmail, normalizedPhone].filter(Boolean).join(" "),
  };
}

export type DuplicatePair = {
  contactA: DuplicateCandidateContact;
  contactB: DuplicateCandidateContact;
  /** Fuse's own match score for this pair — lower is a closer match.
   *  Exposed for potential future UI ("strong match" vs "possible
   *  match"), not currently rendered. */
  score: number;
};

/**
 * Finds likely-duplicate PAIRS within one bounded, already customer-
 * scoped candidate list (see getDuplicateCandidates — this function
 * itself does no database access and has no notion of tenancy; it must
 * only ever be called with contacts already confirmed to belong to one
 * customer, which is what keeps this from ever mixing two customers'
 * contacts into the same comparison).
 *
 * Uses Fuse.js's own weighted multi-key fuzzy search rather than a
 * hand-rolled similarity algorithm: one Fuse index is built over the
 * whole candidate list, keyed on name/company/title/normalizedEmail/
 * normalizedPhone with the weights below (email and phone weighted
 * highest per spec — "stronger duplicate signals than loose name
 * similarity" — company next, title lowest). For each candidate, its own
 * composite profile string is searched against that same index; Fuse
 * matches that composite text against every OTHER candidate's
 * individually-weighted keys and returns a combined score per candidate,
 * exactly the library's intended `keys` + `weight` behavior applied here
 * to profile-vs-record comparison rather than free-text-vs-record search.
 *
 * dismissedPairs (from contact_duplicate_dismissals, already customer-
 * scoped by its own RLS) are filtered out before returning — a user's
 * "Not a duplicate" must not keep resurfacing on the next visit.
 */
export function findPossibleDuplicates(
  candidates: DuplicateCandidateContact[],
  dismissedPairs: DismissedPair[],
): DuplicatePair[] {
  if (candidates.length < 2) {
    return [];
  }

  const contactById = new Map(candidates.map((contact) => [contact.id, contact]));
  const dismissedKeys = new Set(dismissedPairs.map((pair) => `${pair.contactIdA}|${pair.contactIdB}`));

  const docs = candidates.map(toSearchDoc);
  const fuse = new Fuse(docs, {
    keys: [
      { name: "normalizedEmail", weight: 0.35 },
      { name: "normalizedPhone", weight: 0.25 },
      { name: "name", weight: 0.25 },
      { name: "company", weight: 0.1 },
      { name: "title", weight: 0.05 },
    ],
    includeScore: true,
    threshold: FUSE_THRESHOLD,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

  const seenPairKeys = new Set<string>();
  const pairs: DuplicatePair[] = [];

  for (const doc of docs) {
    if (!doc.profile) continue; // a contact with no comparable fields at all can't meaningfully match anything

    const results = fuse.search(doc.profile);
    for (const result of results) {
      if (result.item.id === doc.id) continue; // Fuse matching a contact against its own record isn't a "duplicate"

      const [idA, idB] = [doc.id, result.item.id].sort();
      const pairKey = `${idA}|${idB}`;
      if (seenPairKeys.has(pairKey) || dismissedKeys.has(pairKey)) continue;
      seenPairKeys.add(pairKey);

      const contactA = contactById.get(idA);
      const contactB = contactById.get(idB);
      if (!contactA || !contactB) continue;

      pairs.push({ contactA, contactB, score: result.score ?? 1 });
    }
  }

  return pairs.sort((a, b) => a.score - b.score).slice(0, MAX_DUPLICATE_PAIRS);
}
