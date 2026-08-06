import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defNodeId } from "../src/graphs/symbol-graph.js";
import { buildRefactorPlanWithSession } from "../src/agent/refactorPlan.js";
import { formatAgentFollowUpAsCli } from "../src/agent/followUps.js";
import { resolveSemanticSymbol, semanticSymbolFromDef } from "../src/agent/semanticSymbols.js";
import { createAgentSession, type AgentSession } from "../src/agent/session.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function refactorFixture() {
  const root = await mkTmpDir("cg-refactor-plan-");
  await fsp.writeFile(
    path.join(root, "service.ts"),
    [
      "export function helper(): number { return 1; }",
      "export function service(): number { return helper(); }",
      "export function caller(): number { return service(); }",
    ].join("\n"),
  );
  await fsp.writeFile(path.join(root, "service.test.ts"), 'import { service } from "./service.js";\nservice();\n');
  const backing = createAgentSession({ root, freshness: { policy: "check" } });
  const snapshot = await backing.loadProject();
  const targetDef = [...snapshot.index.byFile.values()]
    .flatMap((moduleIndex) => moduleIndex.locals)
    .find((definition) => definition.localName === "service" && definition.file.endsWith("service.ts"));
  expect(targetDef).toBeDefined();
  const handle = semanticSymbolFromDef(snapshot, targetDef!).handle;
  return { root, backing, handle, reviewHandle: defNodeId(targetDef!) };
}

describe("refactor evidence plan", () => {
  it("composes references, callers, callees, tests, and follow-ups from one loaded snapshot", async () => {
    const { root, backing, handle } = await refactorFixture();
    let loadCount = 0;
    const session: AgentSession = {
      root,
      loadProject: async (options) => {
        loadCount += 1;
        return await backing.loadProject(options);
      },
      checkFreshness: async () => ({ state: "fresh" }),
      invalidate: () => backing.invalidate(),
    };
    const result = await buildRefactorPlanWithSession(session, {
      root,
      handle,
      maxReferences: 20,
      maxCallers: 20,
      maxHierarchy: 20,
    });

    expect(loadCount).toBe(1);
    expect(result.target.handle).toBe(handle);
    expect(result.definition.file).toBe("service.ts");
    expect(result.references.some((reference) => reference.file === "service.test.ts")).toBe(true);
    expect(result.callers.map((entry) => entry.symbol.name)).toEqual(["caller"]);
    expect(result.callees.map((entry) => entry.symbol.name)).toEqual(["helper"]);
    expect(result.candidateTests).toContainEqual(expect.objectContaining({ file: "service.test.ts" }));
    expect(result.sectionIssues).toContainEqual({
      section: "implementations",
      status: "unsupported_target",
      reason: expect.stringContaining("Implementation lookup requires"),
    });
    expect(result.omittedCounts.implementations).toBe(1);
    expect(result.followUps).toContainEqual({
      tool: "refs",
      arguments: { file: "service.ts", line: 2, column: 17 },
    });
    expect(
      result.followUps.some(
        (followUp) =>
          followUp.tool === "calls" &&
          followUp.arguments.direction === "callers" &&
          followUp.arguments.handle === handle &&
          formatAgentFollowUpAsCli(followUp).includes(`callers ${handle}`),
      ),
    ).toBe(true);
    expect(result.rename).toBeUndefined();
  });
  it("composes supported implementations with independent limits and no section issue", async () => {
    const root = await mkTmpDir("cg-refactor-plan-implementations-");
    await fsp.writeFile(
      path.join(root, "types.ts"),
      ["export interface Contract { run(): void }", "export class Worker implements Contract { run(): void {} }"].join(
        "\n",
      ),
    );
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const snapshot = await session.loadProject();
    const contract = [...snapshot.index.byFile.values()]
      .flatMap((moduleIndex) => moduleIndex.locals)
      .find((definition) => definition.localName === "Contract");
    expect(contract).toBeDefined();
    const handle = semanticSymbolFromDef(snapshot, contract!).handle;

    const result = await buildRefactorPlanWithSession(session, { root, handle, maxHierarchy: 10 });
    expect(result.implementations.map((entry) => entry.symbol.name)).toEqual(["Worker"]);
    expect(result.implementations[0]?.relationSite?.file).toBe("types.ts");
    expect(result.sectionIssues).toEqual([]);
    expect(result.omittedCounts.implementations).toBe(0);

    const limited = await buildRefactorPlanWithSession(session, { root, handle, maxHierarchy: 0 });
    expect(limited.implementations).toEqual([]);
    expect(limited.sectionIssues).toEqual([]);
    expect(limited.omittedCounts.implementations).toBe(1);
  });

  it("includes source context only when requested", async () => {
    const { root, backing, handle } = await refactorFixture();
    const withoutSource = await buildRefactorPlanWithSession(backing, { root, handle });
    const withSource = await buildRefactorPlanWithSession(backing, {
      root,
      handle,
      includeSource: true,
    });

    expect(withoutSource.references.every((reference) => reference.context === undefined)).toBe(true);
    expect(withSource.references.some((reference) => reference.context?.includes("service()"))).toBe(true);
  });

  it("accepts an exact review or impact symbol handle and returns portable output", async () => {
    const { root, backing, reviewHandle } = await refactorFixture();
    const snapshot = await backing.loadProject();
    expect(resolveSemanticSymbol(snapshot, reviewHandle)).toBeNull();
    const result = await buildRefactorPlanWithSession(backing, {
      root,
      handle: reviewHandle,
    });
    expect(result.target.handle).toMatch(/^symbol:/);
    expect(result.target.name).toBe("service");
    expect(result.followUps.every((followUp) => !JSON.stringify(followUp).includes(reviewHandle))).toBe(true);
    expect(result.followUps.some((followUp) => JSON.stringify(followUp).includes(result.target.handle))).toBe(true);
  });

  it("rejects stale review handles with a workspace-symbol recovery action", async () => {
    const { root, backing, reviewHandle } = await refactorFixture();
    await expect(
      buildRefactorPlanWithSession(backing, {
        root,
        handle: `${reviewHandle}-stale`,
      }),
    ).rejects.toThrow("Run workspace_symbols");
  });

  it("includes the authoritative read-only rename preview without mutating source", async () => {
    const { root, backing, handle } = await refactorFixture();
    const sourceFile = path.join(root, "service.ts");
    const before = await fsp.readFile(sourceFile, "utf8");
    const result = await buildRefactorPlanWithSession(backing, {
      root,
      handle,
      renameTo: "renamedService",
    });
    expect(result.rename?.safe).toBe(true);
    expect(result.rename?.edits.length).toBeGreaterThan(1);
    expect(await fsp.readFile(sourceFile, "utf8")).toBe(before);
  });

  it("preserves an authoritative unsafe rename decision for stale source", async () => {
    const { root, backing, handle } = await refactorFixture();
    await fsp.appendFile(path.join(root, "service.ts"), "\n// changed after indexing\n");

    const result = await buildRefactorPlanWithSession(backing, {
      root,
      handle,
      renameTo: "renamedService",
    });

    expect(result.freshness.state).toBe("stale");
    expect(result.rename?.safe).toBe(false);
  });

  it("keeps section limits and omissions independent", async () => {
    const { root, backing, handle } = await refactorFixture();
    const result = await buildRefactorPlanWithSession(backing, {
      root,
      handle,
      maxReferences: 0,
      maxCallers: 0,
      maxHierarchy: 0,
    });
    expect(result.references).toEqual([]);
    expect(result.callers).toEqual([]);
    expect(result.callees).toEqual([]);
    expect(result.omittedCounts.references).toBeGreaterThan(0);
    expect(result.omittedCounts.callers).toBeGreaterThan(0);
    expect(result.omittedCounts.callees).toBeGreaterThan(0);
  });
});
