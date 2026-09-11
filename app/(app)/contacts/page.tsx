import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getContactsPage, getDuplicateCandidates, getDismissedDuplicatePairs } from "@/features/contacts/lib/get-contacts";
import { findPossibleDuplicates } from "@/features/contacts/lib/duplicate-detection";
import { getLeadsForCustomer } from "@/features/leads/lib/get-leads";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { ContactsPageClient } from "@/features/contacts/components/contacts-page-client";

const INITIAL_PAGE_SIZE = 10;

type ContactsPageProps = {
  searchParams: Promise<{ q?: string; lead?: string }>;
};

/**
 * Auth + customer membership are already guarded by
 * app/(app)/layout.tsx before this page ever renders (see every other
 * page in this route group's own identical note) — this page only
 * fetches what it needs to display.
 *
 * Fetches page 1 of the Contacts list (already filtered by whatever
 * search the URL's own searchParams carry — see ContactList's own
 * comment for why), the full Lead list (same getLeadsForCustomer every
 * other Lead-picker in this app already uses), and the possible-
 * duplicates panel (a bounded, customer-scoped candidate fetch run
 * through Fuse.js, already filtered against contact_duplicate_
 * dismissals) — all in parallel. Everything below this is Client
 * Component interaction (search/pagination/dismissal), never requiring
 * a browser refresh to update.
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
    redirect("/signup");
  }

  const params = await searchParams;
  const initialSearch = params.q ?? "";
  // Not validated against the fetched `leads` array here (that would
  // mean awaiting getLeadsForCustomer before this query could even
  // start) — an invalid or cross-tenant id simply matches zero rows
  // (the query is already scoped to `customer_id`, and RLS's own
  // "hierarchy-aware contact visibility" policy is the real boundary
  // regardless), so there's no security reason to pre-check it and a
  // real performance reason not to serialize these two fetches.
  const initialLeadId = params.lead ?? "";

  const [initialPage, leads, assignableUsers, duplicateCandidates, dismissedPairs] = await Promise.all([
    getContactsPage(supabase, membership.customer.id, {
      search: initialSearch,
      leadId: initialLeadId,
      page: 0,
      pageSize: INITIAL_PAGE_SIZE,
    }),
    getLeadsForCustomer(supabase, membership.customer.id),
    getVisibleTeamDirectory(supabase),
    getDuplicateCandidates(supabase, membership.customer.id),
    getDismissedDuplicatePairs(supabase, membership.customer.id),
  ]);

  const duplicatePairs = findPossibleDuplicates(duplicateCandidates, dismissedPairs);

  return (
    <ContactsPageClient
      initialPage={initialPage}
      initialSearch={initialSearch}
      initialLeadId={initialLeadId}
      initialDuplicatePairs={duplicatePairs}
      leads={leads}
      assignableUsers={assignableUsers}
      currentUserCustomerUserId={membership.membership.id}
    />
  );
}
