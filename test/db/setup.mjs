import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");

/**
 * Recreates enough of Supabase's own environment for the real migrations
 * to run unmodified: the auth schema, auth.uid() backed by a settable
 * session variable, the three PostgREST roles, and pgcrypto.
 *
 * Every one of the project's real migration files is then executed
 * verbatim, in filename order, so the automation migration lands on the
 * same cumulative schema it will land on in production.
 *
 * statement_timeout is set on the connection so a migration that blocks
 * on a lock FAILS instead of hanging — a hung client leaves a
 * server-side backend running, which then blocks the next run's reset,
 * which is a trap this harness fell into once already.
 */
const SUPABASE_PRELUDE = `
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant anon, authenticated, service_role to postgres;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);
grant select on auth.users to authenticated;

-- The real auth.uid() shape: reads the JWT sub claim from the session.
-- The tests set that claim with set_config to impersonate a user.
create or replace function auth.uid() returns uuid
language sql stable as $fn$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$fn$;

create or replace function auth.role() returns text
language sql stable as $fn$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), current_user::text);
$fn$;

-- Supabase Storage, enough of it for 20260905170000 (avatars bucket and
-- its policies) to apply verbatim. Not under test here; present so the
-- migration chain reaches the automation migration on a realistic schema.
create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb
);
alter table storage.objects enable row level security;
grant select, insert, update, delete on storage.objects to authenticated;

create or replace function storage.foldername(name text) returns text[]
language sql immutable as $fn$
  select string_to_array(name, '/');
$fn$;
`;

function client(database) {
  return new pg.Client({
    host: "127.0.0.1",
    port: 55432,
    user: "postgres",
    password: "postgres",
    database,
    connectionTimeoutMillis: 10_000,
    // Nothing in a migration should take 30s on an empty database. If it
    // does, it is blocked, and an error is far more useful than a hang.
    statement_timeout: 30_000,
  });
}

async function main() {
  const onlyFile = process.argv[2];

  const admin = client("postgres");
  await admin.connect();
  // Clear anything left over from an interrupted run before touching the
  // test database.
  await admin.query(
    `select pg_terminate_backend(pid) from pg_stat_activity
      where datname = 'automation_test' and pid <> pg_backend_pid()`,
  );
  const { rows } = await admin.query(`select 1 from pg_database where datname = 'automation_test'`);
  if (rows.length === 0) {
    await admin.query(`create database automation_test`);
  }
  await admin.end();

  const db = client("automation_test");
  await db.connect();

  // RESET BY SCHEMA, not by DROP DATABASE — a dropped database needs
  // every other connection gone, which cannot be guaranteed from inside
  // the same script.
  console.log("resetting schemas...");
  await db.query(`drop schema if exists public cascade`);
  await db.query(`drop schema if exists auth cascade`);
  // storage too — its policies survive a public/auth reset and then
  // collide on the next run.
  await db.query(`drop schema if exists storage cascade`);
  await db.query(`create schema public`);
  await db.query(`grant all on schema public to postgres`);

  console.log("applying Supabase prelude...");
  await db.query(SUPABASE_PRELUDE);

  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => !onlyFile || f === onlyFile);

  let applied = 0;
  const failures = [];

  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const started = Date.now();
    try {
      await db.query(sql);
      applied += 1;
      console.log(`  ok    ${file}  (${Date.now() - started}ms)`);
    } catch (error) {
      failures.push({ file, code: error.code, message: error.message });
      console.log(`  FAIL  ${file}  (${Date.now() - started}ms)`);
      console.log(`        ${error.code}: ${error.message}`);
      if (error.position) {
        const upto = sql.slice(0, Number(error.position));
        const line = upto.split("\n").length;
        console.log(`        line ~${line}: ${sql.split("\n")[line - 1]?.trim().slice(0, 150)}`);
      }
      // A failed migration leaves the schema incomplete, so later ones
      // will cascade. Stop at the first real failure and report it.
      break;
    }
  }

  console.log(`\n${applied}/${files.length} migrations applied.`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  ${f.file}: ${f.code} ${f.message}`);
  }
  await db.end();
  process.exitCode = failures.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("setup crashed:", error.code ?? "", error.message);
  process.exitCode = 1;
});
