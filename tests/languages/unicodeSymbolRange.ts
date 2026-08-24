import { expect } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectLocalsAndExportsFromSource, parseFile } from "../../src/indexer.js";

/**
 * C11 regression helper: asserts a native-query-driven symbol's published range is a UTF-16
 * string index identical to `source.indexOf(symbolName)`, and that slicing the range recovers
 * the identifier text. The fixture source is expected to carry multibyte (non-ASCII) text both
 * on an earlier line and immediately before the declaration on its own line, so both the
 * cross-line byte->string line-start offset and the same-line byte->string column offset are
 * exercised; before the fix, native capture byte offsets were published unconverted.
 */
export async function expectUnicodeSymbolRangeIdentity(opts: {
  fileName: string;
  source: string;
  symbolName: string;
}): Promise<void> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-unicode-range-"));
  try {
    const file = path.join(root, opts.fileName);
    await fsp.writeFile(file, opts.source, "utf8");
    const parsed = await parseFile(file);
    const mod = collectLocalsAndExportsFromSource(file, parsed.source, parsed.sup, [], {
      ...(parsed.nativeQueries === undefined ? {} : { nativeQueries: parsed.nativeQueries }),
    });
    const sym = mod.locals.find((s) => s.localName === opts.symbolName);
    expect(
      sym,
      `expected a local symbol named "${opts.symbolName}" in locals: ${mod.locals.map((l) => l.localName).join(", ")}`,
    ).toBeDefined();

    const expectedIndex = opts.source.indexOf(opts.symbolName);
    expect(expectedIndex).toBeGreaterThanOrEqual(0);
    expect(sym!.range.start.index, "range.start.index must equal source.indexOf(name)").toBe(expectedIndex);
    expect(
      opts.source.slice(sym!.range.start.index, sym!.range.start.index + opts.symbolName.length),
      "slicing the published range must recover the identifier text",
    ).toBe(opts.symbolName);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}
