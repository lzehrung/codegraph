import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";
import {
  tool_listProjectFiles,
  tool_getGraph,
  tool_getFileOverview,
  tool_goToDefinition,
  tool_findReferences,
  tool_findSymbol,
} from "../src/agent-tools.js";

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("Agent Tools", () => {
  const samplePath = path.resolve(process.cwd(), "tests", "samples", "typescript");

  it("tool_listProjectFiles should list files", async () => {
    const result = await tool_listProjectFiles(samplePath);
    expect(result.status).toBe("ok");
    expect(result.files).toBeDefined();
    expect(result.files!.some((f) => f.replace(/\\/g, "/").endsWith("main.ts"))).toBe(
      true,
    );
  });

  it("tool_getGraph should return graph", async () => {
    const result = await tool_getGraph(samplePath);
    expect(result.status).toBe("ok");
    expect(result.graph).toBeDefined();
    expect(result.graph!.nodes.length).toBeGreaterThan(0);
    expect(result.graph!.edges).toBeDefined();
  });

  it("tool_getGraph accepts explicit native mode overrides", async () => {
    const result = await tool_getGraph(samplePath, { native: "off" });
    expect(result.status).toBe("ok");
    expect(result.graph).toBeDefined();
    expect(result.graph!.nodes.length).toBeGreaterThan(0);
  });

  it("tool_getFileOverview returns structured overviews", async () => {
    const result = await tool_getFileOverview(samplePath, "main.ts");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.file).toBe("main.ts");
      expect(result.hasSymbols).toBe(true);
      expect(result.overview).toContain("# Overview of main.ts");
    }
  });

  it("tool_getFileOverview distinguishes files with no symbols", async () => {
    const root = await mkTmpDir("dg-agent-overview-");
    await fsp.writeFile(path.join(root, "empty.ts"), "\n", "utf8");

    const result = await tool_getFileOverview(root, "empty.ts");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.file).toBe("empty.ts");
      expect(result.hasSymbols).toBe(false);
      expect(result.overview).toContain("No symbols found.");
    }
  });

  it("tool_getFileOverview returns not_found for missing files", async () => {
    const result = await tool_getFileOverview(samplePath, "missing.ts");
    expect(result.status).toBe("not_found");
    if (result.status === "not_found") {
      expect(result.file).toBe("missing.ts");
      expect(result.reason).toBe("file_not_found");
    }
  });

  it("tool_getFileOverview returns structured errors for invalid roots", async () => {
    const result = await tool_getFileOverview(
      "Z:/definitely-missing-codegraph-root",
      "main.ts",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Project root does not exist or is not readable");
    }
  });

  it("tool_getFileOverview rejects files outside the project root", async () => {
    const result = await tool_getFileOverview(samplePath, path.resolve("README.md"));
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("outside_project_root");
      expect(result.error).toContain("outside project root");
    }
  });

  it("tool_goToDefinition should find definition", async () => {
    const mainFile = path.join(samplePath, "main.ts");
    // Line 7, column 25 is helperFunction() call which is imported from utils.ts
    const result = await tool_goToDefinition(samplePath, mainFile, 7, 25);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe("utils.ts");
      expect(result.definition.range.start.line).toBe(1);
      expect(path.isAbsolute(result.definition.file)).toBe(false);
      expect(path.isAbsolute(result.via?.importedFrom ?? "")).toBe(false);
    }
  });

  it("tool_findReferences should find references", async () => {
    const utilsFile = path.join(samplePath, "utils.ts");
    // Line 1, column 17 is helperFunction definition
    const result = await tool_findReferences(samplePath, utilsFile, 1, 17);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition?.file).toBe("utils.ts");
      expect(result.references.length).toBeGreaterThan(0);
      expect(result.references.every((reference) => !path.isAbsolute(reference.file))).toBe(
        true,
      );
      const firstImportReference = result.references.find((reference) => reference.via?.import);
      expect(firstImportReference?.via?.import?.resolved).toBe("utils.ts");
    }
  });

  it("tool_goToDefinition handles relative paths", async () => {
    const result = await tool_goToDefinition(samplePath, "main.ts", 7, 25);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.definition.file).toBe("utils.ts");
    }
  });

  it("tool_goToDefinition rejects files outside the project root", async () => {
    const result = await tool_goToDefinition(
      samplePath,
      path.resolve("README.md"),
      1,
      1,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("outside_project_root");
      expect(result.error).toContain("outside project root");
    }
  });

  it("tool_findReferences rejects files outside the project root", async () => {
    const result = await tool_findReferences(
      samplePath,
      path.resolve("README.md"),
      1,
      1,
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).toBe("outside_project_root");
      expect(result.error).toContain("outside project root");
    }
  });

  it("tool_findSymbol returns structured matches", async () => {
    const result = await tool_findSymbol(samplePath, "helperFunction");
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.matches.length).toBeGreaterThan(0);
      expect(
        result.matches.some((match) => match.name === "helperFunction"),
      ).toBe(true);
    }
  });

  it("tool_findSymbol returns structured errors for invalid roots", async () => {
    const result = await tool_findSymbol(
      "Z:/definitely-missing-codegraph-root",
      "helperFunction",
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toContain("Project root does not exist or is not readable");
    }
  });
});
