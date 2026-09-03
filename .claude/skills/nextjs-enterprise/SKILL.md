---
name: nextjs-enterprise
description: Enterprise-grade Next.js App Router conventions for this project — Server/Client Component boundaries, Route Handlers, Server Actions, layouts, route groups, loading/error states, caching, and performance. Use whenever writing or reviewing anything under app/.
---

# Next.js Enterprise (App Router)

This project uses Next.js 16+ with the App Router exclusively. This skill is the deep
reference behind `CLAUDE.md` Section D; read that section first for the binding rules — this
document explains the reasoning and gives concrete patterns.

## Server Components by default

Every file under `app/` and every component it renders starts as a Server Component. Add
`"use client"` only when the component needs:

- Event handlers (`onClick`, `onChange`, etc.)
- State (`useState`, `useReducer`) or effects (`useEffect`)
- Browser-only APIs (`window`, `localStorage`, etc.)
- Third-party libraries that themselves require the client

**Push `"use client"` to the leaves.** A page needing one interactive widget doesn't become a
Client Component — extract the interactive part into its own small component, mark only that
one `"use client"`, and pass server-fetched data into it as props.

```tsx
// app/leads/page.tsx — stays a Server Component
export default async function LeadsPage() {
  const leads = await getLeads(); // server-side, via the service layer
  return <LeadsTable initialData={leads} />; // LeadsTable is the client leaf
}
```

```tsx
// features/leads/components/leads-table.tsx
"use client";
export function LeadsTable({ initialData }: { initialData: Lead[] }) {
  // interactive table state lives here
}
```

## Server/client boundary hygiene

- Never import a module that touches `SUPABASE_SERVICE_ROLE_KEY`, filesystem/Node-only APIs,
  or other server secrets from a file that a Client Component could import — the bundler will
  happily pull it into the client bundle if the import chain allows it.
- Keep `lib/supabase/server.ts` (and any service-role client) out of anything reachable from
  `"use client"` files. `lib/supabase/client.ts` is the only Supabase client a Client
  Component may import.
- If a value must reach the client, pass it explicitly as a prop from a Server Component —
  don't import a server module into a client file "just for one constant."

## Route Handlers (`app/api/**/route.ts`)

Use for: webhooks, endpoints the future mobile app will call, third-party integrations, file
export/downloads — anything that needs to be callable outside a React render.

Keep them thin — parse/authenticate/validate, call a service function, map the result to a
response:

```ts
// app/api/leads/route.ts
export async function POST(request: Request) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json();
  const parsed = createLeadSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const result = await leadsService.createLead(supabase, user, parsed.data);
  return Response.json(result, { status: 201 });
}
```

No business logic inline in the handler — that lives in `leadsService`.

## Server Actions

Use for this app's own form mutations where a separate REST surface isn't otherwise needed.
Same validation/authorization discipline as a Route Handler — a Server Action is still an
untrusted-input boundary, not an internal function call.

```ts
"use server";
export async function createLeadAction(formData: FormData) {
  const parsed = createLeadSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: parsed.error.flatten() };
  // authenticate, authorize, delegate to the service layer — same as a Route Handler
}
```

If the future mobile app will also need to trigger this operation, put the logic in a service
function callable from a Route Handler, and have the Server Action call that same service
rather than duplicating logic.

## Layouts, loading, error, not-found

- **`layout.tsx`** — structure shared across a route subtree (nav, shell chrome). Not a place
  for page-specific data fetching.
- **`loading.tsx`** — a route-level Suspense fallback for segments with real async work. Skip
  it for routes with no meaningful async boundary — an unnecessary skeleton flash is worse
  than none.
- **`error.tsx`** — a Client Component boundary for recoverable render/data errors in a
  segment. Give it a real recovery affordance (retry, link back) where practical, not just a
  static message.
- **`not-found.tsx`** — for genuine "this resource doesn't exist," triggered via `notFound()`.
  Not for auth/permission failures, which are `401`/`403` cases handled separately (see the
  `api-design` skill and `CLAUDE.md` Section K).

## Route groups and dynamic routes

- Route groups (`(group)`) organize routing without affecting the URL — use them to separate
  concerns like an authenticated app shell from public/marketing/auth routes, not as a
  catch-all organizing device.
- Dynamic segments (`[id]`) must be validated and authorized server-side before use — treat
  every dynamic segment as attacker-controlled input. Resolving `app/leads/[id]/page.tsx`
  means fetching the lead through the service layer (which enforces org/role scoping), not
  trusting that the ID belongs to the current user's organization just because it's in the
  URL.

## Caching and performance

- Prefer Server Components fetching data directly over adding an internal API round-trip.
- Use dynamic imports for heavy, rarely-needed client bundles (rich editors, large chart
  libraries, CSV import dialogs).
- Be deliberate about Next.js's caching behavior for fetches/route segments — default to
  correctness (fresh data for per-user, per-org data) over caching aggressively; only opt into
  longer caching for data that's genuinely shared/static across users.
- See `CLAUDE.md` Section O and the `database-design` skill for pushing pagination/filtering/
  sorting to the database rather than loading full datasets client-side.
