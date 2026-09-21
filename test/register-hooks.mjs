import { register } from "node:module";

/**
 * Registers alias-loader.mjs as a real ESM resolve hook.
 *
 * A hook module cannot simply be `--import`ed — that would just evaluate
 * it. `register()` is what installs it into the loader chain, and it has
 * to happen before any test file is imported, which is why this runs via
 * `--import` in the `test` script rather than from inside a test.
 */
register("./alias-loader.mjs", import.meta.url);
