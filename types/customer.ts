export type CustomerRole = "ADMIN" | "MANAGER" | "SENIOR_SALES_REP" | "SALES_REP";
export type RecordStatus = "Active" | "Inactive";

export type Customer = {
  id: string;
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
