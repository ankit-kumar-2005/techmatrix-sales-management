import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getAuthenticatedUser, getCurrentMembership } from "@/features/customers/lib/get-current-membership";
import { getVisibleTeamDirectory } from "@/features/leads/lib/get-team-directory";
import { getMeetingNotesPage } from "@/features/meeting-notes/lib/get-meeting-notes";
import { MeetingNotesForm } from "@/features/meeting-notes/components/meeting-notes-form";
import { MeetingNoteCard } from "@/features/meeting-notes/components/meeting-note-card";
import { MeetingNotesPager } from "@/features/meeting-notes/components/meeting-notes-pager";
import { MeetingNotesSearch } from "@/features/meeting-notes/components/meeting-notes-search";
import {
  MEETING_NOTES_DEFAULT_PAGE_SIZE,
  MEETING_NOTES_PAGE_SIZE_OPTIONS,
} from "@/features/meeting-notes/constants";
import { MeetingNotesIcon } from "@/features/sales-management/components/icons";

type MeetingNotesPageProps = {
  searchParams: Promise<{ page?: string; size?: string; q?: string }>;
};

/**
 * Meeting Notes: record a call, scan history, open the one you need.
 *
 * PAGINATION IS A REAL SERVER-SIDE LIMIT, not a client-side slice.
 * getMeetingNotesPage applies .range(from, to) with an exact count, so
 * page 3 of 10 fetches ten rows — never "load everything and hide the
 * rest", which is the mistake this project already paid for on Pipeline.
 * The page number lives in the URL, which is why this whole list stays a
 * Server Component: paging is a navigation, not a client fetch.
 *
 * WHO SEES WHICH NOTES IS ENTIRELY RLS. No role is passed and no role
 * filter applied — "hierarchy-aware meeting note visibility" evaluates
 * is_customer_user_visible(owner_id) for the real caller, so an ADMIN
 * sees the whole customer, a MANAGER/SENIOR_SALES_REP their own branch,
 * a SALES_REP only their own. There is not one role check on this page.
 */
export default async function MeetingNotesPage({ searchParams }: MeetingNotesPageProps) {
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

  // Both values come from the URL, so both are untrusted. size is
  // restricted to the offered options rather than clamped to a range —
  // otherwise "?size=1000" becomes an unbounded query through the front
  // door. page is floored at 0 here and re-clamped against the real
  // page count below, once that is known.
  const requestedSize = Number(params.size);
  const pageSize = (MEETING_NOTES_PAGE_SIZE_OPTIONS as readonly number[]).includes(requestedSize)
    ? requestedSize
    : MEETING_NOTES_DEFAULT_PAGE_SIZE;

  // Capped as well as floored. Without the cap, "?page=1000000000" is
  // accepted as a valid integer and issues one query with a ten-billion
  // row OFFSET before the out-of-range correction below can kick in.
  // Postgres answers that quickly on a small table, so it is not a
  // denial-of-service — but asking it at all is sloppy, and the cap
  // costs nothing. Any real page number is far below it; anything above
  // is clamped and then corrected to the last real page anyway.
  const MAX_PAGE_INDEX = 10_000;
  // The search term. Trimmed and length-capped: it goes straight into
  // an ILIKE pattern server-side, and an unbounded string from the URL
  // has no business being one. The RPC escapes % and _ itself.
  const search = (params.q ?? "").trim().slice(0, 200);

  const requestedPage = Number(params.page);
  const requestedPageIndex =
    Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, MAX_PAGE_INDEX) : 0;

  const [firstAttempt, owners] = await Promise.all([
    getMeetingNotesPage(supabase, membership.customer.id, { page: requestedPageIndex, pageSize, search }),
    getVisibleTeamDirectory(supabase),
  ]);

  const pageCount = Math.max(1, Math.ceil(firstAttempt.totalCount / pageSize));

  // A page number past the end (a stale bookmark, or notes deactivated
  // since) returns an empty range rather than an error. Re-fetching the
  // last real page is better than showing "0 notes" on a tenant that
  // has plenty — and it only ever costs a second query in that one case.
  const isOutOfRange = requestedPageIndex >= pageCount && firstAttempt.totalCount > 0;
  const currentPage = isOutOfRange ? pageCount - 1 : requestedPageIndex;
  const page = isOutOfRange
    ? await getMeetingNotesPage(supabase, membership.customer.id, { page: currentPage, pageSize, search })
    : firstAttempt;

  // Resolved ONCE here and threaded into every card, so every "overdue"
  // badge on the page agrees and no client clock can contradict the
  // server render.
  const todayIso = new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900 sm:text-3xl">Meeting notes</h1>
        <span
          aria-hidden="true"
          className="mt-2 block h-1 w-10 rounded-full bg-gradient-to-r from-blue-600 to-violet-600"
        />
        <p className="mt-1.5 text-sm text-neutral-500">
          AI-drafted summaries and action items from sales calls.
        </p>
      </div>

      <MeetingNotesForm />

      {/* "No notes at all" and "no notes match this search" are
          different states and must not share a message: the first
          invites you to create one, the second tells you to change the
          term. `search` is what distinguishes them — an empty result
          with a term is never "nothing exists yet". Same distinction
          ContactList's own empty state already draws. */}
      {page.notes.length === 0 && !search ? (
        <div className="rounded-2xl bg-white p-10 text-center shadow-sm ring-1 ring-black/5">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-50 to-violet-50 text-violet-600 ring-1 ring-violet-100">
            <MeetingNotesIcon className="h-6 w-6" />
          </span>
          <p className="mt-4 text-sm font-semibold text-neutral-900">No meeting notes yet</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-neutral-500">
            Paste a call transcript or upload a photo of your notes above. The AI drafts a summary and pulls out
            any action items it finds — you decide which become tasks.
          </p>
          {/* An anchor, not a button: the form is already on this page,
              so the only thing needed is to put it back in view. No
              client JS, and it works with the keyboard for free. */}
          <a
            href="#meeting-notes"
            className="mt-5 inline-flex min-h-10 items-center rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition-all hover:from-blue-700 hover:to-violet-700"
          >
            Add your first note
          </a>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-neutral-900">Recent notes</h2>
            <span className="text-xs font-medium text-neutral-500">
              {/* THE COUNT REFLECTS THE FILTERED RESULT, not the table.
                  totalCount comes from the same query that produced this
                  page — count: "exact" on the unsearched path, a
                  count(*) over () window on the search path — so it can
                  never disagree with what is listed. */}
              {page.totalCount} note{page.totalCount === 1 ? "" : "s"}
              {search ? " matching" : ""}
              {pageCount > 1 ? ` · page ${currentPage + 1} of ${pageCount}` : ""}
            </span>
          </div>

          <MeetingNotesSearch initialSearch={search} />

          {page.notes.length === 0 ? (
            <p className="rounded-2xl bg-white px-4 py-10 text-center text-sm text-neutral-500 shadow-sm ring-1 ring-black/5">
              No notes match <span className="font-semibold text-neutral-700">&ldquo;{search}&rdquo;</span>. Try a
              different title, a word from the summary, or an attendee&rsquo;s name.
            </p>
          ) : null}

          {page.notes.map((note, index) => (
            <MeetingNoteCard
              key={note.id}
              note={note}
              owners={owners}
              currentUserCustomerUserId={membership.membership.id}
              /* The newest note, and only on the first page. That keeps
                 the post-extraction review flow intact — you analyze,
                 and the thing you just created is already open — without
                 auto-expanding an arbitrary note halfway through
                 history, where "most recent" means nothing. */
              defaultExpanded={currentPage === 0 && index === 0}
              todayIso={todayIso}
            />
          ))}

          {/* ALWAYS RENDERED — never gated on pageCount > 1. It was
              gated, which is why it was invisible with a single note,
              and that was a deviation from this app's own convention:
              ContactList, TaskList and InvitationList all render their
              pager unconditionally, and their comments say outright that
              they REMOVED this exact gate because controls that vanish
              read as "there is no pagination" rather than "you are on
              the only page". The real `disabled` attribute on
              Previous/Next is what correctly makes the first and last
              page unreachable, and it also lets keyboard and
              screen-reader users skip them. The Rows Per Page selector
              in particular matters most when there is one page — it is
              how you find out whether there are more notes than fit. */}
          <MeetingNotesPager
            currentPage={currentPage}
            pageCount={pageCount}
            pageSize={pageSize}
            totalCount={page.totalCount}
          />
        </div>
      )}
    </div>
  );
}
