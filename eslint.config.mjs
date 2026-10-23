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
  // Money is formatted in exactly one place, `src/lib/money.js` (issue #285).
  // Four staff pages had each grown their own `Intl.NumberFormat` helper, and
  // one of them rounded to whole rupees, so the same invoice read ₹1,235 on
  // the workspace invoice list and ₹1,234.56 on the supplier detail page.
  {
    files: ["src/**/*.{js,jsx,ts,tsx}"],
    ignores: ["src/lib/money.js", "src/lib/money.test.js"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "ObjectExpression:has(Property[key.name='style'][value.value='currency'])",
          message:
            "Format money with formatMoney/formatAmount/formatMoneyCompact from '@/lib/money' instead of building an Intl currency formatter here.",
        },
        {
          selector:
            "CallExpression[callee.property.name='toLocaleString'] ObjectExpression:has(Property[key.name=/FractionDigits$/][value.value=0])",
          message:
            "Rounding to whole units hides paise. Use formatMoney/formatAmount from '@/lib/money', or formatMoneyCompact for a KPI tile or chart axis.",
        },
      ],
    },
  },

  // `.cjs` is CommonJS by definition, so `require()` in one is the file type
  // working as intended rather than a legacy import to migrate. The rule comes
  // from eslint-config-next/typescript and is aimed at ES-module source under
  // src/; the only files this reaches are the Node build scripts under
  // docs/redesign/directions/, which run via `node`, never through the bundler.
  // (backend/ is CommonJS too and is ignored wholesale below.)
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },

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
