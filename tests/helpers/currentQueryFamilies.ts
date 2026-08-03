import type { CliCurrentQueryFamily } from "../../src/cli/indexPolicy.js";

export type CurrentQueryFamilyCase = {
  family: CliCurrentQueryFamily;
  /** Representative command for the family; the loader suite carries the mutation matrix. */
  command: string;
  args: (root: string) => string[];
};

/**
 * One representative CLI invocation per current-query wiring family.
 *
 * `tests/cli-index-policy.test.ts` requires every declared family to appear here, and
 * `tests/cli-current-index-freshness.test.ts` runs each case cold and warm.
 */
export const CURRENT_QUERY_FAMILY_CASES: readonly CurrentQueryFamilyCase[] = [
  {
    family: "navigation",
    command: "refs",
    args: (root) => ["refs", "src/helper.ts:1:17", "--root", root, "--json"],
  },
  {
    family: "graph-query",
    command: "deps",
    args: (root) => ["deps", "src/app.ts", "--root", root, "--json"],
  },
  {
    family: "structural-summary",
    command: "inspect",
    args: (root) => ["inspect", "--root", root, "--json"],
  },
  {
    family: "duplicate-analysis",
    command: "duplicates",
    args: (root) => ["duplicates", "--root", root, "--json"],
  },
  {
    family: "diff-aware",
    command: "impact",
    args: (root) => ["impact", "--root", root, "--base", "HEAD", "--json"],
  },
  {
    family: "affected-tests",
    command: "affected",
    args: (root) => ["affected", "src/helper.ts", "--root", root, "--json"],
  },
];
