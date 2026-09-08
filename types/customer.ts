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

export type CurrentMembership = {
  customer: Customer;
  membership: CustomerUser;
  role: CustomerRole;
  /** customer.created_by === the current user's id — a business
   *  designation, not a stored role. See CLAUDE.md / multi-tenant-security. */
  isPrimaryAdmin: boolean;
};
