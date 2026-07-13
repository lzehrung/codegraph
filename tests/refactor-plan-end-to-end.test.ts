import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildRefactorPlanWithSession } from "../src/agent/refactorPlan.js";
import { searchCodegraphWithSession } from "../src/agent/search.js";
import { createAgentSession } from "../src/agent/session.js";
import { buildReviewReport } from "../src/review.js";
import { countingSession } from "./helpers/agent.js";

let root = "";
let sourceFile = "";
let beforeSource = "";

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-refactor-handoff-"));
  sourceFile = path.join(root, "service.ts");
  beforeSource = [
    "export function helper(): number { return 1; }",
    "export function service(): number { return helper(); }",
    "export function caller(): number { return service(); }",
  ].join("\n");
  await fs.writeFile(sourceFile, beforeSource);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("search and review handle to refactor plan", () => {
  it("hands exact handles into one warm session and returns only portable target follow-ups", async () => {
    const review = await buildReviewReport(root, {
      cache: "off",
      includeSymbolDetails: true,
      diffText: [
        "diff --git a/service.ts b/service.ts",
        "index 1234567..abcdef0 100644",
        "--- a/service.ts",
        "+++ b/service.ts",
        "@@ -2,1 +2,1 @@",
        "-export function service(): number { return 1; }",
        "+export function service(): number { return helper(); }",
        "",
      ].join("\n"),
    });
    const reviewHandle = review.changedFiles
      .find((entry) => entry.file === "service.ts")
      ?.symbols.find((symbol) => symbol.name === "service")?.handle;
    if (!reviewHandle) throw new Error("Review did not emit the service symbol handle");

    const baseSession = createAgentSession({
      root,
      buildOptions: { cache: "off" },
      freshness: { policy: "manual" },
    });
    const counted = countingSession(baseSession);
    const search = await searchCodegraphWithSession(counted.session, {
      root,
      query: "service",
      mode: "symbol",
    });
    const searchHandle = search.results.find(
      (result) => result.kind === "symbol" && result.label === "service",
    )?.handle;
    if (!searchHandle) throw new Error("Search did not emit the service symbol handle");

    const fromSearch = await buildRefactorPlanWithSession(counted.session, {
      root,
      handle: searchHandle,
    });
    const fromReview = await buildRefactorPlanWithSession(counted.session, {
      root,
      handle: reviewHandle,
      renameTo: "not/a/name",
    });

    expect(counted.loads()).toBe(1);
    expect(searchHandle).toMatch(/^symbol:/);
    expect(reviewHandle).not.toMatch(/^symbol:/);
    expect(fromSearch.target.handle).toBe(searchHandle);
    expect(fromReview.target.handle).toBe(searchHandle);
    expect(fromReview.rename).toMatchObject({
      safe: false,
      conflicts: [expect.objectContaining({ reason: "invalid_identifier" })],
    });
    expect(fromReview.followUps.every((command) => !command.includes(reviewHandle))).toBe(true);
    expect(fromReview.followUps.some((command) => command.includes(searchHandle))).toBe(true);
    expect(await fs.readFile(sourceFile, "utf8")).toBe(beforeSource);
  });
});
