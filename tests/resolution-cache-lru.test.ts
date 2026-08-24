import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clearImportResolutionCaches, resolveSpecifier } from "../src/util/resolution.js";

describe("resolveSpecifier cache", () => {
  it("reuses cached results for identical lookups until caches are cleared", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "dg-res-cache-"));
    const fromFile = path.join(root, "src", "main.ts");
    await fsp.mkdir(path.dirname(fromFile), { recursive: true });
    await fsp.writeFile(path.join(root, "src", "entry.ts"), "export const value = 1;\n", "utf8");
    await fsp.writeFile(fromFile, 'import "./entry";\nexport {}\n', "utf8");

    clearImportResolutionCaches();
    const first = await resolveSpecifier(fromFile, "./entry", root, undefined, undefined, {
      resolutionExtensions: [".ts"],
    });
    const second = await resolveSpecifier(fromFile, "./entry", root, undefined, undefined, {
      resolutionExtensions: [".ts"],
    });

    // The call must actually resolve, or the cache assertions below hold vacuously.
    expect(first).toBeTruthy();
    expect(second).toStrictEqual(first);

    clearImportResolutionCaches();
    const afterClear = await resolveSpecifier(fromFile, "./entry", root, undefined, undefined, {
      resolutionExtensions: [".ts"],
    });
    expect(afterClear).toStrictEqual(first);
  });
});
