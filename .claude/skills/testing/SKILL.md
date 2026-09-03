---
name: testing
description: Testing conventions for this project across all layers — unit, component, service, API, integration, authentication, authorization, RLS, and end-to-end tests. Use when planning or writing tests, or when the /test-feature command needs deeper guidance.
---

# Testing

This is the deep reference behind `CLAUDE.md` Section Q. Read that section first for the
binding rules — this document explains what each test layer is for and when it earns its
keep. Testing is introduced incrementally, alongside the feature it covers (per
`CLAUDE.md` Section 7) — not retrofitted as a separate late phase.

## What each layer is for

- **Unit tests** — pure functions in `utils/` and pure logic inside `services/` that doesn't
  need a live database. Fast, no I/O. Good for: formatting, calculation, pure business rules
  (e.g., "which pipeline stage comes after this one").
- **Component tests** — components with real conditional behavior (a form that shows
  different fields based on state, a table that handles empty/error/loading distinctly).
  Skip these for purely presentational components with no logic — a snapshot of static markup
  isn't worth maintaining.
- **Service tests** — the domain logic in `services/`, run against a real or realistic test
  database where the logic involves data access. Explicitly cover authorization branches: the
  allowed case *and* the denied case for each role.
- **API tests** — Route Handlers: correct status code and response shape for success,
  validation failure, unauthenticated, and unauthorized cases.
- **Integration tests** — a flow that spans layers (e.g., create-lead through the Route
  Handler → service → database → RLS) tested as one unit, catching issues that layer-isolated
  tests would miss (a mismatch between what the service assumes and what RLS actually allows).
- **Authentication tests** — login, logout, session persistence/expiry behavior.
- **Authorization tests** — for each privileged operation, a matrix of role × expected
  outcome (Admin allowed, Manager allowed/denied depending on the operation, Salesperson
  denied where expected) — always include the negative cases, not just the happy path.
- **RLS tests** — run directly against Postgres (or via the Supabase client as different
  test users), proving for every tenant-owned table that a user from Organization A cannot
  `select`/`insert`/`update`/`delete` a row belonging to Organization B. This is the most
  important test category in the whole project — a passing RLS test suite is the closest
  thing this system has to a proof of the core guarantee in `CLAUDE.md` Section G.
- **End-to-end tests** — critical user journeys through the real UI (e.g., capture a lead →
  qualify → move through pipeline stages → mark won), reserved for flows that would be a
  serious problem if silently broken.

## Prioritization

When time/scope is limited, prioritize in this order:

1. RLS tests for any new/changed tenant-owned table.
2. Authorization tests (including negative cases) for any new privileged operation.
3. Service tests for new business logic, especially anything with branching rules.
4. API tests for new Route Handlers.
5. Everything else (unit, component, E2E), proportionate to how central the feature is.

## Conventions

- Tests for a feature live alongside that feature's code (e.g., a service's tests near
  `services/`, a feature's component tests near `features/<feature>/components/`), not in a
  single unrelated top-level test tree, unless the project's chosen test runner requires
  otherwise.
- A test asserting "Organization A cannot see Organization B's data" should actually create
  two organizations' worth of data and attempt the cross-org access — not just assert that a
  query includes an `organization_id` filter in isolation.
- Don't write a test that only exercises the happy path for something with a meaningful
  failure mode (auth, authorization, validation) — the negative case is usually the one that
  matters most.
