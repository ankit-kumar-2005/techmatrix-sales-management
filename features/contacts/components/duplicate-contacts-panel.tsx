import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getDuplicateCandidates, getDismissedDuplicatePairs } from "../lib/get-contacts";
import { findPossibleDuplicates } from "../lib/duplicate-detection";
import { DuplicateContactsSection } from "./duplicate-contacts-section";

/**
 * SERVER Component (no "use client") — the previously-blocking half of the
 * Contacts page's initial render, now its own async unit so it can be
 * wrapped in a <Suspense> boundary at the call site
 * (app/(app)/contacts/page.tsx) instead of sitting in that page's own
 * Promise.all. The 300-row candidate fetch (getDuplicateCandidates) and
 * the Fuse.js pass over it (findPossibleDuplicates) were the single most
 * expensive piece of that page's server render (see the Phase 0
 * performance audit) — moving them here means ContactsPage's OWN
 * Promise.all only waits on getContactsPage + getVisibleTeamDirectory,
 * and this panel streams in afterward once it's ready, exactly the way
 * Next.js's streaming SSR is meant to be used for "this one section is
 * slower than the rest of the page."
 *
 * Deliberately a SUSPENSE boundary, not an on-demand ("click to check for
 * duplicates") trigger — the feature today is an ambient, always-shown-if-
 * present warning (DuplicateContactsSection renders nothing at all when
 * there are no pairs — see its own early return), never something a user
 * has to ask for. An on-demand trigger would be a real behavior change:
 * most users would never think to click a button for something they don't
 * yet know exists, silently turning a passive safety net into a tool
 * nobody discovers. Suspense keeps the exact same "it just appears" UX,
 * just no longer blocking everything else on the page while it computes.
 *
 * Resolves its own auth/membership rather than receiving them as props —
 * the same pattern every page-level Server Component already uses (see
 * ContactsPage's own identical note), applied one level deeper. Costs
 * nothing extra: createClient()/getAuthenticatedUser()/getCurrentMembership()
 * are all React cache()-memoized per request, so this reuses the exact
 * same resolved values ContactsPage itself already triggered, not a
 * second auth round-trip.
 */
export async function DuplicateContactsPanel() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  // Structurally unreachable in practice — app/(app)/layout.tsx and
  // ContactsPage itself both already redirect for a missing session/
  // membership before this component is ever reached. No redirect() of
  // its own here deliberately: this component can render after the page
  // shell has already started streaming to the client, and a redirect
  // fired mid-stream is a genuinely bad UX for a case that can't actually
  // happen — rendering nothing is the safe, inert fallback instead.
  if (!user) {
    return null;
  }
  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    return null;
  }

  const [duplicateCandidates, dismissedPairs] = await Promise.all([
    getDuplicateCandidates(supabase, membership.customer.id),
    getDismissedDuplicatePairs(supabase, membership.customer.id),
  ]);

  const duplicatePairs = findPossibleDuplicates(duplicateCandidates, dismissedPairs);

  return <DuplicateContactsSection initialPairs={duplicatePairs} />;
}
