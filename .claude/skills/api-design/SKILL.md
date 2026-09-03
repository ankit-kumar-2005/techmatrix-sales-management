---
name: api-design
description: Route Handler and API design conventions for this project — REST design, request validation with Zod, authentication, authorization, the service layer, response structures, HTTP status codes, and error handling. Use whenever designing or reviewing app/api routes or Server Actions.
---

# API Design

This is the deep reference behind `CLAUDE.md` Sections I, J, and K. Read those first for the
binding rules — this document explains the reasoning and gives concrete patterns.

## The request flow, every time

```
Request → Authentication → Authorization → Validation → Service → Database → Response
```

No step skipped, no step reordered, for any Route Handler or Server Action that touches
protected data. This flow exists so that a security check is never accidentally bypassed by
being implemented "after" the operation that needed it.

## Route Handlers stay thin

A Route Handler's job: parse the request, authenticate, authorize (or delegate authorization
to the service), validate input, call one service function, map the result to a response.
Nothing else.

```ts
// app/api/leads/[id]/route.ts
export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const supabase = createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return apiError(401, "UNAUTHENTICATED");

  const body = await request.json();
  const parsed = updateLeadSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "VALIDATION_ERROR", parsed.error.flatten());

  const result = await leadsService.updateLead(supabase, user, params.id, parsed.data);
  if (result.error) return apiError(result.status, result.code);
  return Response.json(result.data);
}
```

All the actual business logic (does this lead belong to the user's org, is the user allowed
to change this field, what happens on status transition) lives in `leadsService.updateLead`,
not inline in the handler.

## REST shape

- Resource-oriented paths: `app/api/leads/route.ts` (collection: `GET` list, `POST` create),
  `app/api/leads/[id]/route.ts` (item: `GET`, `PATCH`, `DELETE`).
- Use the HTTP method to express the operation, not the path (`POST /api/leads/create` is
  redundant — `POST /api/leads` already means create).

## Status codes

| Code | Meaning here |
|---|---|
| `200` | Successful read/update |
| `201` | Successful creation |
| `204` | Successful delete with no body |
| `400` | Validation error — malformed/invalid input |
| `401` | No valid session |
| `403` | Authenticated but not permitted |
| `404` | Resource doesn't exist, or its existence is itself sensitive (see below) |
| `409` | Conflict (e.g., unique constraint violation) |
| `500` | Unexpected server error |

Prefer `404` over `403` when the *existence* of a resource is sensitive — e.g., a lead ID
belonging to another organization should 404, not 403, so a caller can't use the status code
to enumerate other organizations' resource IDs.

## Consistent response shape

Pick one envelope and use it everywhere Route Handlers respond, e.g.:

```ts
// success
{ data: T }

// error
{ error: { code: string; message: string; details?: unknown } }
```

The exact shape is decided when the first Route Handler is built (see `/plan-feature` for
that decision) and then followed consistently — this matters more for the future mobile
client than for this app alone, since it will be parsing the same responses.

## Validation with Zod

- Every Route Handler and Server Action validates its input with Zod before doing anything
  else with it — no exceptions for "trusted" internal callers, since the boundary is the
  HTTP/Action boundary itself, not who's expected to call it.
- Share schemas between client (React Hook Form resolver) and server (Route
  Handler/Action/service) — one schema per operation, imported both places, so client and
  server validation can't silently diverge.
- Derive TypeScript types from schemas (`z.infer<typeof createLeadSchema>`) instead of hand-
  writing a parallel type.

```ts
// features/leads/schemas.ts
export const createLeadSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  status: z.enum(["new", "qualified", "won", "lost"]),
});
export type CreateLeadInput = z.infer<typeof createLeadSchema>;
```

## Authentication and authorization in the flow

- Authentication: resolve the current user from the session via the server Supabase client —
  never from a client-supplied user ID.
- Authorization: resolve the user's organization membership and role, then check it against
  what the operation requires, in the service layer — see the `multi-tenant-security` skill.
  This check happens even though RLS will also enforce it; both layers matter (see
  `CLAUDE.md` Section G).

## Error handling

- Validation errors return field-level detail (from Zod's issues) — enough for a client to
  fix the input.
- Auth/authz errors return a generic message — no detail about *why* beyond
  unauthenticated/unauthorized, per `CLAUDE.md` Section K.
- Database errors are never surfaced raw (no constraint names, no query text) — log
  server-side, map known cases (e.g., unique violation → `409`), return a generic message for
  everything else.
- Every Route Handler's unhandled-error path still returns the same consistent error
  envelope — never let an uncaught exception produce Next.js's default error output.
