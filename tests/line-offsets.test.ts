import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import { collectImportsForFile } from "../src/index.js";
import type { ImportBinding } from "../src/indexer/types.js";
import { supportById } from "../src/languages.js";
import { collectLineStartOffsets, positionAtOffset } from "../src/util/lines.js";

const tempDirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-line-offsets-"));
  tempDirs.push(root);
  return root;
}

/** The `named` union member for a local name, so its range fields are addressable. */
function namedBinding(
  bindings: readonly ImportBinding[],
  local: string,
): Extract<ImportBinding, { kind: "named" }> | undefined {
  for (const binding of bindings) {
    if (binding.kind === "named" && binding.local === local) return binding;
  }
  return undefined;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("line start offsets", () => {
  it("counts LF, CRLF, and lone CR each as one line terminator", () => {
    expect(collectLineStartOffsets("one\ntwo\n")).toEqual([0, 4, 8]);
    expect(collectLineStartOffsets("one\r\ntwo\r\n")).toEqual([0, 5, 10]);
    expect(collectLineStartOffsets("one\rtwo\r")).toEqual([0, 4, 8]);
  });

  it("keeps mixed line endings aligned with their own terminators", () => {
    expect(collectLineStartOffsets("a\r\nb\rc\n")).toEqual([0, 3, 5, 7]);
  });

  it("gives a trailing lone CR the same single terminator as a trailing LF", () => {
    expect(collectLineStartOffsets("a\r")).toEqual(collectLineStartOffsets("a\n"));
    expect(collectLineStartOffsets("a\r")).toEqual([0, 2]);
  });

  it("reports the offset after a lone CR on line 2", () => {
    const lineStarts = collectLineStartOffsets("a\rbb");
    expect(positionAtOffset(lineStarts, 2)).toEqual({ line: 2, column: 1, index: 2 });
  });

  it("reports an import binding below a lone CR on its real line", async () => {
    const root = await makeTempRoot();
    const file = path.join(root, "cr-only.ts");
    const source = 'import { alpha } from "./dep";\rimport { beta } from "./dep";\r';
    await fsp.writeFile(file, source, "utf8");
    const sup = supportById("ts");
    expect(sup).toBeDefined();
    if (!sup) return;

    const bindings = await collectImportsForFile(file, root, { source, sup, native: "off" });
    const alpha = namedBinding(bindings, "alpha");
    const beta = namedBinding(bindings, "beta");
    const betaRange = beta?.localRange;
    if (!betaRange) throw new Error("expected a local range for the beta import binding");

    expect(alpha?.localRange?.start).toEqual({ line: 1, column: 10, index: 9 });
    expect(betaRange.start).toEqual({ line: 2, column: 10, index: 40 });
    expect(source.slice(betaRange.start.index, betaRange.end.index)).toBe("beta");
  });
});
