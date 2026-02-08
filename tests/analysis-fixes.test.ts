import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  buildProjectIndex,
  buildSymbolGraphDetailed,
  clearResolutionCaches,
  collectGraph,
  resolveSpecifier,
} from "../src/index.js";
import { extractPythonSpecifiers, stripJsLikeComments } from "../src/util.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("analysis fixes", () => {
  it("preserves string literals containing // while stripping comments", () => {
    const source = [
      'const url = "//cdn.example.com/lib.js";',
      'const api = "https://api.example.com/v1";',
      "const tpl = `${base}//path`;",
      "// comment to remove",
      "const value = 1; /* block */",
    ].join("\n");

    const stripped = stripJsLikeComments(source);
    expect(stripped).toContain('"//cdn.example.com/lib.js"');
    expect(stripped).toContain('"https://api.example.com/v1"');
    expect(stripped).toContain("`${base}//path`");
    expect(stripped).not.toContain("// comment to remove");
    expect(stripped).not.toContain("/* block */");
  });

  it("extracts Python dot-only relative imports", () => {
    const specs = extractPythonSpecifiers(
      "from . import util\nfrom .. import config\nfrom ..pkg import item\n",
    );
    expect(specs).toEqual([".", "..", "..pkg"]);
  });

  it("resolves dot-only relative imports to package files", async () => {
    const root = await mkTmpDir("dg-py-dot-only-");
    const pkg = path.join(root, "pkg");
    const subpkg = path.join(pkg, "subpkg");
    await fsp.mkdir(subpkg, { recursive: true });
    await fsp.writeFile(path.join(pkg, "__init__.py"), "# pkg\n", "utf8");
    await fsp.writeFile(path.join(pkg, "util.py"), "VALUE = 1\n", "utf8");
    await fsp.writeFile(path.join(subpkg, "__init__.py"), "# sub\n", "utf8");
    const main = path.join(subpkg, "main.py");
    await fsp.writeFile(main, "from .. import util\n", "utf8");

    const files = [
      path.join(pkg, "__init__.py").replace(/\\/g, "/"),
      path.join(pkg, "util.py").replace(/\\/g, "/"),
      path.join(subpkg, "__init__.py").replace(/\\/g, "/"),
      main.replace(/\\/g, "/"),
    ];
    const graph = await collectGraph(root, files);

    const edge = graph.edges.find(
      (entry) =>
        entry.from === main.replace(/\\/g, "/") &&
        entry.to.type === "file" &&
        entry.to.path.replace(/\\/g, "/").endsWith("/pkg/__init__.py"),
    );
    expect(edge).toBeDefined();
  });

  it("handles circular re-exports in detailed symbol graph resolution", async () => {
    const root = await mkTmpDir("dg-detailed-reexport-cycle-");
    await fsp.writeFile(
      path.join(root, "a.ts"),
      "export { b as a } from './b'\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "b.ts"),
      "export { a as b } from './a'\n",
      "utf8",
    );
    await fsp.writeFile(
      path.join(root, "main.ts"),
      "import { a } from './a'\nexport const value = a\n",
      "utf8",
    );

    const index = await buildProjectIndex(root);
    const detailed = await buildSymbolGraphDetailed(index);
    expect(detailed.nodes.size).toBeGreaterThan(0);
  });

  it("allows clearing stale negative resolution caches", async () => {
    const root = await mkTmpDir("dg-clear-cache-");
    const main = path.join(root, "main.ts");
    const depBase = path.join(root, "dep");
    await fsp.writeFile(main, "import { dep } from './dep'\n", "utf8");

    const first = await resolveSpecifier(main, "./dep", root);
    expect(typeof first).toBe("object");
    if (typeof first !== "string") {
      expect(first.external).toBe("./dep");
    }

    await fsp.writeFile(
      path.join(root, "dep.ts"),
      "export const dep = 1\n",
      "utf8",
    );

    const stale = await resolveSpecifier(main, "./dep", root);
    expect(typeof stale).toBe("object");

    clearResolutionCaches();

    const fresh = await resolveSpecifier(main, "./dep", root);
    expect(typeof fresh).toBe("string");
    if (typeof fresh === "string") {
      expect(fresh.replace(/\\/g, "/")).toBe(
        (depBase + ".ts").replace(/\\/g, "/"),
      );
    }
  });
});
