/**
 * The only source this phase ships — and THE ONLY PLACE the set of
 * sources is closed.
 *
 * customer_integrations.source is deliberately plain `text` with no
 * CHECK constraint, so adding JustDial or TradeIndia is inserting a row
 * and never a migration (see design note 9 in the Lead Capture
 * migration). The constraint lives here instead, in the layer that
 * actually has to learn how to parse a new source's payload — which is
 * the work that gates adding one, not the storage.
 */
export const INTEGRATION_SOURCES = ["IndiaMART"] as const;
export type IntegrationSource = (typeof INTEGRATION_SOURCES)[number];

export const ASSIGNMENT_MODES = ["Fixed", "RoundRobin"] as const;
export type AssignmentMode = (typeof ASSIGNMENT_MODES)[number];

export type CustomerIntegration = {
  id: string;
  customer_id: string;
  source: IntegrationSource;
  /** A BEARER SECRET. Whoever holds it can post leads into this tenant,
   *  which is why customer_integrations is admin-only for SELECT as
   *  well as for writes — see the migration's design note 3. Never log
   *  it, never put it in a URL that gets recorded, never hand it to a
   *  non-admin. */
  webhook_token: string;
  status: "Active" | "Inactive";
  default_stage_id: string | null;
  assignment_mode: AssignmentMode;
  default_owner_id: string | null;
  last_assigned_owner_id: string | null;
  created_at: string;
  updated_at: string;
};

export type IntegrationParticipant = {
  id: string;
  customer_id: string;
  integration_id: string;
  customer_user_id: string;
  created_at: string;
};

/** One row of the "Recently Captured" feed. */
export type CapturedLead = {
  id: string;
  company: string;
  contact_name: string;
  owner_id: string | null;
  created_at: string;
};

/**
 * Everything the Lead Capture page renders, resolved in one place.
 *
 * `integration` is null before an admin has ever set the source up —
 * the page then shows a "Not connected" card with a Connect action,
 * rather than creating a row (and therefore a live webhook token) just
 * because somebody opened the settings page.
 */
export type LeadCaptureOverview = {
  integration: CustomerIntegration | null;
  participantIds: string[];
  /** Counts come from SQL aggregation over `leads`, never cached and
   *  never computed by fetching rows and counting in JS. */
  todayCount: number;
  weekCount: number;
  /** created_at of the newest lead from this source, or null. */
  lastReceivedAt: string | null;
  recent: CapturedLead[];
};
