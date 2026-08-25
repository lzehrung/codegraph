import { describe, it, expect } from "vitest";
import path from "node:path";
import { buildProjectIndex, goToDefinition, findReferences } from "../src/index.js";
import { readOnlySamplePath } from "./helpers/filesystem.js";

describe("Python monorepo package navigation", () => {
  const root = readOnlySamplePath("monorepo");
  const pyUtils = path.join(root, "packages", "py-app", "utils.py");
  const pyMain = path.join(root, "packages", "py-app", "main.py");
  const _pyInit = path.join(root, "packages", "py-app", "__init__.py");

  it("goToDefinition from main.py Utility -> utils.py", async () => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const res = await goToDefinition(index, { file: pyMain.replace(/\\/g, "/"), line: 5, column: 10 });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.definition.file.replace(/\\/g, "/")).toBe(pyUtils.replace(/\\/g, "/"));
      expect(res.definition.range.start.line).toBe(5);
    }
  });

  it("findReferences for helper_function includes __init__ and main", async () => {
    const index = await buildProjectIndex(root, { cache: "off" });
    const res = await findReferences(index, {
      file: pyUtils.replace(/\\/g, "/"),
      line: 1,
      column: 5,
    });
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      const files = res.references.map((r) => r.file.replace(/\\/g, "/"));
      expect(files.some((f) => f.endsWith("packages/py-app/__init__.py"))).toBe(true);
      expect(files.some((f) => f.endsWith("packages/py-app/main.py"))).toBe(true);
    }
  });
});
