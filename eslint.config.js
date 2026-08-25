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
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  {
    // Every CLI module -- the dispatcher included -- plus the review and agent-tool entry
    // points must load the index through the shared policy helper, so a new current-state
    // query cannot silently reintroduce a raw full build. Deny by default here; the block
    // below names the artifact, lifecycle, historical, and graph-materialization exemptions.
    files: ["src/cli.ts", "src/cli/**/*.ts", "src/review.ts", "src/agent-tools.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              // The builders are re-exported by `src/indexer.ts`, the package entrypoint, and
              // the published package name plus its subpaths. Naming source modules keeps
              // leaving a re-export open, so restrict the symbols from any specifier instead.
              group: ["*", "**"],
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
    // Explicit exemptions: `graph` materializes artifacts and `index` builds or refreshes
    // the project index, so both own their builder choice. Keep this list short and
    // justified; every entry is asserted by tests/cli-index-policy.test.ts.
    files: ["src/cli/graph.ts", "src/cli/index.ts"],
    rules: {
      "no-restricted-imports": "off",
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
