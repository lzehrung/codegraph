import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import { prepareDuplicateAnalysis } from "../src/duplicates.js";
import * as concurrency from "../src/util/concurrency.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const tempRoots = createTempRootRegistry();

afterEach(async () => {
  vi.restoreAllMocks();
  await tempRoots.cleanup();
});

describe("duplicate analysis on the event loop", () => {
  it("gives timers and I/O a turn between files once a slice of work is used up", async () => {
    const root = await tempRoots.create("cg-duplicates-event-loop-");
    const names = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"];
    for (const name of names) {
      await fs.writeFile(
        path.join(root, `${name}.ts`),
        `export function ${name}(input: number) {\n  const doubled = input * 2;\n  return doubled + ${name.length};\n}\n`,
        "utf8",
      );
    }
    const session = createAgentSession({ root, buildOptions: { cache: "off" } });
    const { index } = await session.loadProject({ symbolGraph: "skip" });
    // A clock that moves 50 ms with every read makes each slice of work used up, as a long stretch of work does.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 50));
    const yields = vi.spyOn(concurrency, "yieldToEventLoop");
    // Queued before the analysis starts, so it runs at the first turn that the analysis gives away.
    let turnTaken = false;
    setImmediate(() => {
      turnTaken = true;
    });

    await prepareDuplicateAnalysis(index, { projectRoot: root });

    expect(yields.mock.calls.length).toBeGreaterThanOrEqual(names.length);
    expect(turnTaken).toBe(true);
  });
});
