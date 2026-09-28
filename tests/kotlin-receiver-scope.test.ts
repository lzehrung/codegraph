import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildProjectIndex, buildSymbolGraphDetailed, findReferences, goToDefinition } from "../src/index.js";
import { mkTmpDir, normalizeTestPath } from "./helpers/filesystem.js";

/**
 * Kotlin receiver scope: an instance method invoked through the type name is invalid Kotlin and
 * must not resolve or count as a reference, while companion-object members still do; a member
 * call beside a referenced constructor property resolves. Each case asserts goToDefinition,
 * findReferences (including `referenceCoverage.state`), and `buildSymbolGraphDetailed`
 * `calls` edges where they apply, plus a decoy that must NOT match.
 *
 * The same-file constructor-property shapes are covered with and without a package
 * declaration. The JVM unnamed-package limit (files without a `package` clause are a
 * single-file unit) is documented and stays, so the two-default-package-file case must answer
 * `not_found` with `partial` reference coverage rather than claim `complete` over the missed use.
 */

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(prefix: string, files: Record<string, string>) {
  const root = normalizeTestPath(await mkTmpDir(prefix));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const target = path.join(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, text);
  }
  const index = await buildProjectIndex(root, { cache: "off" });
  return { root, index, f: (rel: string) => normalizeTestPath(path.join(root, rel)) };
}

function locate(text: string, needle: string, occurrence = 0): { line: number; column: number } {
  let idx = -1;
  for (let i = 0; i <= occurrence; i += 1) {
    idx = text.indexOf(needle, idx + 1);
    if (idx < 0) throw new Error(`needle "${needle}" occurrence ${occurrence} not found`);
  }
  const before = text.slice(0, idx);
  const lastNewline = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: idx - lastNewline };
}

describe("Kotlin receiver scope and constructor-property members", () => {
  describe("a bare type-name receiver reaches only companion-object members", () => {
    const text = [
      "package p",
      "",
      "class Box {",
      '  fun instanceHelper(): String = "hi"',
      "  companion object {",
      "    fun create(): Box = Box()",
      "  }",
      "}",
      "",
      "class Decoy {",
      '  fun instanceHelper(): String = "decoy"',
      "  fun create(): Decoy = Decoy()",
      "}",
      "",
      "fun useInvalid(): String {",
      "  return Box.instanceHelper()",
      "}",
      "",
      "fun makeBox(): Box {",
      "  return Box.create()",
      "}",
      "",
    ].join("\n");

    it("goToDefinition on Box.instanceHelper() is not_found (invalid Kotlin, instance member via type name)", async () => {
      const p = await fixture("cg-goto-", { "Box.kt": text });
      const goto = await goToDefinition(p.index, { file: p.f("Box.kt"), ...locate(text, "instanceHelper", 2) });
      expect(goto.status).toBe("not_found");
    });

    it("findReferences on the instance method excludes the invalid Box.instanceHelper() call and the decoy", async () => {
      const p = await fixture("cg-refs-", { "Box.kt": text });
      const callSite = locate(text, "instanceHelper", 2);
      const refs = await findReferences(p.index, { file: p.f("Box.kt"), ...locate(text, "instanceHelper", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        const atCallSite = refs.references.filter(
          (ref) => ref.file === p.f("Box.kt") && ref.range.start.line === callSite.line,
        );
        expect(atCallSite).toHaveLength(0);
        for (const ref of refs.references) {
          expect(ref.range.start.line).not.toBe(locate(text, "instanceHelper", 1).line);
        }
        // `Box` resolves to a class whose static (companion) scope has no `instanceHelper`, and it
        // has no unresolved supertype, so the invalid call is a proven non-reference, not an
        // unverified candidate: coverage stays complete (the classified-receiver coverage rule).
        expect(refs.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
      }
    });

    it("the companion factory Box.create() still resolves, and the detailed graph records its call edge", async () => {
      const p = await fixture("cg-companion-", { "Box.kt": text });
      const goto = await goToDefinition(p.index, { file: p.f("Box.kt"), ...locate(text, "create", 2) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.localName).toBe("create");
        expect(goto.definition.range.start.line).toBe(locate(text, "create", 0).line);
      }

      const refs = await findReferences(p.index, { file: p.f("Box.kt"), ...locate(text, "create", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references).toHaveLength(2);
        expect(refs.referenceCoverage.state).toBe("complete");
      }

      const graph = await buildSymbolGraphDetailed(p.index);
      const createCalls = graph.edges.filter(
        (edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "create",
      );
      expect(createCalls).toHaveLength(1);
      const helperCalls = graph.edges.filter(
        (edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "instanceHelper",
      );
      expect(helperCalls).toHaveLength(0);
    });

    it("decoy: a same-named instance method and factory on an unrelated class are not matched", async () => {
      const p = await fixture("cg-decoy-", { "Box.kt": text });
      const decoyHelperLine = locate(text, "instanceHelper", 1).line;
      const decoyCreateLine = locate(text, "create", 1).line;

      const helperRefs = await findReferences(p.index, { file: p.f("Box.kt"), ...locate(text, "instanceHelper", 0) });
      expect(helperRefs.status).toBe("ok");
      if (helperRefs.status === "ok") {
        for (const ref of helperRefs.references) expect(ref.range.start.line).not.toBe(decoyHelperLine);
      }

      const createRefs = await findReferences(p.index, { file: p.f("Box.kt"), ...locate(text, "create", 0) });
      expect(createRefs.status).toBe("ok");
      if (createRefs.status === "ok") {
        for (const ref of createRefs.references) expect(ref.range.start.line).not.toBe(decoyCreateLine);
      }

      const createGoto = await goToDefinition(p.index, { file: p.f("Box.kt"), ...locate(text, "create", 2) });
      expect(createGoto.status).toBe("ok");
      if (createGoto.status === "ok") expect(createGoto.definition.range.start.line).not.toBe(decoyCreateLine);
    });
  });

  describe("member call beside a referenced constructor property", () => {
    const body = [
      "class Gadget(val name: String) {",
      '  fun describe(): String = "x:" + name',
      "}",
      "",
      "class Other {",
      '  fun describe(): String = "other"',
      "}",
      "",
      "fun use() {",
      '  val g = Gadget("y")',
      "  g.describe()",
      "}",
      "",
    ].join("\n");

    async function expectResolvedSameFile(prefix: string, text: string) {
      const p = await fixture(prefix, { "G.kt": text });
      const callSite = locate(text, "describe", 2);

      const goto = await goToDefinition(p.index, { file: p.f("G.kt"), ...callSite });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") {
        expect(goto.definition.localName).toBe("describe");
        expect(path.basename(goto.definition.file)).toBe("G.kt");
        expect(goto.definition.range.start.line).toBe(locate(text, "describe", 0).line);
      }

      const refs = await findReferences(p.index, { file: p.f("G.kt"), ...locate(text, "describe", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        expect(refs.references).toHaveLength(2);
        expect(refs.references.map((ref) => ref.range.start.line)).toContain(callSite.line);
        expect(refs.referenceCoverage.state).toBe("complete");
        for (const ref of refs.references) expect(ref.range.start.line).not.toBe(locate(text, "describe", 1).line);
      }

      const graph = await buildSymbolGraphDetailed(p.index);
      const describeCalls = graph.edges.filter(
        (edge) => edge.label === "calls" && graph.nodes.get(edge.to)?.name === "describe",
      );
      expect(describeCalls).toHaveLength(1);

      // The constructor property reference inside describe resolves to the class header.
      const nameGoto = await goToDefinition(p.index, { file: p.f("G.kt"), ...locate(text, "name", 1) });
      expect(nameGoto.status).toBe("ok");
      if (nameGoto.status === "ok") {
        expect(nameGoto.definition.localName).toBe("name");
        expect(nameGoto.definition.range.start.line).toBe(locate(text, "name", 0).line);
      }
    }

    it("same file without a package declaration: g.describe() resolves with refs complete and a calls edge", async () => {
      await expectResolvedSameFile("cg-default-", body);
    });

    it("same file with a package declaration: g.describe() resolves with refs complete and a calls edge", async () => {
      await expectResolvedSameFile("cg-packaged-", "package p\n" + body);
    });

    it("decoy: the decoy class's own describe is not matched", async () => {
      const text = body;
      const p = await fixture("cg-decoy-", { "G.kt": text });
      const decoyLine = locate(text, "describe", 1).line;

      const goto = await goToDefinition(p.index, { file: p.f("G.kt"), ...locate(text, "describe", 2) });
      expect(goto.status).toBe("ok");
      if (goto.status === "ok") expect(goto.definition.range.start.line).not.toBe(decoyLine);

      const refs = await findReferences(p.index, { file: p.f("G.kt"), ...locate(text, "describe", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        for (const ref of refs.references) expect(ref.range.start.line).not.toBe(decoyLine);
      }
    });

    it("default-package cross-file (documented unnamed-package limit): not_found and partial coverage, never a wrong target", async () => {
      const declText = ["class Gadget(val name: String) {", '  fun describe(): String = "x:" + name', "}", ""].join(
        "\n",
      );
      const useText = ["fun use() {", '  val g = Gadget("y")', "  g.describe()", "}", ""].join("\n");
      const p = await fixture("cg-unnamed-", { "Gadget.kt": declText, "use.kt": useText });

      const goto = await goToDefinition(p.index, { file: p.f("use.kt"), ...locate(useText, "describe", 0) });
      expect(goto.status).toBe("not_found");

      const refs = await findReferences(p.index, { file: p.f("Gadget.kt"), ...locate(declText, "describe", 0) });
      expect(refs.status).toBe("ok");
      if (refs.status === "ok") {
        for (const ref of refs.references) expect(path.basename(ref.file)).not.toBe("use.kt");
        // The cross-file use is a candidate the single-file unit cannot verify: coverage must
        // say `partial`, not `complete` over the missed use.
        expect(refs.referenceCoverage.state).toBe("partial");
        expect(refs.referenceCoverage.reasons).toContain("strategy_unavailable");
      }
    });
  });
});
