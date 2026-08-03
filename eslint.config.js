import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "packages/codegraph-native/**",
      "tests/samples/**",
      "tests/languages/samples/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    plugins: {
      "@stylistic": stylistic,
    },
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "max-len": [
        "error",
        {
          code: 140,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
        },
      ],
      "no-nested-ternary": "error",
      "no-useless-escape": "off",
      "prefer-const": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-duplicate-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Current-state query modules must load the index through the shared policy helper so a
    // raw full build cannot be reintroduced. Artifact, lifecycle, historical, graph
    // materialization, session, and library modules keep their explicit builder access.
    files: [
      "src/agent-tools.ts",
      "src/review.ts",
      "src/cli/affected.ts",
      "src/cli/duplicates.ts",
      "src/cli/graphQueries.ts",
      "src/cli/impact.ts",
      "src/cli/inspect.ts",
      "src/cli/navigation.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // `src/indexer.ts` and the package entrypoint re-export the same builders, so the
              // boundary has to name every path the symbols can arrive through.
              group: ["**/indexer/build-index.js", "**/indexer.js", "**/index.js"],
              importNames: ["buildProjectIndex", "buildProjectIndexFromFiles", "buildProjectIndexIncremental"],
              message:
                "Load current repository state through loadCurrentProjectIndex (src/indexer/load-current-index.ts).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["tests/**/*.test.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
      "no-empty": "off",
    },
  },
);
