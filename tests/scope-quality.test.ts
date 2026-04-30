import { describe, it, expect } from "vitest";
import {
  buildProjectIndexFromFiles,
  buildScopeIndexFromSource,
  TS_SUPPORT,
  PY_SUPPORT,
  goToDefinition,
  findReferences,
} from "../src/index.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

describe("scope index quality", () => {
  it("should not duplicate bindings in root scope", () => {
    const source = `const x = 1;`;
    const file = "test.ts";
    const scopeIndex = buildScopeIndexFromSource(file, source, TS_SUPPORT);

    const xBindings = scopeIndex.bindings.get("x");
    expect(xBindings).toBeDefined();
    expect(xBindings!.length).toBe(1);

    const xInAll = scopeIndex.all.filter((b) => b.name === "x");
    expect(xInAll.length).toBe(1);
  });

  it("should handle nested function shadowing", () => {
    const source = `
      function outer() {
        const x = 1;
        function inner() {
          const x = 2;
          return x;
        }
        return x;
      }
    `;
    const file = "test.ts";
    const scopeIndex = buildScopeIndexFromSource(file, source, TS_SUPPORT);

    const xBindings = scopeIndex.bindings.get("x");
    expect(xBindings).toBeDefined();
    expect(xBindings!.length).toBe(2);

    const x1 = xBindings!.find((b) => b.def?.start.line === 3);
    const x2 = xBindings!.find((b) => b.def?.start.line === 5);

    expect(x1).toBeDefined();
    expect(x2).toBeDefined();

    expect(x1!.occurrences.some((o) => o.start.line === 8)).toBe(true);
    expect(x2!.occurrences.some((o) => o.start.line === 6)).toBe(true);

    expect(x1!.occurrences.some((o) => o.start.line === 6)).toBe(false);
    expect(x2!.occurrences.some((o) => o.start.line === 8)).toBe(false);
  });

  it("should navigate to shadowed variables correctly", async () => {
    const source = `
      const x = 1;
      function foo() {
        const x = 2;
        console.log(x); // line 5
      }
      console.log(x); // line 7
    `;
    const root = path.resolve("temp-scope-test");
    if (!fs.existsSync(root)) fs.mkdirSync(root);
    const file = path.join(root, "test.ts").replace(/\\/g, "/");
    await fsp.writeFile(file, source);

    try {
      const index = await buildProjectIndexFromFiles(root, [file]);

      // Goto definition of x at line 5
      const res1 = await goToDefinition(index, { file, line: 5, column: 21 });
      expect(res1.status).toBe("ok");
      if (res1.status === "ok") {
        expect(res1.definition.range.start.line).toBe(4);
      }

      // Goto definition of x at line 7
      const res2 = await goToDefinition(index, { file, line: 7, column: 19 });
      expect(res2.status).toBe("ok");
      if (res2.status === "ok") {
        expect(res2.definition.range.start.line).toBe(2);
      }

      // Find references of x at line 4
      const refs1 = await findReferences(index, { file, line: 4, column: 15 });
      expect(refs1.status).toBe("ok");
      if (refs1.status === "ok") {
        expect(refs1.references.length).toBe(2); // def + line 5
        expect(refs1.references.some((r) => r.range.start.line === 5)).toBe(true);
        expect(refs1.references.some((r) => r.range.start.line === 7)).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("should NOT find references in shadowed scopes", async () => {
    const root = path.resolve("temp-refs-test");
    if (!fs.existsSync(root)) fs.mkdirSync(root);

    const libFile = path.join(root, "lib.ts").replace(/\\/g, "/");
    const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");

    await fsp.writeFile(libFile, `export const x = 1;`);
    await fsp.writeFile(
      mainFile,
      `
      import { x } from "./lib";
      console.log(x); // line 3, ref to lib.x
      function foo() {
        const x = 2;
        console.log(x); // line 6, ref to local x
      }
    `,
    );

    try {
      const index = await buildProjectIndexFromFiles(root, [libFile, mainFile]);

      // Find references of lib.x
      const libIndex = index.byFile.get(libFile)!;
      const libX = libIndex.locals.find((l) => l.localName === "x")!;

      const refs = await findReferences(index, { def: libX });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references.some((r) => r.file === mainFile && r.range.start.line === 3)).toBe(true);
        expect(refs.references.some((r) => r.file === mainFile && r.range.start.line === 6)).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("should NOT hoist nested function declarations to root scope", async () => {
    const source = `
      function outer() {
        function inner() {}
      }
    `;
    const file = "test.ts";
    const scopeIndex = buildScopeIndexFromSource(file, source, TS_SUPPORT);

    const outerBinding = scopeIndex.all.find((b) => b.name === "outer");
    const innerBinding = scopeIndex.all.find((b) => b.name === "inner");

    expect(outerBinding).toBeDefined();
    expect(innerBinding).toBeDefined();

    // Check that 'inner' is not in the root scope's map
    const rootScope = scopeIndex.allScopes.find((s) => s.kind === "module");
    expect(rootScope.map.has("outer")).toBe(true);
    expect(rootScope.map.has("inner")).toBe(false);
  });

  it("should handle Python parameter shadowing", async () => {
    const source = `
x = 1
def foo(x):
    return x
`;
    const file = "test.py";
    const scopeIndex = buildScopeIndexFromSource(file, source, PY_SUPPORT);

    const xBindings = scopeIndex.bindings.get("x");
    expect(xBindings).toBeDefined();
    expect(xBindings!.length).toBe(2);

    const globalX = xBindings!.find((b) => b.kind === "local");
    const paramX = xBindings!.find((b) => b.kind === "param");

    expect(globalX).toBeDefined();
    expect(paramX).toBeDefined();

    // Occurrence at line 4 (return x) should be paramX
    expect(paramX!.occurrences.some((o) => o.start.line === 4)).toBe(true);
    expect(globalX!.occurrences.some((o) => o.start.line === 4)).toBe(false);
  });
});
