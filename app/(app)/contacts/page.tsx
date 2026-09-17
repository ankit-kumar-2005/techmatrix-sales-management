import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthenticatedUser,
  getCurrentMembership,
  getNoMembershipRedirect,
} from "@/features/customers/lib/get-current-membership";
import { getContactsPage } from "@/features/contacts/lib/get-contacts";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { ContactsPageClient } from "@/features/contacts/components/contacts-page-client";

const INITIAL_PAGE_SIZE = 10;

type ContactsPageProps = {
  searchParams: Promise<{ q?: string }>;
};

/**
 * Auth + customer membership are already guarded by
 * app/(app)/layout.tsx before this page ever renders (see every other
 * page in this route group's own identical note) — this page only
 * fetches what it needs to display.
 *
 * Fetches page 1 of the Contacts list (already filtered by whatever
 * search the URL's own searchParams carry — see ContactList's own
 * comment for why). There is no separate Lead filter/picker any more —
 * the single search box matches contact/company fields and the linked
 * Lead's own name/company all at once (see getContactsPage's own
 * comment) — so this page no longer needs to fetch the customer's whole
 * Lead list up front for one either way. The Lead badge on each contact
 * row still resolves from getContactsPage's own `leadLabels`, bounded to
 * just this page's contacts, unaffected by the search change. Everything
 * below this is Client Component interaction (search/pagination/
 * dismissal), never requiring a browser refresh to update.
 *
 * The possible-duplicates panel (a bounded, customer-scoped candidate
 * fetch run through Fuse.js, already filtered against
 * contact_duplicate_dismissals) is deliberately NOT in this page's own
 * Promise.all anymore (Phase 7) — it was the single most expensive piece
 * of this page's render, and this page's own list doesn't need to wait on
 * it. See DuplicateContactsPanel's own comment for why a Suspense
 * boundary, not an on-demand trigger.
 */
export default async function ContactsPage({ searchParams }: ContactsPageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await getAuthenticatedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  const membership = await getCurrentMembership(supabase, user.id);
  if (!membership) {
    // /inactive for a DEACTIVATED member, /signup only for someone with
    // no membership row at all. One shared decision so this guard and
    // the (app) layout's cannot disagree — see getNoMembershipRedirect.
    redirect(await getNoMembershipRedirect(supabase, user.id));
  }

  const params = await searchParams;
  const initialSearch = params.q ?? "";

  const [initialPage, assignableUsers] = await Promise.all([
    getContactsPage(supabase, membership.customer.id, {
      search: initialSearch,
      page: 0,
      pageSize: INITIAL_PAGE_SIZE,
    }),
    getVisibleTeamDirectory(supabase),
  ]);

  return (
    <ContactsPageClient
      initialPage={initialPage}
      initialSearch={initialSearch}
      assignableUsers={assignableUsers}
      currentUserCustomerUserId={membership.membership.id}
      // Possible-duplicates panel intentionally disabled for now (soft
      // removal — the feature itself is untouched, just not called or
      // rendered here). Was:
      //   <Suspense fallback={null}><DuplicateContactsPanel /></Suspense>
      // Re-enable by restoring that. Underlying code left as-is:
      // DuplicateContactsPanel, DuplicateContactsSection,
      // getDuplicateCandidates, getDismissedDuplicatePairs,
      // duplicate-detection.ts, and the contact_duplicate_dismissals
      // table/migration.
      duplicatesPanel={null}
    />
  );
}
