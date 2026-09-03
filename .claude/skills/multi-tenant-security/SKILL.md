---
name: multi-tenant-security
description: HIGH PRIORITY — tenant isolation, organization_id, roles, permissions, authorization, RLS, and organization membership. Load this skill whenever database access, authorization, RLS, organization_id, or user roles change, in addition to normal review.
---

# Multi-Tenant Security

**This skill is HIGH PRIORITY.** Treat it as required reading whenever a change touches:
database access, authorization logic, RLS policies, `organization_id`, or user roles — even
if that's not the main point of the change. This expands on `CLAUDE.md` Section G, the
single highest-priority section in that document.

## The core guarantee

**Organization A must never be able to access Organization B's data — under any
circumstance.** Not through a missing `WHERE` clause, not through a forgotten RLS policy, not
through a Route Handler that trusts a client-supplied `organization_id`, not through a bug
elsewhere in the stack. This is the one guarantee that, if violated, is a severe incident
regardless of how it happened.

## Conceptual model

```
Organization
    |
    ├── Users (via organization membership — a user can conceptually belong to more than one org)
    ├── Leads
    ├── Contacts
    ├── Tasks
    └── Opportunities
```

Every tenant-owned table carries an `organization_id` foreign key. A user's role
(Admin/Manager/Salesperson) is a property of their *membership* in an organization, not a
global property of the user — plan for a user potentially belonging to more than one
organization even if the current UI doesn't yet support switching between them.

## Defense in depth — never rely on just one layer

Tenant isolation must be enforced by the combination of all of these, not any single one:

1. **PostgreSQL schema** — `organization_id` present, non-null, foreign-keyed, and indexed on
   every tenant-owned table.
2. **RLS policies** — every tenant-owned table scopes every operation to the caller's
   organization membership. This is the layer that holds even if application code has a bug.
3. **Server-side authorization** — the service layer independently confirms the acting user
   belongs to the organization (and holds the required role) for the operation, before or
   alongside relying on RLS. This is the layer that holds even if a policy is ever
   misconfigured.
4. **Application-level authorization** — anything RLS can't fully express (e.g., a
   field-level rule, a cross-table invariant) enforced explicitly in the service layer.

**Never rely on frontend filtering alone.** A client-side `WHERE organization_id = ...` or a
UI that simply doesn't render another org's data is not isolation — it's cosmetic. An
attacker calling the API/database directly bypasses it entirely.

## Where `organization_id` comes from

`organization_id` is **always derived server-side** from the authenticated session and the
user's verified membership — never taken at face value from client-submitted input (a form
field, a query param, a request body value). A Route Handler or Server Action that reads
`organization_id` out of the request body and uses it to scope a query is a critical bug: it
lets any authenticated user claim any organization.

```ts
// WRONG — trusts client input for the tenant boundary
const { organizationId, name } = await request.json();
await supabase.from("leads").insert({ organization_id: organizationId, name });

// RIGHT — organization_id derived from verified membership, not the request body
const membership = await getVerifiedMembership(supabase, user.id);
const { name } = createLeadSchema.parse(await request.json());
await supabase.from("leads").insert({ organization_id: membership.organizationId, name });
```

## Roles and permissions

- **Admin** — full control within the organization: users, roles, settings, all data.
- **Manager** — broader visibility than a Salesperson (e.g., their team's leads/deals) but
  not full org administration.
- **Salesperson** — their own leads/contacts/tasks/opportunities; limited visibility into
  others' records unless explicitly shared.

Express role checks in two places, consistently:

- In RLS policies, where the rule can be stated in terms of the row and the caller's
  membership/role.
- In the service layer, for anything RLS can't cleanly express, and as a second, independent
  check for privileged operations.

Never implement a role check only as conditional UI rendering (hiding a button). That's UX,
not security.

## Review checklist for any change touching this area

- [ ] Does every new/changed tenant-owned table have `organization_id`, indexed and
      foreign-keyed?
- [ ] Does every new/changed table have RLS enabled with real (not placeholder) policies for
      every operation it supports?
- [ ] Is `organization_id` ever read from client-submitted input instead of derived from the
      verified session/membership? (If yes — critical bug.)
- [ ] Does the service layer independently verify organization membership and role for
      privileged operations, rather than relying on RLS alone?
- [ ] Is there any query path (a Supabase RPC, a service-role client use, a raw SQL function)
      that could bypass RLS and needs its own explicit scoping?
- [ ] Has a negative case been considered — a member of Organization A deliberately trying to
      reach Organization B's data through this code path?

When in doubt, escalate the review — run `/review-database` and `/security-review` on the
change before considering it done.
