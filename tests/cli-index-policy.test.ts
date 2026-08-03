import { describe, expect, it } from "vitest";
import { CLI_COMMAND_CATALOG } from "../src/cli/commandCatalog.js";
import {
  CLI_INDEX_POLICY,
  catalogCommandNames,
  currentQueryCommandsByFamily,
  indexPolicyForCommand,
} from "../src/cli/indexPolicy.js";
import { CURRENT_QUERY_FAMILY_CASES } from "./helpers/currentQueryFamilies.js";

describe("CLI index policy completeness", () => {
  it("classifies every catalog command exactly once", () => {
    const catalog = catalogCommandNames().sort();
    const classified = CLI_INDEX_POLICY.map((entry) => entry.command).sort();
    expect(classified).toEqual(catalog);
    expect(new Set(classified).size).toBe(classified.length);
  });

  it("references no command outside the catalog", () => {
    const catalog = new Set(catalogCommandNames());
    for (const entry of CLI_INDEX_POLICY) {
      expect(catalog.has(entry.command), `unknown command ${entry.command}`).toBe(true);
      expect(entry.behaviors.length, `empty behaviors for ${entry.command}`).toBeGreaterThan(0);
      expect(entry.reason.length, `missing reason for ${entry.command}`).toBeGreaterThan(0);
    }
  });

  it("lets aliases inherit the canonical command classification", () => {
    const aliased = CLI_COMMAND_CATALOG.filter((command) => command.aliases?.length);
    for (const command of aliased) {
      for (const alias of command.aliases ?? []) {
        expect(indexPolicyForCommand(alias)).toEqual(indexPolicyForCommand(command.name));
      }
    }
    expect(indexPolicyForCommand("deps")?.behaviors).toContain("current-query");
    expect(indexPolicyForCommand("not-a-command")).toBeUndefined();
  });

  it("requires a family and a behavioral CLI case for every current-query command", () => {
    const declaredFamilies = currentQueryCommandsByFamily();
    const currentQueryCommands = CLI_INDEX_POLICY.filter((entry) => entry.behaviors.includes("current-query"));
    for (const entry of currentQueryCommands) {
      expect(entry.family, `missing family for ${entry.command}`).toBeDefined();
    }
    const coveredFamilies = new Set(CURRENT_QUERY_FAMILY_CASES.map((entry) => entry.family));
    expect([...coveredFamilies].sort()).toEqual([...declaredFamilies.keys()].sort());
    for (const testCase of CURRENT_QUERY_FAMILY_CASES) {
      const policy = indexPolicyForCommand(testCase.command);
      expect(policy?.behaviors, `${testCase.command} must be a current-query command`).toContain("current-query");
      expect(policy?.family).toBe(testCase.family);
    }
  });

  it("enumerates explicit-build and historical exceptions instead of inferring them", () => {
    const behaviorsFor = (behavior: string) =>
      CLI_INDEX_POLICY.filter((entry) => entry.behaviors.includes(behavior as never))
        .map((entry) => entry.command)
        .sort();
    expect(behaviorsFor("explicit-build")).toEqual(["artifact", "graph", "index", "init", "sync"]);
    expect(behaviorsFor("historical")).toEqual(["drift", "graph-delta"]);
  });
});
