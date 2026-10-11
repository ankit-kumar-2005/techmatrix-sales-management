export type CustomerRole = "ADMIN" | "MANAGER" | "SENIOR_SALES_REP" | "SALES_REP";
export type RecordStatus = "Active" | "Inactive";

export type Customer = {
  id: string;
  /** The name collected at signup from the person who registered this
   *  customer — displayed as "Client Name" in Company Information.
   *  Nullable: rows created before this field existed have no value. */
  name: string | null;
  company_name: string | null;
  email: string;
  phone: string;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  created_by: string;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
};

export type CustomerUser = {
  id: string;
  customer_id: string;
  user_id: string;
  /** This member's own name, copied from the signup Name field the
   *  moment their customer_users row was created. Nullable for the same
   *  reason as customers.name. */
  name: string | null;
  role_id: string;
  manager_id: string | null;
  status: RecordStatus;
  created_at: string;
  updated_at: string;
};

/** What getCurrentMembership actually selects for `customer` — every
 *  Customer field CompanyInformationForm reads (it receives
 *  `membership.customer` directly as a prop) plus `created_by`, needed
 *  internally to compute `isPrimaryAdmin` below. `status`/`created_at`/
 *  `updated_at` are confirmed unused by any consumer anywhere in the app
 *  (Phase 3 column projection) and intentionally excluded — if a future
 *  consumer needs one of them, add it back here AND to
 *  getCurrentMembership's own select list together, so the two can never
 *  drift apart. */
export type CurrentMembershipCustomer = Pick<
  Customer,
  "id" | "name" | "company_name" | "email" | "phone" | "website" | "address" | "city" | "state" | "country" | "created_by"
>;

/** What getCurrentMembership actually selects for `membership` — every
 *  CustomerUser field read anywhere in the app (Settings → Profile,
 *  every `currentUserCustomerUserId` consumer). `user_id` is dropped:
 *  it's only ever used as a query FILTER (`.eq("user_id", userId)`),
 *  never read from the result. `customer_id`/`role_id` are kept even
 *  though no consumer reads them directly — see getCurrentMembership's
 *  own comment on why those two specifically are left in. */
export type CurrentMembershipUser = Pick<
  CustomerUser,
  "id" | "customer_id" | "role_id" | "name" | "manager_id" | "status" | "created_at" | "updated_at"
>;

export type CurrentMembership = {
  customer: CurrentMembershipCustomer;
  membership: CurrentMembershipUser;
  role: CustomerRole;
  /** customer.created_by === the current user's id — a business
   *  designation, not a stored role. See CLAUDE.md / multi-tenant-security. */
  isPrimaryAdmin: boolean;
};

/**
 * Who is performing a domain write, as the domain services in
 * features/leads|tasks|contacts/lib/*-service.ts need it. Always built
 * SERVER-SIDE from a verified session plus the live membership row —
 * by a Server Action from the cookie session, or by the MCP server from
 * the bearer token — never from anything a client sent.
 */
export type DomainActor = {
  /** auth.users id */
  userId: string;
  customerId: string;
  /** customer_users id */
  customerUserId: string;
  role: CustomerRole;
};

/** The one result shape every domain write returns. Each caller maps it
 *  to its own surface (form state for Server Actions, an MCP tool error
 *  for the MCP server); the messages are the exact strings the UI has
 *  always shown. `not_found` is used both when a record does not exist
 *  and when RLS hides it — the two are deliberately indistinguishable. */
export type DomainWriteResult =
  | { ok: true; id: string | null }
  | { ok: false; kind: "invalid"; fieldErrors: Record<string, string> }
  | { ok: false; kind: "not_found" | "forbidden" | "conflict" | "failed"; message: string };
