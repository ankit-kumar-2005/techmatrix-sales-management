import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Boots a throwaway PostgreSQL cluster for the database tests.
 *
 * Uses the real PostgreSQL binaries that `embedded-postgres` downloads —
 * an actual server process, not an in-process emulation, which is what
 * makes the concurrency tests in review.mjs meaningful (two genuine
 * connections racing `FOR UPDATE SKIP LOCKED`).
 *
 * Nothing here touches any real database. It initdb's a fresh cluster
 * under test/db/pgdata, listens on an unusual port, and trusts local
 * connections — appropriate for a disposable test cluster and for
 * nothing else.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DATA = join(HERE, "pgdata");
const PWFILE = join(HERE, "pwfile.txt");
export const PORT = 55432;

/** The platform package embedded-postgres installed for this machine. */
function findBinDir() {
  const base = join(ROOT, "node_modules/@embedded-postgres");
  if (!existsSync(base)) {
    throw new Error(
      "PostgreSQL binaries not found. These tests need two packages that are deliberately not in " +
        "package.json (embedded-postgres pulls ~100MB of binaries):\n\n" +
        "  npm install --no-save embedded-postgres pg\n",
    );
  }
  for (const entry of readdirSync(base)) {
    const bin = join(base, entry, "native/bin");
    if (existsSync(bin)) return bin;
  }
  throw new Error(`No native/bin found under ${base}. Try reinstalling embedded-postgres.`);
}

function exe(binDir, name) {
  const withExt = join(binDir, `${name}.exe`);
  return existsSync(withExt) ? withExt : join(binDir, name);
}

const BIN = findBinDir();

if (existsSync(DATA)) rmSync(DATA, { recursive: true, force: true });
mkdirSync(DATA, { recursive: true });
writeFileSync(PWFILE, "postgres", "utf8");

console.log("initdb...");
execFileSync(exe(BIN, "initdb"), ["-D", DATA, "-U", "postgres", `--pwfile=${PWFILE}`, "-A", "trust", "-E", "UTF8"], {
  stdio: "inherit",
});

console.log(`starting postgres on ${PORT}...`);
// Detached with stdio ignored, so this script exits instead of staying
// attached to the server's output for the life of the cluster.
const child = spawn(exe(BIN, "postgres"), ["-D", DATA, "-p", String(PORT)], {
  detached: true,
  stdio: "ignore",
});
child.unref();
writeFileSync(join(HERE, "pg.pid"), String(child.pid), "utf8");
console.log(`postgres pid ${child.pid} on port ${PORT}. Stop it with:  kill ${child.pid}`);
