import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { previewRenameInSnapshot, previewRenameWithSession } from "../src/agent/renamePreview.js";
import { createAgentSession, type AgentProjectSnapshot } from "../src/agent/session.js";
import { workspaceSymbolsInSnapshot, workspaceSymbolsWithSession } from "../src/agent/workspaceSymbols.js";
import { buildProjectIndexFromFiles } from "../src/indexer/build-index.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function renameFixture() {
  const root = await mkTmpDir("cg-rename-preview-");
  const serviceFile = path.join(root, "service.ts");
  const consumerFile = path.join(root, "consumer.ts");
  await fsp.writeFile(serviceFile, "export function service(): number { return 1; }\n");
  await fsp.writeFile(
    consumerFile,
    [
      'import { service } from "./service.js";',
      "export function useService(): number { return service(); }",
      "export function shadow(): number {",
      "  const service = 2;",
      "  return service;",
      "}",
      "// service documentation",
      'export const serviceLabel = "service";',
    ].join("\n"),
  );
  const session = createAgentSession({ root, freshness: { policy: "check" } });
  const symbols = await workspaceSymbolsWithSession(session, { root, query: "service", exportedOnly: true });
  const target = symbols.symbols.find((symbol) => symbol.name === "service");
  expect(target).toBeDefined();
  return { root, serviceFile, consumerFile, session, target: target! };
}

async function renameSnapshotForFiles(root: string, files: string[]): Promise<AgentProjectSnapshot> {
  const index = await buildProjectIndexFromFiles(root, files, { cache: "off", keepParsed: true });
  return {
    root,
    files,
    index,
    fileGraph: index.graph,
    symbolGraph: { nodes: new Map(), edges: [] },
    analysis: {
      mode: "semantic",
      backend: "unknown",
      parserDegradedFiles: 0,
      fallbackImportExtractionFiles: 0,
      nativeFilesUsed: 0,
      nativeFilesFellBack: 0,
      label: "semantic",
    },
  };
}

describe("rename preview", () => {
  it("returns exact semantic edits without writing files or touching shadowed locals", async () => {
    const { root, serviceFile, consumerFile, session, target } = await renameFixture();
    const beforeService = await fsp.readFile(serviceFile, "utf8");
    const beforeConsumer = await fsp.readFile(consumerFile, "utf8");
    const result = await previewRenameWithSession(session, {
      root,
      handle: target.handle,
      newName: "renamedService",
    });

    expect(result.safe).toBe(true);
    expect(result.conflicts).toEqual([]);
    expect(result.unsafeSites).toEqual([]);
    expect(result.edits.map((edit) => [edit.file, edit.oldText, edit.kind])).toEqual([
      ["consumer.ts", "service", "import"],
      ["consumer.ts", "service", "reference"],
      ["service.ts", "service", "definition"],
    ]);
    expect(result.edits.some((edit) => edit.range.start.line === 4 || edit.range.start.line === 5)).toBe(false);
    expect(await fsp.readFile(serviceFile, "utf8")).toBe(beforeService);
    expect(await fsp.readFile(consumerFile, "utf8")).toBe(beforeConsumer);
  });

  it("marks collisions and case-only renames unsafe", async () => {
    const { root, serviceFile, session, target } = await renameFixture();
    await fsp.appendFile(serviceFile, "export const existing = 2;\n");
    session.invalidate();
    const refreshedSymbols = await workspaceSymbolsWithSession(session, { root, query: "service", exportedOnly: true });
    const refreshedTarget = refreshedSymbols.symbols.find((symbol) => symbol.name === "service")!;

    const collision = await previewRenameWithSession(session, {
      root,
      handle: refreshedTarget.handle,
      newName: "existing",
    });
    expect(collision.safe).toBe(false);
    expect(collision.conflicts.some((conflict) => conflict.reason === "name_collision")).toBe(true);

    const caseOnly = await previewRenameWithSession(session, {
      root,
      handle: refreshedTarget.handle,
      newName: "Service",
    });
    expect(caseOnly.safe).toBe(false);
    expect(caseOnly.conflicts.some((conflict) => conflict.reason === "case_only_filesystem_risk")).toBe(true);
  });

  it("cannot report safe after live source drift", async () => {
    const { root, serviceFile, session, target } = await renameFixture();
    await fsp.writeFile(serviceFile, "export function changed(): number { return 1; }\n");
    const result = await previewRenameWithSession(session, {
      root,
      handle: target.handle,
      newName: "renamedService",
    });
    expect(result.safe).toBe(false);
    expect(result.freshness.state).toBe("stale");
    expect(result.unsafeSites.some((site) => site.reason === "unresolved_reference")).toBe(true);
    expect(result.edits.some((edit) => edit.file === "service.ts")).toBe(false);
  });

  it("forces unsafe output when the semantic reference set exceeds the edit limit", async () => {
    const { root, session, target } = await renameFixture();
    const result = await previewRenameWithSession(session, {
      root,
      handle: target.handle,
      newName: "renamedService",
      maxEdits: 1,
    });
    expect(result.safe).toBe(false);
    expect(result.omittedCounts.edits).toBeGreaterThan(0);
    expect(result.unsafeSites.some((site) => site.reason === "limit_exceeded")).toBe(true);
  });

  it("adds bounded heuristic comment and string candidates only when requested", async () => {
    const { root, session, target } = await renameFixture();
    const defaultResult = await previewRenameWithSession(session, {
      root,
      handle: target.handle,
      newName: "renamedService",
    });
    expect(defaultResult.edits.some((edit) => edit.kind === "comment" || edit.kind === "string")).toBe(false);

    const optInResult = await previewRenameWithSession(session, {
      root,
      handle: target.handle,
      newName: "renamedService",
      includeComments: true,
      includeStrings: true,
    });
    expect(optInResult.safe).toBe(true);
    expect(optInResult.edits.filter((edit) => edit.kind === "comment")).toHaveLength(1);
    expect(optInResult.edits.filter((edit) => edit.kind === "string")).toHaveLength(1);
    expect(
      optInResult.edits
        .filter((edit) => edit.kind === "comment" || edit.kind === "string")
        .every((edit) => edit.provenance.capability === "heuristic" && edit.provenance.confidence === "low"),
    ).toBe(true);
  });

  it("renames an imported symbol without changing an explicit local alias", async () => {
    const root = await mkTmpDir("cg-rename-alias-");
    await fsp.writeFile(path.join(root, "service.ts"), "export function service(): number { return 1; }\n");
    await fsp.writeFile(
      path.join(root, "consumer.ts"),
      'import { service as localService } from "./service.js";\nexport const value = localService();\n',
    );
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const symbols = await workspaceSymbolsWithSession(session, { root, query: "service", exportedOnly: true });
    const result = await previewRenameWithSession(session, {
      root,
      handle: symbols.symbols[0]!.handle,
      newName: "renamedService",
    });
    expect(result.safe).toBe(true);
    expect(result.edits.map((edit) => [edit.file, edit.oldText, edit.kind])).toEqual([
      ["consumer.ts", "service", "import"],
      ["service.ts", "service", "definition"],
    ]);
  });

  it("includes proven interface member implementations but excludes unrelated same-named methods", async () => {
    const root = await mkTmpDir("cg-rename-interface-");
    await fsp.writeFile(
      path.join(root, "service.ts"),
      [
        "export interface Service { run(): void }",
        "export class Worker implements Service { run(): void {} }",
        "export class Unrelated { run(): void {} }",
      ].join("\n"),
    );
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const symbols = await workspaceSymbolsWithSession(session, { root, query: "run" });
    const interfaceMethod = symbols.symbols.find((symbol) => symbol.location.range.start.line === 1);
    expect(interfaceMethod).toBeDefined();
    const result = await previewRenameWithSession(session, {
      root,
      handle: interfaceMethod!.handle,
      newName: "execute",
    });
    expect(result.safe).toBe(true);
    expect(result.edits.filter((edit) => edit.kind === "definition").map((edit) => edit.range.start.line)).toEqual([
      1,
      2,
    ]);
    expect(result.edits.some((edit) => edit.range.start.line === 3)).toBe(false);
  });

  it("rejects invalid identifiers before claiming safety", async () => {
    const { root, session, target } = await renameFixture();
    const result = await previewRenameWithSession(session, {
      root,
      handle: target.handle,
      newName: "not/a/name",
    });
    expect(result.safe).toBe(false);
    expect(result.conflicts).toContainEqual(expect.objectContaining({ reason: "invalid_identifier" }));
  });
  it("renames proven re-export sites and downstream imports", async () => {
    const root = await mkTmpDir("cg-rename-reexport-");
    await fsp.writeFile(path.join(root, "service.ts"), "export function service(): number { return 1; }\n");
    await fsp.writeFile(path.join(root, "index.ts"), 'export { service } from "./service.js";\n');
    await fsp.writeFile(
      path.join(root, "consumer.ts"),
      'import { service } from "./index.js";\nexport const value = service();\n',
    );
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const symbols = await workspaceSymbolsWithSession(session, { root, query: "service" });
    const target = symbols.symbols.find((symbol) => symbol.name === "service" && symbol.location.file === "service.ts");
    expect(target).toBeDefined();

    const result = await previewRenameWithSession(session, {
      root,
      handle: target!.handle,
      newName: "renamedService",
    });

    expect(result.safe).toBe(true);
    expect(result.edits.map((edit) => [edit.file, edit.oldText, edit.kind])).toEqual([
      ["consumer.ts", "service", "import"],
      ["consumer.ts", "service", "reference"],
      ["index.ts", "service", "export"],
      ["service.ts", "service", "definition"],
    ]);
  });

  it("preserves explicit re-export aliases while renaming the proven source name", async () => {
    const root = await mkTmpDir("cg-rename-reexport-alias-");
    await fsp.writeFile(path.join(root, "service.ts"), "export function service(): number { return 1; }\n");
    await fsp.writeFile(path.join(root, "index.ts"), 'export { service as publicService } from "./service.js";\n');
    await fsp.writeFile(
      path.join(root, "consumer.ts"),
      'import { publicService } from "./index.js";\nexport const value = publicService();\n',
    );
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const symbols = await workspaceSymbolsWithSession(session, { root, query: "service" });
    const target = symbols.symbols.find((symbol) => symbol.location.file === "service.ts");
    expect(target).toBeDefined();

    const result = await previewRenameWithSession(session, {
      root,
      handle: target!.handle,
      newName: "renamedService",
    });

    expect(result.safe).toBe(true);
    expect(result.edits.map((edit) => [edit.file, edit.oldText, edit.kind])).toEqual([
      ["index.ts", "service", "export"],
      ["service.ts", "service", "definition"],
    ]);
  });

  it("classifies local export-list edits as exports", async () => {
    const root = await mkTmpDir("cg-rename-local-export-");
    await fsp.writeFile(
      path.join(root, "service.ts"),
      "function service(): number { return 1; }\nexport { service };\n",
    );
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const symbols = await workspaceSymbolsWithSession(session, { root, query: "service" });
    const target = symbols.symbols.find((symbol) => symbol.name === "service");
    expect(target).toBeDefined();

    const result = await previewRenameWithSession(session, {
      root,
      handle: target!.handle,
      newName: "renamedService",
    });

    expect(result.safe).toBe(true);
    expect(result.edits.map((edit) => [edit.range.start.line, edit.kind])).toEqual([
      [1, "definition"],
      [2, "export"],
    ]);
  });

  it("reports a consumer binding collision for an implicit import rename", async () => {
    const { root, consumerFile, session, target } = await renameFixture();
    await fsp.appendFile(consumerFile, "\nexport const renamedService = 2;\n");
    session.invalidate();
    const symbols = await workspaceSymbolsWithSession(session, { root, query: "service", exportedOnly: true });
    const refreshedTarget = symbols.symbols.find((symbol) => symbol.name === "service");
    expect(refreshedTarget).toBeDefined();

    const result = await previewRenameWithSession(session, {
      root,
      handle: refreshedTarget!.handle,
      newName: "renamedService",
    });

    expect(result.safe).toBe(false);
    expect(result.conflicts).toContainEqual(expect.objectContaining({ file: "consumer.ts", reason: "shadowing" }));
  });

  it("returns filename suggestions only for exported type names matching their file", async () => {
    const root = await mkTmpDir("cg-rename-filename-");
    await fsp.writeFile(path.join(root, "Service.ts"), "export class Service {}\n");
    await fsp.writeFile(path.join(root, "helper.ts"), "export function helper(): void {}\n");
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const typeSymbols = await workspaceSymbolsWithSession(session, { root, query: "Service" });
    const functionSymbols = await workspaceSymbolsWithSession(session, { root, query: "helper" });

    const typeResult = await previewRenameWithSession(session, {
      root,
      handle: typeSymbols.symbols[0]!.handle,
      newName: "Worker",
      includeFilenames: true,
    });
    const functionResult = await previewRenameWithSession(session, {
      root,
      handle: functionSymbols.symbols[0]!.handle,
      newName: "renamedHelper",
      includeFilenames: true,
    });

    expect(typeResult.filenameSuggestions).toEqual([{ from: "Service.ts", to: "Worker.ts", caseOnlyRisk: false }]);
    expect(functionResult.filenameSuggestions).toEqual([]);
  });

  it("blocks generated files and handles deleted indexed files without crashing", async () => {
    const root = await mkTmpDir("cg-rename-boundaries-");
    const generatedFile = path.join(root, "api.generated.ts");
    const consumerFile = path.join(root, "consumer.ts");
    await fsp.writeFile(generatedFile, "export function service(): number { return 1; }\n");
    await fsp.writeFile(
      consumerFile,
      'import { service } from "./api.generated.js";\nexport const value = service();\n',
    );
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const symbols = await workspaceSymbolsWithSession(session, { root, query: "service" });
    const target = symbols.symbols.find((symbol) => symbol.location.file === "api.generated.ts");
    expect(target).toBeDefined();

    const generated = await previewRenameWithSession(session, {
      root,
      handle: target!.handle,
      newName: "renamedService",
    });
    expect(generated.safe).toBe(false);
    expect(generated.unsafeSites).toContainEqual(expect.objectContaining({ reason: "generated_file" }));

    await fsp.rm(consumerFile);
    const deleted = await previewRenameWithSession(session, {
      root,
      handle: target!.handle,
      newName: "renamedService",
    });
    expect(deleted.safe).toBe(false);
    expect(deleted.unsafeSites.some((site) => site.reason === "unresolved_reference")).toBe(true);
  });

  it("refuses source symlinks that resolve outside the project root", async () => {
    const root = await mkTmpDir("cg-rename-root-");
    const outsideRoot = await mkTmpDir("cg-rename-outside-");
    const outsideFile = path.join(outsideRoot, "service.ts");
    await fsp.writeFile(outsideFile, "export function service(): number { return 1; }\n");
    const aliasFile = path.join(root, "service.ts");
    await fsp.symlink(outsideFile, aliasFile);
    const snapshot = await renameSnapshotForFiles(root, [aliasFile]);
    const symbols = await workspaceSymbolsInSnapshot(snapshot, { query: "service" });
    expect(symbols.symbols[0]).toBeDefined();

    const result = await previewRenameInSnapshot(snapshot, {
      root,
      handle: symbols.symbols[0]!.handle,
      newName: "renamedService",
    });

    expect(result.safe).toBe(false);
    expect(result.edits).toEqual([]);
    expect(result.unsafeSites).toContainEqual(expect.objectContaining({ reason: "outside_root" }));
  });

  it("refuses source aliases whose real path is sensitive key material", async () => {
    const root = await mkTmpDir("cg-rename-sensitive-");
    const sensitiveFile = path.join(root, "service.pem");
    await fsp.writeFile(sensitiveFile, "export function service(): number { return 1; }\n");
    const aliasFile = path.join(root, "service.ts");
    await fsp.symlink(sensitiveFile, aliasFile);
    const snapshot = await renameSnapshotForFiles(root, [aliasFile]);
    const symbols = await workspaceSymbolsInSnapshot(snapshot, { query: "service" });
    expect(symbols.symbols[0]).toBeDefined();

    const result = await previewRenameInSnapshot(snapshot, {
      root,
      handle: symbols.symbols[0]!.handle,
      newName: "renamedService",
    });

    expect(result.safe).toBe(false);
    expect(result.edits).toEqual([]);
    expect(result.unsafeSites).toContainEqual(expect.objectContaining({ reason: "sensitive_file" }));
  });

  it("handles malformed UTF-8 source without throwing or escaping project-relative output", async () => {
    const root = await mkTmpDir("cg-rename-utf8-");
    const file = path.join(root, "service.ts");
    await fsp.writeFile(
      file,
      Buffer.concat([
        Buffer.from("export function service(): number { return 1; }\n"),
        Buffer.from([0xc3, 0x28]),
      ]),
    );
    const session = createAgentSession({ root, freshness: { policy: "check" } });
    const symbols = await workspaceSymbolsWithSession(session, { root, query: "service" });
    expect(symbols.symbols[0]).toBeDefined();

    const result = await previewRenameWithSession(session, {
      root,
      handle: symbols.symbols[0]!.handle,
      newName: "renamedService",
    });

    expect(result.target.location.file).toBe("service.ts");
    expect(result.edits.every((edit) => !path.isAbsolute(edit.file))).toBe(true);
  });
});
