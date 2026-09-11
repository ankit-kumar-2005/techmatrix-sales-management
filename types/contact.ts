/** A row from public.contacts. Always linked to a Lead (lead_id) AND
 *  owned by a customer_user (owner_id) — two independent relationships;
 *  a Contact's owner does not have to be its Lead's owner. Visibility is
 *  derived entirely from owner_id via is_customer_user_visible, the same
 *  hierarchy-aware rule tasks.assigned_to already uses (see the contacts
 *  migration's design notes). */
export type Contact = {
  id: string;
  customer_id: string;
  lead_id: string;
  owner_id: string;
  name: string;
  company: string | null;
  title: string | null;
  email: string | null;
  phone: string | null;
  tags: string[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};
