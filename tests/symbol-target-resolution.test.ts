import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as agentApi from "../src/agent.js";
import * as rootApi from "../src/index.js";
import * as indexerApi from "../src/indexer.js";

describe("public symbol target resolution", () => {
  it("resolves qualified paths, canonical handles, locations, and exact names without guessing", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-symbol-target-"));
    try {
      const sourceDirectory = path.join(root, "src");
      await fsp.mkdir(sourceDirectory);
      await fsp.writeFile(
        path.join(sourceDirectory, "service.ts"),
        ['export function start() { return "service"; }', "export function unique() {}"].join("\n"),
        "utf8",
      );
      await fsp.writeFile(
        path.join(sourceDirectory, "other.ts"),
        'export function start() { return "other"; }\n',
        "utf8",
      );

      const index = await rootApi.buildProjectIndex(root, { cache: "off" });
      const qualified = rootApi.resolveSymbolTarget(index, "src/service.ts::start");
      expect(qualified.status).toBe("exact");
      if (qualified.status !== "exact") throw new Error("Expected the qualified target to resolve.");
      expect(qualified.target.definition.localName).toBe("start");
      expect(indexerApi.resolveSymbolTarget).toBe(rootApi.resolveSymbolTarget);

      const handle = rootApi.resolveSymbolTarget(index, qualified.target.handle);
      expect(handle).toMatchObject({ status: "exact", target: { handle: qualified.target.handle } });

      qualified.target.definition.range.start.index = undefined;
      const fallbackHandle = rootApi.resolveSymbolTarget(
        index,
        `${qualified.target.definition.file}::${qualified.target.definition.localName}::0`,
      );
      expect(fallbackHandle).toMatchObject({
        status: "exact",
        target: {
          handle: `${qualified.target.definition.file}::${qualified.target.definition.localName}::0`,
        },
      });

      const { line, column } = qualified.target.definition.range.start;
      const location = rootApi.resolveSymbolTarget(index, `src/service.ts:${line}:${column}`);
      expect(location).toMatchObject({
        status: "exact",
        target: { handle: `${qualified.target.definition.file}::${qualified.target.definition.localName}::0` },
      });

      const exactName = rootApi.resolveSymbolTarget(index, "unique");
      expect(exactName).toMatchObject({ status: "exact", target: { definition: { localName: "unique" } } });

      const ambiguous = rootApi.resolveSymbolTarget(index, "start");
      expect(ambiguous.status).toBe("ambiguous");
      if (ambiguous.status !== "ambiguous") throw new Error("Expected duplicate names to remain ambiguous.");
      expect(ambiguous.candidates.map((candidate) => candidate.definition.file.replace(/\\/g, "/"))).toEqual(
        [path.join(root, "src", "other.ts"), path.join(root, "src", "service.ts")].map((file) =>
          file.replace(/\\/g, "/"),
        ),
      );

      expect(rootApi.resolveSymbolTarget(index, "src/service.ts::missing")).toEqual({
        status: "not_found",
        input: "src/service.ts::missing",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("exposes the semantic resolver from the agent facade", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cg-agent-symbol-target-"));
    try {
      await fsp.writeFile(path.join(root, "service.ts"), "export function start() {}\n", "utf8");
      const session = agentApi.createAgentSession({ root, buildOptions: { cache: "off" }, useConfig: false });
      const snapshot = await session.loadProject({ symbolGraph: "basic" });

      const resolved = agentApi.requireSemanticSymbol(snapshot, "service.ts::start");
      expect(resolved.def.localName).toBe("start");
      expect(resolved.id).toContain("::start::");
      expect(() => agentApi.requireSemanticSymbol(snapshot, "service.ts::missing")).toThrow(
        'Symbol path "service.ts::missing" was not found',
      );
      const portableHandle = `symbol:service.ts:start:${resolved.def.range.start.line}:${resolved.def.range.start.column}`;
      expect(agentApi.requireSemanticSymbol(snapshot, portableHandle)).toMatchObject({ id: resolved.id });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
