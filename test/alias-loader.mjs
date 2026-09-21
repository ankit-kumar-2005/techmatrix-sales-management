import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * A module resolve hook that gives Node the two things TypeScript source
 * assumes and Node does not provide: the `@/*` path alias from
 * tsconfig.json, and extensionless module specifiers.
 *
 * WHY THIS EXISTS. This project has no test framework installed, and
 * adding one (vitest/jest) to run a handful of pure-function tests would
 * pull a large dev dependency tree into a repo that has deliberately
 * stayed small. Node 24 already has both halves of what is needed — a
 * test runner (`node:test`) and native TypeScript type stripping. Type
 * stripping removes types; it does NOT rewrite import specifiers, so
 * `@/types/automation` and `../config/safeguards` both fail to resolve
 * on their own. That is the entire gap this file closes.
 *
 * Used only by `npm test`. Nothing in the application depends on it —
 * Turbopack resolves the same specifiers from tsconfig at build time.
 */

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/** In the order TypeScript's own bundler resolution would try them. */
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx"];

function firstExisting(basePath) {
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = basePath + suffix;
    if (existsSync(candidate)) {
      return pathToFileURL(candidate).href;
    }
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // 1. The tsconfig alias.
  if (specifier.startsWith("@/")) {
    const resolved = firstExisting(join(ROOT, specifier.slice(2)));
    if (resolved) return nextResolve(resolved, context);
  }

  // 2. Extensionless relative imports, which is how every file in this
  //    codebase imports its neighbours.
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentPath = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : ROOT;
    const resolved = firstExisting(resolvePath(parentPath, specifier));
    if (resolved) return nextResolve(resolved, context);
  }

  return nextResolve(specifier, context);
}
