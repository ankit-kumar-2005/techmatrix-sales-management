# Database tests

These run the project's migrations against a **real PostgreSQL server** and
assert behaviour that cannot be checked by reading SQL: tenant isolation under
RLS with real roles, two workers genuinely racing a queue, idempotency under a
real unique-index conflict, and the automation outbox end to end.

They found 13 defects in the automation migration before it was ever applied
anywhere, including one that a careful static audit had **wrongly cleared** —
see the finding table in [`docs/automations.md`](../../docs/automations.md).

## Running them

Two packages are needed that are deliberately **not** in `package.json`:
`embedded-postgres` downloads ~100 MB of PostgreSQL binaries, which does not
belong in every developer's install.

```bash
npm install --no-save embedded-postgres pg

node test/db/boot.mjs      # initdb + start a throwaway cluster on port 55432
node test/db/setup.mjs     # apply all migrations in filename order
node test/db/review.mjs    # tenancy, all four roles, claim ownership, concurrency
node test/db/review2.mjs   # SECURITY DEFINER audit, end to end, token rotation
```

`setup.mjs` is re-runnable: it resets the `public`, `auth` and `storage` schemas
each time, so you can edit a migration and re-apply without restarting the
cluster. Run one migration in isolation with `node test/db/setup.mjs <filename>`.

Stop the cluster with the pid printed by `boot.mjs` (also written to
`test/db/pg.pid`). Everything lives under `test/db/pgdata`, which is disposable.

## What the harness is, and is not

`setup.mjs` reconstructs the parts of Supabase the migrations depend on — the
`auth` schema, `auth.uid()` reading the JWT `sub` claim from a session variable,
the `anon`/`authenticated`/`service_role` roles, and enough of `storage` for the
avatars migration to apply. Every real migration then runs **verbatim**, in
filename order, so the schema under test is the cumulative production schema.

It is **not** Supabase. `auth.uid()` and the roles behave the same way, which is
what makes the RLS assertions meaningful, but RLS on a real project should still
be spot-checked after applying a migration.

Nothing here connects to a real database. The cluster is created from scratch on
an unusual port and trusts local connections — correct for a disposable test
cluster and for nothing else.

## Files

| File | Purpose |
|---|---|
| `boot.mjs` | initdb + start the cluster |
| `setup.mjs` | Supabase prelude, then every migration |
| `seed.mjs` | Two tenants with a full role hierarchy; helpers for building automations |
| `review.mjs` | Items 1–2, 4–6, 8: tenancy, eligibility, claim ownership, roles, concurrency, idempotency, round-robin, retries |
| `review2.mjs` | Item 3 (SECURITY DEFINER audit), item 7 (end to end), item 5 (token rotation) |
