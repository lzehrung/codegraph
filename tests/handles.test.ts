import { describe, it, expect } from "vitest";
import path from "node:path";

import { buildProjectIndex, listSymbols, goToDefinitionById, findReferencesById, symbolId, defFromSymbolId } from "../src/index.js";

const norm = (p: string) => p.replace(/\\/g, "/");

describe("Agent-friendly symbol handles", () => {
  const root = path.join(process.cwd(), "tests", "samples", "monorepo");
  const pkga = norm(path.join(root, "packages", "pkg-a", "src", "index.ts"));
  const pkgb = norm(path.join(root, "packages", "pkg-b", "src", "index.js"));

  it("listSymbols returns import alias handles and goToDefinitionById resolves named import", async () => {
    const index = await buildProjectIndex(root);
    const items = listSymbols(index, { file: pkgb, includeImports: true });
    const alias = items.find((i) => i.name === "aHelper");
    expect(alias).toBeTruthy();
    const res = await goToDefinitionById(index, alias!.id);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(norm(res.definition.file)).toBe(pkga);
      expect(res.definition.localName).toBe("aHelper");
    }
  });

  it("goToDefinitionById resolves default import alias to default export", async () => {
    const index = await buildProjectIndex(root);
    const items = listSymbols(index, { file: pkgb, includeImports: true });
    const alias = items.find((i) => i.name === "defA");
    expect(alias).toBeTruthy();
    const res = await goToDefinitionById(index, alias!.id);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(norm(res.definition.file)).toBe(pkga);
      // default export function name in pkg-a is aDefault
      expect(res.definition.localName).toBe("aDefault");
    }
  });

  it("goToDefinitionById resolves namespace import alias to a first exported symbol", async () => {
    const index = await buildProjectIndex(root);
    const items = listSymbols(index, { file: pkgb, includeImports: true });
    const alias = items.find((i) => i.kind === "namespaceImport" && i.name === "a");
    expect(alias).toBeTruthy();
    const res = await goToDefinitionById(index, alias!.id);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(norm(res.definition.file)).toBe(pkga);
      // First exported local in pkg-a is aHelper
      expect(res.definition.localName).toBe("aHelper");
    }
  });

  it("symbolId round-trips via defFromSymbolId", async () => {
    const index = await buildProjectIndex(root);
    const modA = index.byFile.get(pkga)!;
    const classDef = modA.locals.find((d) => d.localName === "AClass")!;
    const id = symbolId(classDef);
    const back = defFromSymbolId(index, id);
    expect(back).toBeTruthy();
    expect(back!.localName).toBe("AClass");
    expect(norm(back!.file)).toBe(pkga);
  });

  it("findReferencesById works for import alias handle", async () => {
    const index = await buildProjectIndex(root);
    const items = listSymbols(index, { file: pkgb, includeImports: true });
    const alias = items.find((i) => i.name === "aHelper");
    expect(alias).toBeTruthy();
    const refs = await findReferencesById(index, alias!.id);
    expect(refs.status).toBe("ok");
    if (refs.status === "ok") {
      expect(refs.references.length).toBeGreaterThan(0);
      // All references should exist in files of the monorepo sample
      expect(refs.references.every((r) => norm(r.file).includes(norm(root)))).toBe(true);
    }
  });
});
