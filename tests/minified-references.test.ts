import { describe, expect, it, vi } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildProjectIndex, findReferences } from "../src/index.js";
import { findRenameReferences, findUsageReferences } from "../src/indexer/navigation.js";
import * as navigationReferences from "../src/indexer/navigation-references.js";
import { fileIdentityKey } from "../src/util/paths.js";
import { writeFixtureFiles } from "./languages/callable-consumer-fixtures.js";

type Route = "definition" | "usages" | "rename";

const ambiguousScript = (prefix: string): string => {
  const names = "abcdefghij".split("");
  const parameters = names.join(",");
  const body = names.join("+");
  return `function ${prefix}0(${parameters}){return ${body}}function ${prefix}1(${parameters}){return ${body}}`;
};

/** Requested names scanned per importing file by one query of the first matching declaration. */
async function scannedNamesByFile(
  files: Record<string, string>,
  declaringFile: string,
  name: string,
  route: Route,
): Promise<Map<string, string[]>> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-minified-key-"));
  try {
    const written = await writeFixtureFiles(root, files);
    const index = await buildProjectIndex(root, { cache: "off", threads: 1, useNativeWorkers: false });
    const module = index.byFile.get(fileIdentityKey(written[declaringFile]!));
    const definition = module?.locals.find((local) => local.localName === name);
    if (!definition) throw new Error(`Expected declaration ${name}`);
    const scans = vi.spyOn(navigationReferences, "collectVerifiedNamedNodeReferences");
    try {
      if (route === "definition") await findReferences(index, { def: definition });
      else if (route === "usages") await findUsageReferences(index, { def: definition });
      else await findRenameReferences(index, definition);
      const byFile = new Map<string, string[]>();
      for (const [, candidate, symbolName] of scans.mock.calls) {
        const relative = path.relative(root, candidate).replaceAll("\\", "/");
        const names = byFile.get(relative);
        if (names) names.push(symbolName);
        else byFile.set(relative, [symbolName]);
      }
      return byFile;
    } finally {
      scans.mockRestore();
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

describe("minified script references through document imports", () => {
  it.each([4, 20])("bounds repeated spelling scans with %i ambiguous script names", async (nameCount) => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-minified-reference-work-"));
    const names = "abcdefghijklmnopqrst".slice(0, nameCount).split("");
    const parameters = names.join(",");
    const body = names.join("+");
    const source = (prefix: string): string =>
      `function ${prefix}0(${parameters}){return ${body}}function ${prefix}1(${parameters}){return ${body}}`;
    try {
      const files = await writeFixtureFiles(root, {
        "vendor.js": source("vendor"),
        "decoy.js": source("decoy"),
        "page.html":
          '<script src="./vendor.js"></script><script src="./decoy.js"></script><section id="marker">read</section>',
      });
      const index = await buildProjectIndex(root, { cache: "off", threads: 1, useNativeWorkers: false });
      const page = index.byFile.get(fileIdentityKey(files["page.html"]!));
      expect(page?.nativeOutcome).toBe("used");
      for (const asset of ["vendor.js", "decoy.js"] as const) {
        const file = files[asset]!;
        const module = index.byFile.get(fileIdentityKey(file));
        expect(module?.nativeOutcome).toBe("used");
        const definition = module?.locals.find((local) => local.localName === "a");
        if (!definition) throw new Error("Expected first script parameter");
        const expanded = page?.imports.filter(
          (binding) => binding.kind === "named" && binding.resolved === file && names.includes(binding.local),
        );
        expect(expanded).toHaveLength(nameCount);
        const scans = vi.spyOn(navigationReferences, "collectVerifiedNamedNodeReferences");
        try {
          for (const route of ["definition", "position", "usages", "rename"] as const) {
            scans.mockClear();
            let result;
            if (route === "definition") result = await findReferences(index, { def: definition });
            else if (route === "position") {
              result = await findReferences(index, {
                file,
                line: definition.range.start.line,
                column: definition.range.start.column,
              });
            } else if (route === "usages") result = await findUsageReferences(index, { def: definition });
            else result = await findRenameReferences(index, definition);
            expect(result.status).toBe("ok");
            if (result.status !== "ok") throw new Error("Expected script references");
            expect(result.referenceCoverage).toEqual({
              scope: "indexed_candidates",
              state: "partial",
              reasons: ["unresolved_import"],
              affectedFiles: [files["page.html"]],
            });
            const includesDeclaration = route === "definition" || route === "position";
            const firstUse = source(asset.slice(0, -3)).indexOf("return a") + "return ".length;
            const expectedOffsets = includesDeclaration ? [definition.range.start.index, firstUse] : [firstUse];
            expect(result.references.map((reference) => [reference.file, reference.range.start.index])).toEqual(
              expectedOffsets.map((offset) => [file, offset]),
            );
            expect(result.references.every((reference) => !reference.via)).toBe(true);
            const pageScans = scans.mock.calls.filter(([, candidate]) => candidate === files["page.html"]);
            expect(pageScans).toHaveLength(route === "rename" ? 2 : 1);
            expect(pageScans[0]?.[2]).toBe("a");
          }
        } finally {
          scans.mockRestore();
        }
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("unresolved import scan reuse keeps its key complete", () => {
  it.each(["definition", "rename"] as const)("scans each importing document once (%s)", async (route) => {
    const page =
      '<script src="./vendor.js"></script><script src="./decoy.js"></script><section id="marker">read</section>';
    const scans = await scannedNamesByFile(
      {
        "vendor.js": ambiguousScript("vendor"),
        "decoy.js": ambiguousScript("decoy"),
        "page.html": page,
        "other.html": page,
      },
      "vendor.js",
      "a",
      route,
    );
    const perClass = route === "rename" ? 2 : 1;
    expect(scans.get("page.html")).toHaveLength(perClass);
    expect(scans.get("other.html")).toHaveLength(perClass);
  });

  it.each(["definition", "usages", "rename"] as const)("scans each requested export name once (%s)", async (route) => {
    const scans = await scannedNamesByFile(
      {
        "vendor.js":
          "function a(){return 1}function p(){return 2}function r(){return 3}function s(){return 4}function t(){return 5}\n" +
          "export { a as x, a as y, p as q, r as q, s as u, t as u };\n",
        "user.ts": 'import { q } from "./vendor.js";\nimport { u } from "./vendor.js";\nvoid q;\nvoid u;\n',
      },
      "vendor.js",
      "a",
      route,
    );
    expect([...(scans.get("user.ts") ?? [])].sort()).toEqual(["x", "y"]);
  });

  it("keeps a default import from hiding a later renameable binding", async () => {
    const files = {
      "vendor.js": ambiguousScript("vendor"),
      "user.ts": 'import d from "./vendor.js";\nimport { a } from "./vendor.js";\nvoid d;\nvoid a;\n',
    };
    const references = await scannedNamesByFile(files, "vendor.js", "a", "definition");
    expect(references.get("user.ts")).toEqual(["a"]);
    const rename = await scannedNamesByFile(files, "vendor.js", "a", "rename");
    expect(rename.get("user.ts")).toEqual(["a", "a"]);
  });
});
