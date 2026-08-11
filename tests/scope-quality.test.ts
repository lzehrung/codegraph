import { describe, it, expect } from "vitest";
import {
  buildProjectIndexFromFiles,
  buildScopeIndexFromSource,
  TS_SUPPORT,
  JS_SUPPORT,
  PY_SUPPORT,
  PHP_SUPPORT,
  CPP_SUPPORT,
  goToDefinition,
  findReferences,
} from "../src/index.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ImportBinding } from "../src/index.js";
import { fileIdentityKey } from "../src/util/paths.js";

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

  it("keeps JavaScript and TypeScript class method names out of lexical lookup", () => {
    const source = [
      'import { helper } from "./helper.js";',
      "class Widget {",
      "  helper() { return 1; }",
      "  run() {",
      "    return helper();",
      "  }",
      "}",
      "",
    ].join("\n");
    const cases = [
      { file: "test.js", support: JS_SUPPORT },
      { file: "test.ts", support: TS_SUPPORT },
    ];

    for (const testCase of cases) {
      const scopeIndex = buildScopeIndexFromSource(testCase.file, source, testCase.support, undefined, [
        { kind: "named", local: "helper", imported: "helper", from: "./helper.js" },
      ]);
      const helperBindings = scopeIndex.bindings.get("helper");

      expect(helperBindings).toHaveLength(1);
      expect(helperBindings![0]!.kind).toBe("importNamed");
      expect(helperBindings![0]!.occurrences.map((occurrence) => occurrence.start.line)).toEqual([5]);
    }
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
      const libIndex = index.byFile.get(fileIdentityKey(libFile))!;
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

  it("binds arrow parameters before same-named module locals for goto and references", async () => {
    const root = await fsp.mkdtemp(path.join(path.resolve(), "temp-arrow-scope-"));
    const file = path.join(root, "main.ts").replace(/\\/g, "/");
    const source = ['const value = "module";', "const mapValue = (value: string) => value.length;"].join("\n");
    const parameterIndex = source.indexOf("value", source.indexOf("mapValue"));
    const usageIndex = source.lastIndexOf("value");

    await fsp.writeFile(file, source);

    try {
      const index = await buildProjectIndexFromFiles(root, [file]);
      const goto = await goToDefinition(index, {
        file,
        line: 2,
        column: usageIndex - source.lastIndexOf("\n", usageIndex),
      });

      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.file).toBe(file);
        expect(goto.definition.range.start.index).toBe(parameterIndex);
      }

      const refs = await findReferences(index, {
        file,
        line: 2,
        column: parameterIndex - source.lastIndexOf("\n", parameterIndex),
      });

      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.definition.range.start.index).toBe(parameterIndex);
        expect(refs.references.some((reference) => reference.range.start.index === usageIndex)).toBe(true);
        expect(refs.references.some((reference) => reference.range.start.line === 1)).toBe(false);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("binds function-expression parameters through the function scope contract", () => {
    const source = [
      'const value = "module";',
      "const mapValue = function (value: string) { return value.length; };",
    ].join("\n");
    const parameterIndex = source.indexOf("value", source.indexOf("mapValue"));
    const usageIndex = source.lastIndexOf("value");
    const scopeIndex = buildScopeIndexFromSource("test.ts", source, TS_SUPPORT);
    const parameter = (scopeIndex.bindings.get("value") ?? []).find(
      (binding) => binding.kind === "param" && binding.def?.start.index === parameterIndex,
    );

    expect(parameter).toBeDefined();
    expect(parameter?.occurrences.some((occurrence) => occurrence.start.index === usageIndex)).toBe(true);
  });

  it("hoists var and function declarations to their function scope before walking references", async () => {
    const root = await fsp.mkdtemp(path.join(path.resolve(), "temp-var-scope-"));
    const file = path.join(root, "main.ts").replace(/\\/g, "/");
    const source = [
      "function moduleValue() {}",
      "function readAfterBlock() {",
      "  if (true) {",
      "    var blockValue = 1;",
      "  }",
      "  console.log(blockValue);",
      "}",
      "function readBeforeDeclaration() {",
      "  console.log(moduleValue);",
      "  var moduleValue = 1;",
      "}",
      "function callBeforeDeclaration() {",
      "  declaredLater();",
      "  function declaredLater() {}",
      "}",
    ].join("\n");
    const blockUsageIndex = source.indexOf("blockValue", source.indexOf("console.log(blockValue)"));
    const blockDeclarationIndex = source.indexOf("blockValue", source.indexOf("var blockValue"));
    const beforeDeclarationUsageIndex = source.indexOf("moduleValue", source.indexOf("console.log(moduleValue)"));
    const functionLocalDeclarationIndex = source.lastIndexOf("moduleValue");
    const functionUsageIndex = source.indexOf("declaredLater", source.indexOf("declaredLater();"));
    const functionDeclarationIndex = source.lastIndexOf("declaredLater");

    await fsp.writeFile(file, source);

    try {
      const index = await buildProjectIndexFromFiles(root, [file]);
      const afterBlock = await goToDefinition(index, {
        file,
        line: 6,
        column: blockUsageIndex - source.lastIndexOf("\n", blockUsageIndex),
      });
      const beforeDeclaration = await goToDefinition(index, {
        file,
        line: 9,
        column: beforeDeclarationUsageIndex - source.lastIndexOf("\n", beforeDeclarationUsageIndex),
      });
      const beforeFunctionDeclaration = await goToDefinition(index, {
        file,
        line: 13,
        column: functionUsageIndex - source.lastIndexOf("\n", functionUsageIndex),
      });

      expect(afterBlock.status).toBe("ok");
      if (afterBlock.status === "ok") {
        expect(afterBlock.definition.range.start.index).toBe(blockDeclarationIndex);
      }
      expect(beforeDeclaration.status).toBe("ok");
      if (beforeDeclaration.status === "ok") {
        expect(beforeDeclaration.definition.range.start.index).toBe(functionLocalDeclarationIndex);
      }
      expect(beforeFunctionDeclaration.status).toBe("ok");
      if (beforeFunctionDeclaration.status === "ok") {
        expect(beforeFunctionDeclaration.definition.range.start.index).toBe(functionDeclarationIndex);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("prefers a lexical receiver binding over a namespace import", async () => {
    const root = await fsp.mkdtemp(path.join(path.resolve(), "temp-member-shadow-"));
    const remoteFile = path.join(root, "remote.ts").replace(/\\/g, "/");
    const mainFile = path.join(root, "main.ts").replace(/\\/g, "/");
    const mainSource = [
      'import * as ns from "./remote";',
      "class LocalNamespace {",
      "  member() { return 'local'; }",
      "}",
      "function run() {",
      "  const ns = new LocalNamespace();",
      "  return ns.member();",
      "}",
    ].join("\n");
    const localMemberIndex = mainSource.indexOf("member", mainSource.indexOf("class LocalNamespace"));
    const memberUsageIndex = mainSource.indexOf("member", mainSource.indexOf("return ns.member"));

    await Promise.all([
      fsp.writeFile(remoteFile, 'export const member = "remote";'),
      fsp.writeFile(mainFile, mainSource),
    ]);

    try {
      const index = await buildProjectIndexFromFiles(root, [remoteFile, mainFile]);
      const goto = await goToDefinition(index, {
        file: mainFile,
        line: 7,
        column: memberUsageIndex - mainSource.lastIndexOf("\n", memberUsageIndex),
      });

      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.file).toBe(mainFile);
        expect(goto.definition.range.start.index).toBe(localMemberIndex);
      }
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("exposes full import binding metadata on scope import bindings", () => {
    const source = `
      import { value as localValue } from "./dep";
      console.log(localValue);
    `;
    const file = "test.ts";
    const imports: ImportBinding[] = [
      {
        kind: "named",
        local: "localValue",
        imported: "value",
        from: "./dep",
        resolved: "dep.ts",
        typeOnly: false,
      },
    ];
    const scopeIndex = buildScopeIndexFromSource(file, source, TS_SUPPORT, undefined, imports);
    const binding = scopeIndex.bindings.get("localValue")?.[0];

    expect(binding?.import?.from).toBe("./dep");
    expect(binding?.import?.resolved).toBe("dep.ts");
  });

  it("keeps unsupported require destructuring patterns as locals", () => {
    const source = `
      const { shallow, nested: { value }, explicit: alias, missing, ...rest } = require("./dep");
      const [first] = require("./dep");
      console.log(shallow, value, alias, missing, rest, first);
    `;
    const file = "test.ts";
    const imports: ImportBinding[] = [
      {
        kind: "named",
        local: "shallow",
        imported: "shallow",
        from: "./dep",
        resolved: "dep.ts",
        mechanism: "cjs",
      },
    ];
    const scopeIndex = buildScopeIndexFromSource(file, source, TS_SUPPORT, undefined, imports);
    const shallowBindings = scopeIndex.bindings.get("shallow") ?? [];
    const valueBindings = scopeIndex.bindings.get("value") ?? [];
    const firstBindings = scopeIndex.bindings.get("first") ?? [];
    const restBindings = scopeIndex.bindings.get("rest") ?? [];
    const aliasBindings = scopeIndex.bindings.get("alias") ?? [];
    const missingBindings = scopeIndex.bindings.get("missing") ?? [];

    expect(shallowBindings).toHaveLength(1);
    expect(shallowBindings[0]?.kind).toBe("importNamed");
    expect(valueBindings).toHaveLength(1);
    expect(valueBindings[0]?.kind).toBe("local");
    expect(restBindings).toHaveLength(1);
    expect(restBindings[0]?.kind).toBe("local");
    expect(aliasBindings).toHaveLength(1);
    expect(aliasBindings[0]?.kind).toBe("local");
    expect(missingBindings).toHaveLength(1);
    expect(missingBindings[0]?.kind).toBe("local");
    expect(firstBindings).toHaveLength(1);
    expect(firstBindings[0]?.kind).toBe("local");
  });

  it("keeps dynamic require declarations as locals", () => {
    const source = `
      const moduleName = "./dep";
      const dynamicDep = require(moduleName);
      console.log(dynamicDep);
    `;
    const file = "test.ts";
    const scopeIndex = buildScopeIndexFromSource(file, source, TS_SUPPORT);
    const dynamicBindings = scopeIndex.bindings.get("dynamicDep") ?? [];

    expect(dynamicBindings).toHaveLength(1);
    expect(dynamicBindings[0]?.kind).toBe("local");
  });

  it("tracks generator function parameters", () => {
    const source = `
      function* streamItems(input: string) {
        yield input;
      }
    `;
    const file = "test.ts";
    const scopeIndex = buildScopeIndexFromSource(file, source, TS_SUPPORT);
    const inputBindings = scopeIndex.bindings.get("input") ?? [];

    expect(inputBindings).toHaveLength(1);
    expect(inputBindings[0]?.kind).toBe("param");
  });

  it("indexes enum cases without flattening them into lexical lookup", () => {
    const source = `
      <?php
      enum PrimaryMode
      {
          case Ready;
      }
      enum SecondaryMode
      {
          case Ready;
      }
      $mode = PrimaryMode::Ready;
    `;
    const file = "test.php";
    const scopeIndex = buildScopeIndexFromSource(file, source, PHP_SUPPORT);
    const readyBindings = scopeIndex.bindings.get("Ready") ?? [];
    const rootReadyBinding = scopeIndex.allScopes[0]?.map.get("Ready");

    expect(readyBindings).toHaveLength(2);
    expect(readyBindings.every((binding) => binding.kind === "local")).toBeTruthy();
    expect(rootReadyBinding).toBeUndefined();
  });

  it("keeps scoped C++ enum class cases out of lexical lookup", () => {
    const source = `
      enum class PrimaryMode {
        Ready,
      };
      enum class SecondaryMode {
        Ready,
      };
      auto mode = PrimaryMode::Ready;
    `;
    const file = "test.cpp";
    const scopeIndex = buildScopeIndexFromSource(file, source, CPP_SUPPORT);
    const readyBindings = scopeIndex.bindings.get("Ready") ?? [];
    const rootReadyBinding = scopeIndex.allScopes[0]?.map.get("Ready");

    expect(readyBindings).toHaveLength(2);
    expect(readyBindings.every((binding) => binding.kind === "local")).toBeTruthy();
    expect(rootReadyBinding).toBeUndefined();
  });
});
