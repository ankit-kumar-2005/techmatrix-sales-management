import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getContactsPage } from "@/features/contacts/lib/get-contacts";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { ContactsPageClient } from "@/features/contacts/components/contacts-page-client";
import { DuplicateContactsPanel } from "@/features/contacts/components/duplicate-contacts-panel";

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
 * comment for why). The Lead picker/filter and the Lead badge on each
 * contact row no longer need this page to fetch the customer's whole
 * Lead list up front — LeadSearchSelect searches server-side itself
 * (searchLeadsAction), and getContactsPage's own `leadLabels` already
 * comes back bounded to just this page's contacts. Everything below this
 * is Client Component interaction (search/pagination/dismissal), never
 * requiring a browser refresh to update.
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

  const [initialPage, assignableUsers] = await Promise.all([
    getContactsPage(supabase, membership.customer.id, {
      search: initialSearch,
      leadId: initialLeadId,
      page: 0,
      pageSize: INITIAL_PAGE_SIZE,
    }),
    getVisibleTeamDirectory(supabase),
  ]);

  return (
    <ContactsPageClient
      initialPage={initialPage}
      initialSearch={initialSearch}
      initialLeadId={initialLeadId}
      assignableUsers={assignableUsers}
      currentUserCustomerUserId={membership.membership.id}
      duplicatesPanel={
        // fallback={null}: DuplicateContactsSection itself renders
        // nothing when there are no pairs (the common case), so a
        // skeleton here would usually just flash and then disappear —
        // worse than the panel silently popping in only when there's
        // real content, matching the "no placeholder for an often-empty
        // panel" reasoning already established for this same section in
        // Phase 1's loading.tsx.
        <Suspense fallback={null}>
          <DuplicateContactsPanel />
        </Suspense>
      }
    />
  );
}
