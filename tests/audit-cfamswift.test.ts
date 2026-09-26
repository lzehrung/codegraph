import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defNodeId } from "../src/graphs/symbol-graph.js";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../src/index.js";

function columnOf(source: string, line: number, needle: string, occurrence = 0): number {
  const text = source.split("\n")[line - 1] ?? "";
  let from = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const found = text.indexOf(needle, from);
    if (found < 0) throw new Error(`missing ${JSON.stringify(needle)} on line ${line}: ${text}`);
    if (index === occurrence) return found + 1;
    from = found + needle.length;
  }
  throw new Error(`missing ${JSON.stringify(needle)} on line ${line}`);
}

function site(file: string, line: number, column: number): string {
  return `${path.basename(file)}:${line}:${column}`;
}

async function withProject(
  prefix: string,
  files: Record<string, string>,
  run: (ctx: { index: ProjectIndex; paths: Record<string, string> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    const paths: Record<string, string> = {};
    for (const [name, source] of Object.entries(files)) {
      const file = path.join(root, name).replace(/\\/g, "/");
      await writeFile(file, source, "utf8");
      paths[name] = file;
    }
    const index = await buildProjectIndex(root, { cache: "off" });
    await run({ index, paths });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function referenceSites(index: ProjectIndex, file: string, line: number, column: number): Promise<string[]> {
  const result = await findReferences(index, { file, line, column });
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error(result.reason ?? "references not found");
  expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
  return result.references
    .map((reference) => site(reference.file, reference.range.start.line, reference.range.start.column))
    .sort();
}

describe("C header prototype and definition", () => {
  const shapesH = ["int add(int, int);", "int add_more(int, int, int);", ""].join("\n");
  const shapesC = [
    '#include "shapes.h"',
    '#include "common.h"',
    "int add(int left, int right) {",
    "  return left + right;",
    "}",
    "int add_more(int left, int right, int extra) {",
    "  return left + right + extra;",
    "}",
    "",
  ].join("\n");
  const mainC = ['#include "shapes.h"', "int main(void) {", "  return add(1, 2);", "}", ""].join("\n");
  const commonH = ["int ready(void);", ""].join("\n");
  const extraC = ['#include "common.h"', "int add(int left, int right) {", "  return 0;", "}", ""].join("\n");
  const localC = ['#include "shapes.h"', "static int add(int left, int right) {", "  return 1;", "}", ""].join("\n");

  it("links an include-connected prototype and definition, and keeps decoys out", async () => {
    await withProject(
      "cg-cfam-c-",
      {
        "shapes.h": shapesH,
        "shapes.c": shapesC,
        "main.c": mainC,
        "common.h": commonH,
        "extra.c": extraC,
        "local.c": localC,
      },
      async ({ index, paths }) => {
        const header = paths["shapes.h"]!;
        const source = paths["shapes.c"]!;
        const main = paths["main.c"]!;
        const extra = paths["extra.c"]!;
        const local = paths["local.c"]!;
        const prototype = { line: 1, column: columnOf(shapesH, 1, "add") };
        const definition = { line: 3, column: columnOf(shapesC, 3, "add") };
        const call = { line: 3, column: columnOf(mainC, 3, "add") };
        const morePrototype = { line: 2, column: columnOf(shapesH, 2, "add_more") };
        const moreDefinition = { line: 6, column: columnOf(shapesC, 6, "add_more") };
        const unlinked = { line: 2, column: columnOf(extraC, 2, "add") };
        const hidden = { line: 2, column: columnOf(localC, 2, "add") };
        const expected = [
          site(header, prototype.line, prototype.column),
          site(source, definition.line, definition.column),
          site(main, call.line, call.column),
        ].sort();

        expect(await referenceSites(index, header, prototype.line, prototype.column)).toEqual(expected);
        expect(await referenceSites(index, source, definition.line, definition.column)).toEqual(expected);

        const moreExpected = [
          site(header, morePrototype.line, morePrototype.column),
          site(source, moreDefinition.line, moreDefinition.column),
        ].sort();
        expect(await referenceSites(index, header, morePrototype.line, morePrototype.column)).toEqual(moreExpected);
        expect(await referenceSites(index, extra, unlinked.line, unlinked.column)).toEqual([
          site(extra, unlinked.line, unlinked.column),
        ]);
        expect(await referenceSites(index, local, hidden.line, hidden.column)).toEqual([
          site(local, hidden.line, hidden.column),
        ]);

        const callTarget = await goToDefinition(index, { file: main, line: call.line, column: call.column });
        expect(callTarget.status).toBe("ok");
        if (callTarget.status !== "ok") throw new Error(callTarget.reason ?? "call did not resolve");
        expect(path.basename(callTarget.definition.file)).toBe("shapes.h");
        expect(callTarget.definition.range.start.line).toBe(prototype.line);
      },
    );
  });
});

describe("C++ using-directives", () => {
  const toolsH = [
    "namespace tools {",
    "  int add(int left, int right) { return left + right; }",
    "  int add(const char* text) { return 1; }",
    "  int value = 4;",
    "}",
    "namespace unused {",
    "  int add(int left, int right) { return 9; }",
    "}",
    "",
  ].join("\n");

  it("resolves a bare call through a file-scope directive and ignores decoys", async () => {
    const mainCpp = [
      '#include "tools.hpp"',
      "using namespace tools;",
      "int main() {",
      "  return add(1, 2);",
      "}",
      "int read_value() {",
      "  return value;",
      "}",
      "",
    ].join("\n");
    await withProject("cg-cfam-cpp-file-", { "tools.hpp": toolsH, "main.cpp": mainCpp }, async ({ index, paths }) => {
      const header = paths["tools.hpp"]!;
      const main = paths["main.cpp"]!;
      const call = { line: 4, column: columnOf(mainCpp, 4, "add") };
      const valueUse = { line: 7, column: columnOf(mainCpp, 7, "value") };
      const addDef = { line: 2, column: columnOf(toolsH, 2, "add") };
      const textDef = { line: 3, column: columnOf(toolsH, 3, "add") };
      const unusedDef = { line: 7, column: columnOf(toolsH, 7, "add") };
      const valueDef = { line: 4, column: columnOf(toolsH, 4, "value") };

      const resolved = await goToDefinition(index, { file: main, line: call.line, column: call.column });
      expect(resolved.status).toBe("ok");
      if (resolved.status !== "ok") throw new Error(resolved.reason ?? "using-directive call did not resolve");
      expect(path.basename(resolved.definition.file)).toBe("tools.hpp");
      expect(resolved.definition.range.start.line).toBe(addDef.line);

      const callSites = await referenceSites(index, header, addDef.line, addDef.column);
      expect(callSites).toContain(site(main, call.line, call.column));
      expect(callSites).not.toContain(site(header, textDef.line, textDef.column));
      expect(callSites).not.toContain(site(header, unusedDef.line, unusedDef.column));
      const textSites = await referenceSites(index, header, textDef.line, textDef.column);
      expect(textSites).not.toContain(site(main, call.line, call.column));
      const unusedSites = await referenceSites(index, header, unusedDef.line, unusedDef.column);
      expect(unusedSites).not.toContain(site(main, call.line, call.column));

      const valueResolved = await goToDefinition(index, { file: main, line: valueUse.line, column: valueUse.column });
      expect(valueResolved.status).toBe("ok");
      if (valueResolved.status !== "ok")
        throw new Error(valueResolved.reason ?? "using-directive variable did not resolve");
      expect(valueResolved.definition.range.start.line).toBe(valueDef.line);
      const valueSites = await referenceSites(index, header, valueDef.line, valueDef.column);
      expect(valueSites).toContain(site(main, valueUse.line, valueUse.column));

      const detailed = await buildSymbolGraphDetailed(index);
      const callEdges = detailed.edges.filter(
        (edge) => edge.label === "calls" && edge.to === defNodeId(resolved.definition),
      );
      expect(callEdges.some((edge) => edge.site?.range.start.line === call.line)).toBe(true);
    });
  });

  it("applies a directive written in an included header, including through that header's includes", async () => {
    const exposed = [
      "namespace tools {",
      "  int add(int left, int right) { return left + right; }",
      "}",
      "using namespace tools;",
      "",
    ].join("\n");
    const directCpp = ['#include "exposed.hpp"', "int main() {", "  return add(1, 2);", "}", ""].join("\n");
    const wrapped = ['#include "tools.hpp"', "using namespace tools;", ""].join("\n");
    const wrappedCpp = ['#include "use.hpp"', "int main() {", "  return add(1, 2);", "}", ""].join("\n");
    await withProject(
      "cg-cfam-cpp-header-",
      {
        "exposed.hpp": exposed,
        "direct.cpp": directCpp,
        "tools.hpp": toolsH,
        "use.hpp": wrapped,
        "wrapped.cpp": wrappedCpp,
      },
      async ({ index, paths }) => {
        const direct = paths["direct.cpp"]!;
        const wrappedFile = paths["wrapped.cpp"]!;
        const exposedFile = paths["exposed.hpp"]!;
        const call = { line: 3, column: columnOf(directCpp, 3, "add") };
        const resolved = await goToDefinition(index, { file: direct, line: call.line, column: call.column });
        expect(resolved.status).toBe("ok");
        if (resolved.status !== "ok") throw new Error(resolved.reason ?? "header using-directive did not resolve");
        expect(path.basename(resolved.definition.file)).toBe("exposed.hpp");
        expect(resolved.definition.range.start.line).toBe(2);
        const sites = await referenceSites(index, exposedFile, 2, columnOf(exposed, 2, "add"));
        expect(sites).toContain(site(direct, call.line, call.column));
        const detailed = await buildSymbolGraphDetailed(index);
        expect(
          detailed.edges.some(
            (edge) =>
              edge.label === "calls" &&
              edge.to === defNodeId(resolved.definition) &&
              edge.site?.range.start.line === call.line,
          ),
        ).toBe(true);

        const hidden = await goToDefinition(index, {
          file: wrappedFile,
          line: 3,
          column: columnOf(wrappedCpp, 3, "add"),
        });
        expect(hidden.status).toBe("ok");
        if (hidden.status !== "ok") throw new Error(hidden.reason ?? "included using-directive did not resolve");
        expect(path.basename(hidden.definition.file)).toBe("tools.hpp");
        expect(hidden.definition.range.start.line).toBe(2);
      },
    );
  });

  it("applies a namespace-scope directive inside that namespace only", async () => {
    const mainCpp = [
      '#include "tools.hpp"',
      "namespace app {",
      "  using namespace tools;",
      "  int inside() { return add(1, 2); }",
      "}",
      "int outside() { return add(1, 2); }",
      "namespace app {",
      "  namespace nested {",
      "    int deeper() { return add(3, 4); }",
      "  }",
      "}",
      "",
    ].join("\n");
    const opened = [
      '#include "tools.hpp"',
      "using namespace tools;",
      "namespace app {",
      "  int nested() { return add(1, 2); }",
      "}",
      "",
    ].join("\n");
    await withProject(
      "cg-cfam-cpp-ns-",
      { "tools.hpp": toolsH, "main.cpp": mainCpp, "opened.cpp": opened },
      async ({ index, paths }) => {
        const header = paths["tools.hpp"]!;
        const main = paths["main.cpp"]!;
        const openedFile = paths["opened.cpp"]!;
        const inside = { line: 4, column: columnOf(mainCpp, 4, "add") };
        const outside = { line: 6, column: columnOf(mainCpp, 6, "add") };
        const deeper = { line: 9, column: columnOf(mainCpp, 9, "add") };
        const nested = { line: 4, column: columnOf(opened, 4, "add") };
        const addDef = { line: 2, column: columnOf(toolsH, 2, "add") };

        const insideTarget = await goToDefinition(index, { file: main, line: inside.line, column: inside.column });
        expect(insideTarget.status).toBe("ok");
        if (insideTarget.status !== "ok") throw new Error(insideTarget.reason ?? "namespace using did not resolve");
        expect(insideTarget.definition.range.start.line).toBe(addDef.line);
        const deeperTarget = await goToDefinition(index, { file: main, line: deeper.line, column: deeper.column });
        expect(deeperTarget.status).toBe("ok");
        if (deeperTarget.status !== "ok")
          throw new Error(deeperTarget.reason ?? "nested namespace using did not resolve");
        expect(deeperTarget.definition.range.start.line).toBe(addDef.line);
        const outsideTarget = await goToDefinition(index, { file: main, line: outside.line, column: outside.column });
        expect(outsideTarget.status).toBe("not_found");
        const nestedTarget = await goToDefinition(index, {
          file: openedFile,
          line: nested.line,
          column: nested.column,
        });
        expect(nestedTarget.status).toBe("ok");
        if (nestedTarget.status !== "ok")
          throw new Error(nestedTarget.reason ?? "file-scope using did not apply inside a namespace");
        expect(nestedTarget.definition.range.start.line).toBe(addDef.line);

        const sites = await referenceSites(index, header, addDef.line, addDef.column);
        expect(sites).toContain(site(main, inside.line, inside.column));
        expect(sites).toContain(site(main, deeper.line, deeper.column));
        expect(sites).toContain(site(openedFile, nested.line, nested.column));
        expect(sites).not.toContain(site(main, outside.line, outside.column));

        const detailed = await buildSymbolGraphDetailed(index);
        const targeted = detailed.edges.filter(
          (edge) =>
            edge.label === "calls" &&
            edge.to === defNodeId(insideTarget.definition) &&
            edge.site?.file.endsWith("main.cpp"),
        );
        expect(targeted.map((edge) => edge.site?.range.start.line).sort()).toEqual([inside.line, deeper.line]);
      },
    );
  });

  it("leaves two same-arity used namespaces unresolved, reports partial coverage, and still separates different arities", async () => {
    const ambigH = [
      "namespace tools {",
      "  int add(int left, int right) { return left + right; }",
      "}",
      "namespace other {",
      "  int add(double left, double right) { return 9; }",
      "}",
      "",
    ].join("\n");
    const ambiguousCpp = [
      '#include "ambig.hpp"',
      "using namespace tools;",
      "using namespace other;",
      "int main() {",
      "  return add(1, 2);",
      "}",
      "",
    ].join("\n");
    // Separate namespace names: `tools::add(int, int)` in both headers would be one C++ entity,
    // so the unchecked call in ambiguous.cpp would correctly make this list partial too.
    const splitH = [
      "namespace pair {",
      "  int add(int left, int right) { return left + right; }",
      "}",
      "namespace single {",
      "  int add(int only) { return only; }",
      "}",
      "",
    ].join("\n");
    const splitCpp = [
      '#include "split.hpp"',
      "using namespace pair;",
      "using namespace single;",
      "int two() { return add(1, 2); }",
      "int one() { return add(1); }",
      "",
    ].join("\n");

    await withProject(
      "cg-cfam-cpp-ambig-",
      { "ambig.hpp": ambigH, "ambiguous.cpp": ambiguousCpp, "split.hpp": splitH, "split.cpp": splitCpp },
      async ({ index, paths }) => {
        const header = paths["ambig.hpp"]!;
        const ambiguous = paths["ambiguous.cpp"]!;
        const splitHeader = paths["split.hpp"]!;
        const split = paths["split.cpp"]!;
        const call = { line: 5, column: columnOf(ambiguousCpp, 5, "add") };
        const toolsAdd = { line: 2, column: columnOf(ambigH, 2, "add") };
        const otherSame = { line: 5, column: columnOf(ambigH, 5, "add") };
        const ambiguousTarget = await goToDefinition(index, {
          file: ambiguous,
          line: call.line,
          column: call.column,
        });
        expect(ambiguousTarget.status).toBe("not_found");
        // Valid C++ picks tools::add by parameter type. Codegraph does not rank overloads, so
        // the call joins neither list, and both lists admit an unchecked use in that file.
        for (const declaration of [toolsAdd, otherSame]) {
          const refs = await findReferences(index, { file: header, ...declaration });
          expect(refs.status).toBe("ok");
          if (refs.status !== "ok") throw new Error(refs.reason ?? "references not found");
          expect(
            refs.references.map((reference) =>
              site(reference.file, reference.range.start.line, reference.range.start.column),
            ),
          ).not.toContain(site(ambiguous, call.line, call.column));
          expect(refs.referenceCoverage).toEqual({
            scope: "indexed_candidates",
            state: "partial",
            reasons: ["strategy_unavailable"],
            affectedFiles: [ambiguous],
          });
        }
        const detailed = await buildSymbolGraphDetailed(index);
        expect(detailed.edges.some((edge) => edge.label === "calls" && edge.site?.file.endsWith("ambiguous.cpp"))).toBe(
          false,
        );

        const two = { line: 4, column: columnOf(splitCpp, 4, "add") };
        const one = { line: 5, column: columnOf(splitCpp, 5, "add") };
        const twoTarget = await goToDefinition(index, { file: split, line: two.line, column: two.column });
        const oneTarget = await goToDefinition(index, { file: split, line: one.line, column: one.column });
        expect(twoTarget.status).toBe("ok");
        expect(oneTarget.status).toBe("ok");
        if (twoTarget.status !== "ok" || oneTarget.status !== "ok") throw new Error("arity split did not resolve");
        expect(twoTarget.definition.range.start.line).toBe(2);
        expect(oneTarget.definition.range.start.line).toBe(5);
        expect(path.basename(twoTarget.definition.file)).toBe("split.hpp");
        expect(path.basename(oneTarget.definition.file)).toBe("split.hpp");
        const twoSites = await referenceSites(index, splitHeader, 2, columnOf(splitH, 2, "add"));
        const oneSites = await referenceSites(index, splitHeader, 5, columnOf(splitH, 5, "add"));
        expect(twoSites).toContain(site(split, two.line, two.column));
        expect(twoSites).not.toContain(site(split, one.line, one.column));
        expect(oneSites).toContain(site(split, one.line, one.column));
        expect(oneSites).not.toContain(site(split, two.line, two.column));
      },
    );
  });

  it("ignores a block-scope directive, a directive after the use, and a same-file local", async () => {
    const blocked = [
      '#include "tools.hpp"',
      "int main() {",
      "  using namespace tools;",
      "  return add(1, 2);",
      "}",
      "",
    ].join("\n");
    const ordered = [
      '#include "tools.hpp"',
      "int early() { return add(1, 2); }",
      "using namespace tools;",
      "int late() { return add(1, 2); }",
      "",
    ].join("\n");
    const shadowed = [
      '#include "tools.hpp"',
      "int add(int left, int right) { return 0; }",
      "using namespace tools;",
      "int main() { return add(1, 2); }",
      "",
    ].join("\n");
    await withProject(
      "cg-cfam-cpp-shadow-",
      {
        "tools.hpp": toolsH,
        "blocked.cpp": blocked,
        "ordered.cpp": ordered,
        "shadowed.cpp": shadowed,
      },
      async ({ index, paths }) => {
        const blockedFile = paths["blocked.cpp"]!;
        const orderedFile = paths["ordered.cpp"]!;
        const shadowedFile = paths["shadowed.cpp"]!;
        const blockedCall = await goToDefinition(index, {
          file: blockedFile,
          line: 4,
          column: columnOf(blocked, 4, "add"),
        });
        expect(blockedCall.status).toBe("not_found");
        const early = await goToDefinition(index, {
          file: orderedFile,
          line: 2,
          column: columnOf(ordered, 2, "add"),
        });
        expect(early.status).toBe("not_found");
        const late = await goToDefinition(index, {
          file: orderedFile,
          line: 4,
          column: columnOf(ordered, 4, "add"),
        });
        expect(late.status).toBe("ok");
        if (late.status !== "ok") throw new Error(late.reason ?? "later using-directive did not resolve");
        expect(path.basename(late.definition.file)).toBe("tools.hpp");
        const localCall = await goToDefinition(index, {
          file: shadowedFile,
          line: 4,
          column: columnOf(shadowed, 4, "add"),
        });
        expect(localCall.status).toBe("ok");
        if (localCall.status !== "ok") throw new Error(localCall.reason ?? "local add did not resolve");
        expect(path.basename(localCall.definition.file)).toBe("shadowed.cpp");
        expect(localCall.definition.range.start.line).toBe(2);
      },
    );
  });

  it("applies a header's directive only to uses after the #include that brings it in", async () => {
    const toolsHpp = ["namespace tools {", "  int add(int left, int right) { return left + right; }", "}", ""].join(
      "\n",
    );
    const usingHpp = ['#include "tools.hpp"', "using namespace tools;", ""].join("\n");
    const mainCpp = [
      '#include "tools.hpp"',
      "int early() { return add(1, 2); }",
      '#include "using.hpp"',
      "int late() { return add(1, 2); }",
      "",
    ].join("\n");
    await withProject(
      "cg-cfam-cpp-include-order-",
      { "tools.hpp": toolsHpp, "using.hpp": usingHpp, "main.cpp": mainCpp },
      async ({ index, paths }) => {
        const main = paths["main.cpp"]!;
        // Before `using.hpp`, the translation unit has no directive: `add` names nothing.
        const early = await goToDefinition(index, { file: main, line: 2, column: columnOf(mainCpp, 2, "add") });
        expect(early.status).toBe("not_found");
        const late = await goToDefinition(index, { file: main, line: 4, column: columnOf(mainCpp, 4, "add") });
        expect(late.status).toBe("ok");
        if (late.status !== "ok") throw new Error(late.reason ?? "late add did not resolve");
        expect(path.basename(late.definition.file)).toBe("tools.hpp");
        const sites = await referenceSites(index, paths["tools.hpp"]!, 2, columnOf(toolsHpp, 2, "add"));
        expect(sites).toContain(site(main, 4, columnOf(mainCpp, 4, "add")));
        expect(sites).not.toContain(site(main, 2, columnOf(mainCpp, 2, "add")));
      },
    );
  });
});

describe("Swift self member through a shadowing name", () => {
  const widget = [
    "class Widget {",
    "    let name: String",
    "    init(name: String) {",
    "        self.name = name",
    "    }",
    "    func echoed() -> String {",
    "        return self.name",
    "    }",
    "    func shadowed() -> String {",
    '        let name = "local"',
    "        return self.name + name",
    "    }",
    "}",
    "",
    "class Other {",
    "    let name: String",
    "    init(name: String) {",
    "        self.name = name",
    "    }",
    "}",
    "",
    "extension Widget {",
    "    func label() -> String {",
    "        return self.name",
    "    }",
    "}",
    "",
  ].join("\n");
  const remote = [
    "extension Widget {",
    "    func remote() -> String {",
    "        return self.name",
    "    }",
    "}",
    "",
  ].join("\n");

  it("binds self.name to the property and the bare name to the parameter or local", async () => {
    await withProject(
      "cg-cfam-swift-",
      { "Widget.swift": widget, "Remote.swift": remote },
      async ({ index, paths }) => {
        const file = paths["Widget.swift"]!;
        const remoteFile = paths["Remote.swift"]!;
        const property = { line: 2, column: columnOf(widget, 2, "name") };
        const parameter = { line: 3, column: columnOf(widget, 3, "name") };
        const initMember = { line: 4, column: columnOf(widget, 4, "self.name") + "self.".length };
        const initBare = { line: 4, column: columnOf(widget, 4, "= name") + "= ".length };
        const echoed = { line: 7, column: columnOf(widget, 7, "self.name") + "self.".length };
        const local = { line: 10, column: columnOf(widget, 10, "name") };
        const shadowedMember = { line: 11, column: columnOf(widget, 11, "self.name") + "self.".length };
        const shadowedBare = { line: 11, column: columnOf(widget, 11, "+ name") + "+ ".length };
        const otherProperty = { line: 16, column: columnOf(widget, 16, "name") };
        const otherMember = { line: 18, column: columnOf(widget, 18, "self.name") + "self.".length };
        const otherBare = { line: 18, column: columnOf(widget, 18, "= name") + "= ".length };
        const label = { line: 24, column: columnOf(widget, 24, "self.name") + "self.".length };
        const remoteMember = { line: 3, column: columnOf(remote, 3, "self.name") + "self.".length };

        const memberLines = [initMember, echoed, shadowedMember, label];
        for (const member of memberLines) {
          const result = await goToDefinition(index, { file, line: member.line, column: member.column });
          expect(result.status).toBe("ok");
          if (result.status !== "ok") throw new Error(result.reason ?? "self.name did not resolve");
          expect(result.definition.range.start.line).toBe(property.line);
          expect(result.definition.range.start.column).toBe(property.column);
        }
        const remoteResult = await goToDefinition(index, {
          file: remoteFile,
          line: remoteMember.line,
          column: remoteMember.column,
        });
        expect(remoteResult.status).toBe("ok");
        if (remoteResult.status !== "ok") throw new Error(remoteResult.reason ?? "extension self.name did not resolve");
        expect(path.basename(remoteResult.definition.file)).toBe("Widget.swift");
        expect(remoteResult.definition.range.start.line).toBe(property.line);

        const bare = await goToDefinition(index, { file, line: initBare.line, column: initBare.column });
        expect(bare.status).toBe("ok");
        if (bare.status !== "ok") throw new Error(bare.reason ?? "bare name did not resolve");
        expect(bare.definition.range.start.line).toBe(parameter.line);
        expect(bare.definition.range.start.column).toBe(parameter.column);

        const localBare = await goToDefinition(index, { file, line: shadowedBare.line, column: shadowedBare.column });
        expect(localBare.status).toBe("ok");
        if (localBare.status !== "ok") throw new Error(localBare.reason ?? "local name did not resolve");
        expect(localBare.definition.range.start.line).toBe(local.line);

        const other = await goToDefinition(index, { file, line: otherMember.line, column: otherMember.column });
        expect(other.status).toBe("ok");
        if (other.status !== "ok") throw new Error(other.reason ?? "other self.name did not resolve");
        expect(other.definition.range.start.line).toBe(otherProperty.line);

        const propertySites = await referenceSites(index, file, property.line, property.column);
        for (const member of memberLines) {
          expect(propertySites).toContain(site(file, member.line, member.column));
        }
        expect(propertySites).toContain(site(remoteFile, remoteMember.line, remoteMember.column));
        expect(propertySites).not.toContain(site(file, parameter.line, parameter.column));
        expect(propertySites).not.toContain(site(file, initBare.line, initBare.column));
        expect(propertySites).not.toContain(site(file, local.line, local.column));
        expect(propertySites).not.toContain(site(file, shadowedBare.line, shadowedBare.column));
        expect(propertySites).not.toContain(site(file, otherProperty.line, otherProperty.column));
        expect(propertySites).not.toContain(site(file, otherMember.line, otherMember.column));

        const parameterSites = await referenceSites(index, file, parameter.line, parameter.column);
        expect(parameterSites).toContain(site(file, initBare.line, initBare.column));
        expect(parameterSites).not.toContain(site(file, initMember.line, initMember.column));
        expect(parameterSites).not.toContain(site(file, echoed.line, echoed.column));
        expect(parameterSites).not.toContain(site(file, otherBare.line, otherBare.column));
      },
    );
  });
});
