/**
 * EVERY NUMERIC LIMIT THE MCP SERVER ENFORCES — and the only place any of
 * them is written down. Same discipline as
 * features/automations/config/safeguards.ts: code elsewhere imports these
 * names, tests import these names, docs/mcp.md cites these names. Raising
 * a limit is a one-line change here, never a hunt.
 */

/** Most rows a search tool returns in one call. */
export const MCP_MAX_RESULTS_PER_CALL = 50;

/** Rows a search tool returns when the caller does not ask for a number. */
export const MCP_DEFAULT_RESULTS_PER_CALL = 20;

/** Most filter conditions one search may carry. */
export const MCP_MAX_FILTER_CONDITIONS = 8;

/** Most values one `in` filter may list. */
export const MCP_MAX_IN_VALUES = 25;

/** Longest text value accepted in a filter. */
export const MCP_MAX_FILTER_TEXT_LENGTH = 200;

/** Most related tasks/contacts get_lead returns alongside a lead. */
export const MCP_MAX_RELATED_RECORDS = 25;

/**
 * Per-person rate limit: at most MCP_RATE_LIMIT_MAX_CALLS tool calls in
 * any rolling MCP_RATE_LIMIT_WINDOW_SECONDS window. Counted from
 * mcp_audit_log in Postgres — serverless instance memory is not shared
 * between instances, so an in-memory counter would not be a limit at all.
 */
export const MCP_RATE_LIMIT_MAX_CALLS = 60;
export const MCP_RATE_LIMIT_WINDOW_SECONDS = 60;

/** A tool call that has not finished in this time is abandoned with an
 *  error. Kept well under the route's maxDuration (app/api/mcp/route.ts)
 *  so the audit row still gets written. */
export const MCP_TOOL_TIMEOUT_MS = 20_000;

/** Upper bound on one MCP HTTP request body. Tool arguments are small;
 *  anything near this is not a legitimate call. */
export const MCP_MAX_REQUEST_BODY_BYTES = 256 * 1024;

/** mcp_audit_log and mcp_idempotency_keys rows older than this are
 *  removed by the operator cleanup in docs/mcp.md ("Audit retention"). */
export const MCP_AUDIT_RETENTION_DAYS = 90;

/** last_used_at is refreshed at most this often per connection, so a busy
 *  session does not write the same row on every call. */
export const MCP_LAST_USED_TOUCH_INTERVAL_SECONDS = 300;

/** Bounds on a client-supplied idempotency key (matches the CHECK on
 *  mcp_idempotency_keys.idempotency_key). */
export const MCP_IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const MCP_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** A reservation still "pending" after this long is treated as abandoned
 *  (the server stopped mid-request). It is NOT retried automatically —
 *  the create may have completed — the caller is told to check and use a
 *  new key. */
export const MCP_IDEMPOTENCY_STALE_PENDING_MINUTES = 15;

/** Rows shown in Settings → AI Connections → Recent activity. */
export const MCP_ADMIN_ACTIVITY_ROWS = 25;

/**
 * OAuth signing-key (JWKS) cache, used by token verification:
 *   - keys are re-downloaded at most every MCP_JWKS_CACHE_TTL_SECONDS;
 *   - a token naming an unknown key id triggers at most ONE extra
 *     download per MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS, across all
 *     requests, so random key ids cannot force a download per request;
 *   - if a download fails, already-downloaded keys keep working for at
 *     most MCP_JWKS_MAX_STALE_SECONDS after their last successful
 *     download; after that every token is refused until a download works.
 */
export const MCP_JWKS_CACHE_TTL_SECONDS = 600;
export const MCP_JWKS_UNKNOWN_KID_REFRESH_SECONDS = 60;
export const MCP_JWKS_MAX_STALE_SECONDS = 3600;
/** A JWKS with more keys than this is rejected as malformed. */
export const MCP_JWKS_MAX_KEYS = 20;
