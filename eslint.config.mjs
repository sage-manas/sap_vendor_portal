import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next. Note that replacing the
  // defaults means re-listing everything they covered: `node_modules/**` is not
  // implied here, and leaving it out made a bare `eslint` (as `npm run lint`
  // runs it, with no path argument) walk the dependency tree until it blew the
  // call stack. `mongodb_data/**` is the committed WiredTiger data directory —
  // binary, and equally not source.
  globalIgnores([
    // Default ignores of eslint-config-next:
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "backend/**",
    "mongodb_data/**",
  ]),
]);

export default eslintConfig;
