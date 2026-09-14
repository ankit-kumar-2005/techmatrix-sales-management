import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CustomerUserInvitation,
  InvitationMembershipStatus,
  InvitationStatus,
} from "@/types/invitation";

/** What the Invitation History list actually renders, traced field by
 *  field against the specified columns (Name / Email / Role / Manager /
 *  Membership Status / Invitation Status, plus the three timestamps the
 *  resend UI needs) — the same Pick<>-narrowed projection discipline
 *  ContactListItem/TaskListItem already follow, so a column nothing
 *  displays never leaves the database. customer_id (filtered on),
 *  invited_by, created_at and updated_at are all deliberately not
 *  selected. */
type InvitationRow = Pick<
  CustomerUserInvitation,
  | "id"
  | "email"
  | "full_name"
  | "role_id"
  | "manager_id"
  | "status"
  | "invited_at"
  | "last_sent_at"
  | "expires_at"
  | "accepted_customer_user_id"
>;

export type InvitationListItem = InvitationRow & {
  /** roles.name, resolved by a bounded follow-up lookup (see below).
   *  Null only if the role row somehow can't be read. */
  roleName: string | null;
  /** customer_users.name for manager_id. Null when there's no manager,
   *  or when that membership has no name recorded. */
  managerName: string | null;
  /** Read LIVE from customer_users through accepted_customer_user_id —
   *  never a copy stored on the invitation. "Not yet a member" is the
   *  absence of that link, not a stored value. */
  membershipStatus: InvitationMembershipStatus;
  /** `status` is what the row literally stores; this is what the user
   *  should see. A PENDING invitation whose expires_at has passed is
   *  effectively EXPIRED even though nothing has written that to the row
   *  yet (there is no cron — see the migration). Every authoritative
   *  decision still uses the stored status plus the clock, server-side;
   *  this exists only so the list doesn't show a dead invitation as
   *  live. */
  effectiveStatus: InvitationStatus;
};

export type InvitationsPageParams = {
  /** Matches full_name OR email, case-insensitively — "" means no
   *  search filter. */
  search: string;
  /** "" means every status. Applied SERVER-SIDE, and it filters on the
   *  status the user actually sees (effectiveStatus), not just the
   *  stored column: "Pending" means stored PENDING that hasn't run out
   *  of time yet, and "Expired" means stored PENDING that has. Without
   *  that, the Pending filter would list invitations the same table
   *  renders as Expired one column over.
   *
   *  Expressed as two ordinary filters rather than a PostgREST `.or()`
   *  with a nested `and(...)`, deliberately: nothing in this codebase
   *  ever writes the literal 'EXPIRED' status (create/resend write
   *  PENDING, cancel writes CANCELLED, acceptance writes ACCEPTED, and
   *  no sweep job exists — see the migration), so the simple form is
   *  exactly equivalent today and avoids hand-building a nested filter
   *  expression that can't be verified without a database. If a sweep
   *  job is ever added that writes 'EXPIRED', this is the one place
   *  that has to grow an OR. */
  status: InvitationStatus | "";
  page: number;
  pageSize: number;
};

export type InvitationsPage = {
  invitations: InvitationListItem[];
  /** Total rows matching the current search (not just this page) — from
   *  the same `{ count: "exact" }` request as the row fetch, what the
   *  page count and Previous/Next disabled states are computed from,
   *  exactly as in getContactsPage. */
  totalCount: number;
};

// PostgREST's `.or(...)` takes a small filter-expression DSL as a plain
// string; `,` and `(`/`)` are that DSL's own delimiters, so a search term
// containing them is stripped down to spaces first — same helper shape
// and same reasoning as getContactsPage's and getTasksBucketPage's own
// copies (this project keeps one per query module rather than sharing
// it, since each one's escaping is part of that query's own contract).
function toSafeOrSearchTerm(value: string): string {
  return value.replace(/[,()]/g, " ").trim();
}

function resolveEffectiveStatus(status: InvitationStatus, expiresAt: string): InvitationStatus {
  if (status === "PENDING" && new Date(expiresAt).getTime() <= Date.now()) {
    return "EXPIRED";
  }
  return status;
}

/**
 * Server-side only: exactly one page of one customer's invitations,
 * newest first — a real `.range(from, to)` request against Postgres,
 * never the full table sliced in JS, the same shape getContactsPage and
 * getTasksBucketPage already use. RLS ("admins can view their customer's
 * invitations") is the enforcing layer for WHO may read these at all;
 * the explicit `.eq("customer_id", ...)` alongside it is the same
 * belt-and-suspenders scoping every other query in this app applies.
 *
 * WHY THE TWO FOLLOW-UP LOOKUPS INSTEAD OF A POSTGREST EMBED: this table
 * has two foreign keys into customer_users (manager_id and
 * accepted_customer_user_id), so an embed would have to be disambiguated
 * by constraint name, and both are COMPOSITE (customer_id, col) keys
 * whose embedding support varies by PostgREST version — untestable from
 * here with no database access. These two bounded `.in(...)` lookups are
 * the approach the migration review called for instead: they need no
 * schema change, resolve at most `pageSize` distinct ids each, and reuse
 * the exact pattern getLeadLabelsByIds already established for "I have a
 * page of rows and need to label the handful of records they reference."
 * Both are covered by existing RLS (roles is readable by any
 * authenticated user; customer_users by any member of that customer), so
 * neither widens what the caller can see.
 *
 * Ordering is invited_at DESC with id DESC as a tiebreaker — without the
 * tiebreaker, two invitations created inside one transaction share an
 * identical now() and could swap places between pages.
 */
export async function getInvitationsPage(
  supabase: SupabaseClient,
  customerId: string,
  params: InvitationsPageParams,
): Promise<InvitationsPage> {
  const { search, status, page, pageSize } = params;
  const from = page * pageSize;
  const to = from + pageSize - 1;

  let query = supabase
    .from("customer_user_invitations")
    .select(
      "id, email, full_name, role_id, manager_id, status, invited_at, last_sent_at, expires_at, accepted_customer_user_id",
      { count: "exact" },
    )
    .eq("customer_id", customerId);

  if (status) {
    const nowIso = new Date().toISOString();
    if (status === "PENDING") {
      query = query.eq("status", "PENDING").gt("expires_at", nowIso);
    } else if (status === "EXPIRED") {
      query = query.eq("status", "PENDING").lte("expires_at", nowIso);
    } else {
      query = query.eq("status", status);
    }
  }

  const safeSearch = toSafeOrSearchTerm(search);
  if (safeSearch) {
    query = query.or([`full_name.ilike.%${safeSearch}%`, `email.ilike.%${safeSearch}%`].join(","));
  }

  const { data, error, count } = await query
    .order("invited_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (error || !data) {
    return { invitations: [], totalCount: 0 };
  }

  const rows = data as InvitationRow[];
  if (rows.length === 0) {
    return { invitations: [], totalCount: count ?? 0 };
  }

  // Both lookups are bounded to THIS page's own referenced ids (≤
  // pageSize distinct each), never the customer's whole roles or
  // customer_users table.
  const roleIds = Array.from(new Set(rows.map((row) => row.role_id)));
  const membershipIds = Array.from(
    new Set(
      rows
        .flatMap((row) => [row.manager_id, row.accepted_customer_user_id])
        .filter((id): id is string => Boolean(id)),
    ),
  );

  const [rolesResult, membershipsResult] = await Promise.all([
    supabase.from("roles").select("id, name").in("id", roleIds),
    membershipIds.length > 0
      ? supabase
          .from("customer_users")
          .select("id, name, status")
          .eq("customer_id", customerId)
          .in("id", membershipIds)
      : Promise.resolve({ data: [] as { id: string; name: string | null; status: string }[], error: null }),
  ]);

  const roleNameById = new Map<string, string>(
    ((rolesResult.data ?? []) as { id: string; name: string }[]).map((role) => [role.id, role.name]),
  );
  const membershipById = new Map<string, { name: string | null; status: string }>(
    ((membershipsResult.data ?? []) as { id: string; name: string | null; status: string }[]).map((member) => [
      member.id,
      { name: member.name, status: member.status },
    ]),
  );

  const invitations: InvitationListItem[] = rows.map((row) => {
    const membership = row.accepted_customer_user_id
      ? membershipById.get(row.accepted_customer_user_id)
      : undefined;

    return {
      ...row,
      roleName: roleNameById.get(row.role_id) ?? null,
      managerName: row.manager_id ? (membershipById.get(row.manager_id)?.name ?? null) : null,
      membershipStatus:
        membership?.status === "Active"
          ? "Active"
          : membership?.status === "Inactive"
            ? "Inactive"
            : "Not yet a member",
      effectiveStatus: resolveEffectiveStatus(row.status, row.expires_at),
    };
  });

  return { invitations, totalCount: count ?? 0 };
}

/**
 * The resend/duplicate path's own lookup: the single PENDING invitation
 * for this customer + email, if one exists. Normalized the same way the
 * database's own unique index is (lower(btrim(...))), so "John@X.com"
 * finds the invitation created for "  john@x.com". Returns the whole row
 * because the caller needs last_sent_at (cooldown) and expires_at
 * (revival) from it, not just its id.
 */
export async function findPendingInvitationByEmail(
  supabase: SupabaseClient,
  customerId: string,
  email: string,
): Promise<Pick<CustomerUserInvitation, "id" | "email" | "full_name" | "status" | "last_sent_at" | "expires_at"> | null> {
  const normalized = email.trim().toLowerCase();

  const { data, error } = await supabase
    .from("customer_user_invitations")
    .select("id, email, full_name, status, last_sent_at, expires_at")
    .eq("customer_id", customerId)
    .eq("status", "PENDING")
    .ilike("email", normalized);

  if (error || !data || data.length === 0) {
    return null;
  }

  // .ilike() is case-insensitive but not whitespace-insensitive, so the
  // final match is made here against the same lower(btrim(...)) rule the
  // unique index uses — a stored "  john@x.com " still matches.
  const match = (
    data as Pick<CustomerUserInvitation, "id" | "email" | "full_name" | "status" | "last_sent_at" | "expires_at">[]
  ).find((row) => row.email.trim().toLowerCase() === normalized);

  return match ?? null;
}
