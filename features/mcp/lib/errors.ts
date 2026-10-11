/**
 * The only error codes an MCP tool ever returns, and the only messages.
 *
 * SAFE BY CONSTRUCTION: a tool never forwards a raw Postgres or Supabase
 * error. `not_found` is returned identically for a record that does not
 * exist and for one RLS hides from the caller, so no response can confirm
 * that another person's or another company's record exists.
 */
export type McpErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "tool_disabled"
  | "rate_limited"
  | "conflict"
  | "access_denied"
  | "timeout"
  | "internal_error";

export class McpToolError extends Error {
  readonly code: McpErrorCode;

  constructor(code: McpErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "McpToolError";
  }
}

export const NOT_FOUND_MESSAGE = "No matching record was found, or you don't have access to it.";

export function notFound(): McpToolError {
  return new McpToolError("not_found", NOT_FOUND_MESSAGE);
}

export function invalidInput(message: string): McpToolError {
  return new McpToolError("invalid_input", message);
}
