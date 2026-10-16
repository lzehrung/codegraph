import fsp from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  chunkFile,
  findReferences,
  goToDefinition,
  listSymbols,
  supportForFile,
} from "../../src/index.js";
import { previewRenameWithSession } from "../../src/agent/rename-preview.js";
import { createAgentSession } from "../../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../../src/agent/workspace-symbols.js";
import { LANG_CONFIGS } from "../../src/bootstrap/tree-sitter-languages.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";
import { locateChangedSymbols } from "../../src/impact/map.js";
import { analyzeImpact } from "../../src/impact/analyzer.js";
import { resolveTerraformModuleSourcePaths } from "../../src/util/resolution/terraform.js";
import {
  createTempProjectRoot,
  isSymlinkUnavailable,
  mkTmpDir,
  readOnlySamplePath,
  withCopiedFixture,
} from "../helpers/filesystem.js";

const fixtureRoot = normalizePath(readOnlySamplePath("terraform"));
let fixtureIndex: ProjectIndex;

beforeAll(async () => {
  fixtureIndex = await buildProjectIndex(fixtureRoot);
});

function fixtureFile(relativePath: string): string {
  return `${fixtureRoot}/${relativePath}`;
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

/** 1-based position of `needle` (its `nth` occurrence) plus `offset` UTF-16 units. */
async function positionOf(root: string, relativePath: string, needle: string, offset = 0, nth = 0) {
  const source = await fsp.readFile(path.join(root, relativePath), "utf8");
  let index = -1;
  for (let count = 0; count <= nth; count += 1) {
    index = source.indexOf(needle, index + 1);
    expect(index, `${needle} #${nth} in ${relativePath}`).toBeGreaterThanOrEqual(0);
  }
  const at = index + offset;
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  return {
    file: normalizePath(path.join(root, relativePath)),
    line: source.slice(0, at).split("\n").length,
    column: at - lineStart + 1,
  };
}

function edgeTargets(index: ProjectIndex, root: string, file: string): string[] {
  return index.graph.edges
    .filter((edge) => fileIdentityKey(edge.from) === fileIdentityKey(file))
    .map((edge) => (edge.to.type === "file" ? relative(root, edge.to.path) : `external:${edge.to.name}`))
    .sort();
}

describe("Terraform language support", () => {
  it("registers .tf files and skips the .terraform install directory", async () => {
    expect(supportForFile("main.tf")?.id).toBe("terraform");
    expect(LANG_CONFIGS.terraform).toBeDefined();
    const root = await createTempProjectRoot("cg-terraform-discovery-", [
      { path: "main.tf", contents: 'variable "region" {}\n' },
      { path: ".terraform/modules/vpc/main.tf", contents: 'variable "region" {}\n' },
    ]);
    try {
      const index = await buildProjectIndex(root);
      expect([...index.byFile.values()].map((module) => relative(root, module.file))).toEqual(["main.tf"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("indexes block labels and locals with Terraform kinds, exporting only inputs and outputs", () => {
    const symbols = (file: string) =>
      listSymbols(fixtureIndex, { file: fixtureFile(file) })
        .map((symbol) => `${symbol.name}:${symbol.kind}`)
        .sort();
    expect(symbols("main.tf")).toEqual([
      "consul:module",
      "logs:resource",
      "name_prefix:variable",
      "network:module",
      "storage:module",
      "tags:variable",
      "ubuntu:data",
      "web:resource",
    ]);
    expect(symbols("variables.tf")).toEqual(["cidr:variable", "region:variable", "web:variable"]);
    const exported = (file: string) =>
      fixtureIndex.byFile
        .get(fileIdentityKey(fixtureFile(file)))
        ?.exports.flatMap((entry) => ("exportedAs" in entry ? [entry.exportedAs] : []))
        .sort();
    expect(exported("main.tf")).toEqual([]);
    expect(exported("modules/storage/main.tf")).toEqual(["region", "vpc_id"]);
  });

  it("depends on every file of a local module source and keeps registry sources external", () => {
    expect(edgeTargets(fixtureIndex, fixtureRoot, fixtureFile("main.tf"))).toEqual([
      "external:hashicorp/consul/aws",
      "modules/network/main.tf",
      "modules/network/outputs.tf",
      "modules/network/variables.tf",
      "modules/storage/main.tf",
    ]);
    expect(edgeTargets(fixtureIndex, fixtureRoot, fixtureFile("outputs.tf"))).toEqual([]);
  });

  it("re-resolves a module call when a file is added to its source directory", async () => {
    await withCopiedFixture(fixtureRoot, async (root) => {
      const main = normalizePath(path.join(root, "main.tf"));
      const initial = await buildProjectIndexIncremental(root, { cache: "disk" });
      expect(edgeTargets(initial, root, main)).not.toContain("modules/network/locals.tf");
      await fsp.writeFile(path.join(root, "modules", "network", "locals.tf"), "locals {\n  zone = 1\n}\n", "utf8");
      const warm = await buildProjectIndexIncremental(root, { cache: "disk" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(edgeTargets(warm, root, main)).toContain("modules/network/locals.tf");
      expect(edgeTargets(warm, root, main)).toEqual(edgeTargets(cold, root, main));
    });
  });

  it("maps an edit inside a block body or locals attribute to that declaration", async () => {
    const changedAt = async (line: number) =>
      (
        await locateChangedSymbols(fixtureIndex, fixtureFile("main.tf"), [
          { oldStart: line, newStart: line, lines: ["+edit"] },
        ])
      ).map((symbol) => `${symbol.name}:${symbol.kind}`);
    expect(await changedAt(13)).toEqual(["web:resource"]);
    expect(await changedAt(19)).toEqual(["web:resource"]);
    expect(await changedAt(3)).toEqual(["tags:variable"]);
    expect(await changedAt(29)).toEqual(["network:module"]);
  });

  it("chunks top-level blocks by kind and label", async () => {
    const source = await fsp.readFile(fixtureFile("main.tf"), "utf8");
    const chunks = chunkFile({
      language: LANG_CONFIGS.terraform!,
      filePath: "main.tf",
      source,
      minTokens: 1,
      maxTokens: 400,
    });
    expect(chunks.map((chunk) => `${chunk.type}:${chunk.name ?? ""}`)).toEqual([
      "locals:locals",
      "data:ubuntu",
      "resource:web",
      "resource:logs",
      "module:network",
      "module:storage",
      "module:consul",
    ]);
  });
});

describe("Terraform go-to-definition", () => {
  it.each([
    ["an input variable", "main.tf", "${var.region}", 6, 0, "variables.tf:1"],
    ["a local value", "main.tf", "local.name_prefix", 6, 0, "main.tf:2"],
    ["a data source", "main.tf", "data.aws_ami.ubuntu", 13, 0, "main.tf:6"],
    ["a resource, not the same-named variable", "outputs.tf", "aws_instance.web[*]", 13, 0, "main.tf:10"],
    ["a resource in a for collection", "outputs.tf", "in aws_instance.web", 16, 0, "main.tf:10"],
    ["a module call", "main.tf", "module.network.subnet_id", 7, 0, "main.tf:27"],
    [
      "the called module's output, not a sibling module's",
      "outputs.tf",
      "module.network.vpc_id",
      15,
      0,
      "modules/network/outputs.tf:1",
    ],
    [
      "a call argument to that module's input",
      "main.tf",
      "region = var.region",
      0,
      0,
      "modules/network/variables.tf:5",
    ],
    ["the same argument in another call", "main.tf", "region = var.region", 0, 1, "modules/storage/main.tf:2"],
    ["a declaration label", "variables.tf", '"region"', 1, 0, "variables.tf:1"],
    ["a registry module call", "outputs.tf", "module.consul.ui_url", 7, 0, "main.tf:38"],
  ])("resolves %s", async (_label, file, needle, offset, nth, expected) => {
    const result = await goToDefinition(fixtureIndex, await positionOf(fixtureRoot, file, needle, offset, nth));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(`${relative(fixtureRoot, result.definition.file)}:${result.definition.range.start.line}`).toBe(expected);
  });

  it.each([
    ["a for iterator", "outputs.tf", "web.private_ip", 0],
    ["count.index", "main.tf", "count.index", 6],
    ["an ignore_changes attribute path", "main.tf", "[tags]", 1],
    ["a registry module output", "outputs.tf", "module.consul.ui_url", 14],
  ])("does not resolve %s", async (_label, file, needle, offset) => {
    const result = await goToDefinition(fixtureIndex, await positionOf(fixtureRoot, file, needle, offset));
    expect(result.status).toBe("not_found");
  });

  it("keeps for, template for, and dynamic iterators named like a resource type off that resource", async () => {
    const root = await createTempProjectRoot("cg-terraform-iterators-", [
      {
        path: "main.tf",
        contents: [
          'resource "aws_subnet" "main" {}',
          "locals {",
          "  outside = aws_subnet.main.id",
          "  ids     = [for aws_subnet in aws_subnet.main.ids : aws_subnet.main]",
          '  text    = "%{ for aws_subnet in var.subnets }${aws_subnet.main}%{ endfor }"',
          "}",
          'resource "aws_instance" "web" {',
          '  dynamic "aws_subnet" {',
          "    for_each = var.subnets",
          "    content {",
          "      id = aws_subnet.main",
          "    }",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ]);
    try {
      const index = await buildProjectIndex(root);
      for (const shadowed of ["aws_subnet.main]", "aws_subnet.main}", "id = aws_subnet.main"]) {
        const offset = shadowed.indexOf("main");
        const result = await goToDefinition(index, await positionOf(root, "main.tf", shadowed, offset));
        expect(result.status, shadowed).toBe("not_found");
      }
      const references = await findReferences(index, await positionOf(root, "main.tf", '"main"', 1));
      expect(references.status).toBe("ok");
      if (references.status !== "ok") return;
      const expected = [
        await positionOf(root, "main.tf", '"main"', 1),
        await positionOf(root, "main.tf", "aws_subnet.main.id", 11),
        await positionOf(root, "main.tf", "aws_subnet.main.ids", 11),
      ];
      expect(references.references.map((reference) => reference.range.start)).toEqual(
        expected.map((position) => expect.objectContaining({ line: position.line, column: position.column })),
      );
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves nothing when a name is declared twice in one module, and keeps references partial", async () => {
    const root = await createTempProjectRoot("cg-terraform-duplicate-", [
      { path: "a.tf", contents: 'variable "region" {}\n' },
      { path: "b.tf", contents: 'variable "region" {}\n' },
      { path: "c.tf", contents: "locals {\n  r = var.region\n}\n" },
    ]);
    try {
      const index = await buildProjectIndex(root);
      const result = await goToDefinition(index, await positionOf(root, "c.tf", "var.region", 4));
      expect(result).toEqual({
        status: "not_found",
        reason: "Terraform variable region is declared more than once in the module",
      });
      const references = await findReferences(index, await positionOf(root, "a.tf", '"region"', 1));
      expect(references.status).toBe("ok");
      if (references.status !== "ok") return;
      expect(references.references.map((reference) => relative(root, reference.file))).toEqual(["a.tf"]);
      expect(references.referenceCoverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["strategy_unavailable"],
        affectedFiles: [normalizePath(path.join(root, "c.tf"))],
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reports UTF-16 columns after non-ASCII text on the same line", async () => {
    const root = await createTempProjectRoot("cg-terraform-unicode-", [
      { path: "variables.tf", contents: 'variable "region" {}\n' },
      { path: "main.tf", contents: 'locals {\n  label = "é😀${var.region}"\n}\n' },
    ]);
    try {
      const index = await buildProjectIndex(root);
      const position = await positionOf(root, "main.tf", "var.region", 4);
      const result = await goToDefinition(index, position);
      expect(result.status).toBe("ok");
      const references = await findReferences(index, await positionOf(root, "variables.tf", '"region"', 1));
      expect(references.status).toBe("ok");
      if (references.status !== "ok") return;
      expect(
        references.references.map((reference) => `${relative(root, reference.file)}:${reference.range.start.column}`),
      ).toEqual([`main.tf:${position.column}`, "variables.tf:11"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe("Terraform references", () => {
  it.each([
    [
      "a root input variable",
      "variables.tf",
      '"region"',
      ["main.tf:2:24", "main.tf:30:16", "main.tf:35:16", "variables.tf:1:11"],
    ],
    [
      "a child input variable, from its caller's argument but not a sibling call's",
      "modules/network/variables.tf",
      '"region"',
      ["main.tf:30:3", "modules/network/main.tf:3:31", "modules/network/variables.tf:5:11"],
    ],
    [
      "a child output, from any file of the calling module",
      "modules/network/outputs.tf",
      '"vpc_id"',
      ["modules/network/outputs.tf:1:9", "outputs.tf:6:26", "outputs.tf:19:29"],
    ],
    [
      "a same-named output in an uncalled sibling",
      "modules/storage/main.tf",
      '"vpc_id"',
      ["modules/storage/main.tf:10:9"],
    ],
    [
      "a resource, including a for collection but not a same-named variable",
      "main.tf",
      '"web"',
      ["main.tf:10:26", "outputs.tf:2:24", "outputs.tf:10:36"],
    ],
    ["a variable named like a resource", "variables.tf", '"web"', ["variables.tf:11:11"]],
  ])("finds every reference to %s", async (_label, file, needle, expected) => {
    const result = await findReferences(fixtureIndex, await positionOf(fixtureRoot, file, needle, 1));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.referenceCoverage).toEqual({ scope: "indexed_candidates", state: "complete" });
    expect(
      result.references.map(
        (reference) =>
          `${relative(fixtureRoot, reference.file)}:${reference.range.start.line}:${reference.range.start.column}`,
      ),
    ).toEqual(expected);
  });

  it("previews a rename of a child input across its caller and rejects a same-kind name in the module", async () => {
    await withCopiedFixture(fixtureRoot, async (root) => {
      await fsp.writeFile(path.join(root, "modules", "network", "zone.tf"), 'variable "zone" {}\n', "utf8");
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "region" });
      const target = symbols.symbols.find((symbol) => symbol.location.file === "modules/network/variables.tf");
      expect(target).toBeDefined();
      const result = await previewRenameWithSession(session, { root, handle: target!.handle, newName: "aws_region" });
      expect(result.safe).toBe(true);
      expect(
        result.edits.map((edit) => `${edit.file}:${edit.range.start.line}:${edit.range.start.column}:${edit.oldText}`),
      ).toEqual([
        "main.tf:30:3:region",
        "modules/network/main.tf:3:31:region",
        "modules/network/variables.tf:5:11:region",
      ]);

      const collision = await previewRenameWithSession(session, { root, handle: target!.handle, newName: "zone" });
      expect(collision.safe).toBe(false);
      expect(collision.conflicts.map((conflict) => `${conflict.reason}:${conflict.file}`)).toEqual([
        "name_collision:modules/network/zone.tf",
      ]);
      // Variables, resources, and outputs are separate namespaces, so a resource name is free.
      const otherKind = await previewRenameWithSession(session, { root, handle: target!.handle, newName: "main" });
      expect(otherKind.safe).toBe(true);
      // HCL identifiers allow `-` after the first character.
      const hyphenated = await previewRenameWithSession(session, {
        root,
        handle: target!.handle,
        newName: "aws-region",
      });
      expect(hyphenated.safe).toBe(true);
      expect(hyphenated.edits.map((edit) => edit.newText)).toEqual(["aws-region", "aws-region", "aws-region"]);
      const leadingHyphen = await previewRenameWithSession(session, {
        root,
        handle: target!.handle,
        newName: "-region",
      });
      expect(leadingHyphen.conflicts.map((conflict) => conflict.reason)).toContain("invalid_identifier");
      // Module call meta-argument names cannot name an input variable.
      const reserved = await previewRenameWithSession(session, { root, handle: target!.handle, newName: "source" });
      expect(reserved.safe).toBe(false);
      expect(reserved.conflicts.map((conflict) => conflict.reason)).toEqual(["invalid_identifier"]);

      // Inputs and outputs are separate namespaces even when one file declares both.
      const storageSymbols = await workspaceSymbolsWithSession(session, { root, query: "region" });
      const storageInput = storageSymbols.symbols.find((symbol) => symbol.location.file === "modules/storage/main.tf");
      const sameFileOutputName = await previewRenameWithSession(session, {
        root,
        handle: storageInput!.handle,
        newName: "vpc_id",
      });
      expect(sameFileOutputName.conflicts).toEqual([]);
      expect(sameFileOutputName.safe).toBe(true);
    });
  });

  it("does not read a for_each instance key as an output, and keeps that module's output references partial", async () => {
    const root = await createTempProjectRoot("cg-terraform-for-each-", [
      {
        path: "main.tf",
        contents: [
          'module "net" {',
          '  source   = "./net"',
          '  for_each = toset(["primary"])',
          "}",
          'output "by_key" {',
          "  value = module.net.primary.vpc_id",
          "}",
          'output "by_index" {',
          '  value = module.net["primary"].vpc_id',
          "}",
          'output "by_splat" {',
          "  value = module.net[*].primary.vpc_id",
          "}",
          "",
        ].join("\n"),
      },
      // `primary` is also an output name: the decoy an instance key must not resolve to.
      { path: "net/outputs.tf", contents: 'output "vpc_id" {}\noutput "primary" {}\n' },
    ]);
    try {
      const index = await buildProjectIndex(root);
      const byKey = await goToDefinition(index, await positionOf(root, "main.tf", "net.primary", 4));
      expect(byKey.status).toBe("not_found");
      // A splat wraps the for_each map as one element, so `primary` is still an instance key.
      const bySplat = await goToDefinition(index, await positionOf(root, "main.tf", "[*].primary", 4));
      expect(bySplat.status).toBe("not_found");
      const byIndex = await goToDefinition(index, await positionOf(root, "main.tf", '"].vpc_id', 3));
      expect(byIndex.status).toBe("ok");
      if (byIndex.status === "ok") expect(relative(root, byIndex.definition.file)).toBe("net/outputs.tf");

      for (const [needle, expected] of [
        ['"primary"', ["net/outputs.tf:2"]],
        ['"vpc_id"', ["main.tf:9", "net/outputs.tf:1"]],
      ] as const) {
        const references = await findReferences(index, await positionOf(root, "net/outputs.tf", needle, 1));
        expect(references.status).toBe("ok");
        if (references.status !== "ok") return;
        expect(
          references.references.map((reference) => `${relative(root, reference.file)}:${reference.range.start.line}`),
        ).toEqual(expected);
        expect(references.referenceCoverage?.state, needle).toBe("partial");
      }

      const session = createAgentSession({ root, freshness: { policy: "check" } });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "primary" });
      const decoy = symbols.symbols.find((symbol) => symbol.location.file === "net/outputs.tf");
      const rename = await previewRenameWithSession(session, { root, handle: decoy!.handle, newName: "main_id" });
      expect(rename.safe).toBe(false);
      expect(rename.edits.map((edit) => `${edit.file}:${edit.range.start.line}`)).toEqual(["net/outputs.tf:2"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps output references partial when the module is used as a whole value", async () => {
    await withCopiedFixture(fixtureRoot, async (root) => {
      await fsp.writeFile(path.join(root, "whole.tf"), 'output "network_all" {\n  value = module.network\n}\n', "utf8");
      const index = await buildProjectIndex(root, { cache: "off" });
      const references = await findReferences(
        index,
        await positionOf(root, "modules/network/outputs.tf", '"vpc_id"', 1),
      );
      expect(references.status).toBe("ok");
      if (references.status !== "ok") return;
      expect(references.referenceCoverage).toEqual({
        scope: "indexed_candidates",
        state: "partial",
        reasons: ["strategy_unavailable"],
        affectedFiles: [normalizePath(path.join(root, "whole.tf"))],
      });
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "vpc_id" });
      const output = symbols.symbols.find((symbol) => symbol.location.file === "modules/network/outputs.tf");
      const rename = await previewRenameWithSession(session, { root, handle: output!.handle, newName: "network_id" });
      expect(rename.safe).toBe(false);
    });
  });
});

describe("Terraform edge forms", () => {
  async function referenceSummary(index: ProjectIndex, root: string, file: string, needle: string, offset = 1) {
    const references = await findReferences(index, await positionOf(root, file, needle, offset));
    expect(references.status).toBe("ok");
    if (references.status !== "ok") return undefined;
    return {
      sites: references.references.map(
        (reference) => `${relative(root, reference.file)}:${reference.range.start.line}`,
      ),
      coverage: references.referenceCoverage?.state,
    };
  }

  it("keeps the module source edge when a comment sits around the source value", async () => {
    const root = await createTempProjectRoot("cg-terraform-source-comment-", [
      {
        path: "main.tf",
        contents:
          'module "a" {\n  source = /* local */ "./net"\n}\nmodule "b" {\n  source /* local */ = "./other"\n}\n',
      },
      { path: "net/a.tf", contents: 'variable "x" {}\n' },
      { path: "other/a.tf", contents: 'variable "y" {}\n' },
    ]);
    try {
      const main = normalizePath(path.join(root, "main.tf"));
      const initial = await buildProjectIndexIncremental(root, { cache: "disk" });
      expect(edgeTargets(initial, root, main)).toEqual(["net/a.tf", "other/a.tf"]);
      await fsp.writeFile(path.join(root, "net", "b.tf"), 'variable "z" {}\n', "utf8");
      const warm = await buildProjectIndexIncremental(root, { cache: "disk" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(edgeTargets(warm, root, main)).toEqual(["net/a.tf", "net/b.tf", "other/a.tf"]);
      expect(edgeTargets(warm, root, main)).toEqual(edgeTargets(cold, root, main));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("re-resolves a parent-directory module source when a file is added there", async () => {
    const root = await createTempProjectRoot("cg-terraform-parent-", [
      { path: "a.tf", contents: 'variable "x" {}\n' },
      { path: "child/main.tf", contents: 'module "up" {\n  source = "../"\n}\n' },
    ]);
    try {
      const child = normalizePath(path.join(root, "child", "main.tf"));
      const initial = await buildProjectIndexIncremental(root, { cache: "disk" });
      expect(edgeTargets(initial, root, child)).toEqual(["a.tf"]);
      await fsp.writeFile(path.join(root, "b.tf"), 'variable "y" {}\n', "utf8");
      const warm = await buildProjectIndexIncremental(root, { cache: "disk" });
      const cold = await buildProjectIndex(root, { cache: "off" });
      expect(edgeTargets(warm, root, child)).toEqual(["a.tf", "b.tf"]);
      expect(edgeTargets(warm, root, child)).toEqual(edgeTargets(cold, root, child));
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("adds line and block context to references", async () => {
    const position = await positionOf(fixtureRoot, "variables.tf", '"region"', 1);
    const line = await findReferences(fixtureIndex, position, { context: "line", lines: 0 });
    const block = await findReferences(fixtureIndex, position, { context: "block" });
    expect(line.status).toBe("ok");
    expect(block.status).toBe("ok");
    if (line.status !== "ok" || block.status !== "ok") return;
    const firstLines = (references: typeof line.references) =>
      references.map((reference) => `${relative(fixtureRoot, reference.file)}:${reference.context?.split("\n")[0]}`);
    expect(firstLines(line.references)).toEqual([
      'main.tf:  name_prefix = "${var.region}-app"',
      "main.tf:  region = var.region",
      "main.tf:  region = var.region",
      'variables.tf:variable "region" {',
    ]);
    // Block context is the enclosing HCL block, not the whole file.
    expect(firstLines(block.references)).toEqual([
      "main.tf:locals {",
      'main.tf:module "network" {',
      'main.tf:module "storage" {',
      'variables.tf:variable "region" {',
    ]);
    const network = block.references[1]?.context ?? "";
    expect(network.split("\n").at(-1)).toBe("}");
    expect(network).not.toContain("locals");
  });

  it("reaches every file of a calling module in transitive impact", async () => {
    const changed = await locateChangedSymbols(fixtureIndex, fixtureFile("modules/network/main.tf"), [
      { oldStart: 2, newStart: 2, lines: ["+  cidr_block = var.cidr"] },
    ]);
    expect(changed.map((symbol) => `${symbol.name}:${symbol.kind}`)).toEqual(["main:resource"]);
    const impacted = await analyzeImpact(
      fixtureIndex,
      changed,
      [{ path: fixtureFile("modules/network/main.tf"), kind: "modified", hunks: [] }],
      { depth: 3 },
    );
    const files = impacted.map((item) => relative(fixtureRoot, item.file)).sort();
    // The child output reads the resource; the root reads that output from `outputs.tf`, which
    // holds no module block of its own.
    expect(files).toEqual(expect.arrayContaining(["modules/network/outputs.tf", "main.tf", "outputs.tf"]));
    expect(files).not.toContain("modules/storage/main.tf");
  });

  it("keeps child references partial when the module call is declared twice", async () => {
    const root = await createTempProjectRoot("cg-terraform-duplicate-call-", [
      {
        path: "main.tf",
        contents:
          'module "net" {\n  source = "./net"\n  r = 1\n}\nmodule "net" {\n  source = "./net"\n}\nlocals {\n  o = module.net.out\n}\n',
      },
      { path: "net/main.tf", contents: 'variable "r" {}\noutput "out" {}\n' },
    ]);
    try {
      const index = await buildProjectIndex(root);
      expect(await referenceSummary(index, root, "net/main.tf", '"r"')).toEqual({
        sites: ["net/main.tf:1"],
        coverage: "partial",
      });
      expect(await referenceSummary(index, root, "net/main.tf", '"out"')).toEqual({
        sites: ["net/main.tf:2"],
        coverage: "partial",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reads declarations and references through comments", async () => {
    const root = await createTempProjectRoot("cg-terraform-comments-", [
      {
        path: "main.tf",
        contents: [
          'variable "region" /* note */ {}',
          'resource "aws_instance" /* n */ "web" {}',
          "locals {",
          "  a = var /* c */ .region",
          "  b = aws_instance.web.id",
          "}",
          "",
        ].join("\n"),
      },
    ]);
    try {
      const index = await buildProjectIndex(root);
      expect(
        listSymbols(index, { file: normalizePath(path.join(root, "main.tf")) }).map((symbol) => symbol.name),
      ).toEqual(expect.arrayContaining(["region", "web"]));
      expect(await referenceSummary(index, root, "main.tf", '"region"')).toEqual({
        sites: ["main.tf:1", "main.tf:4"],
        coverage: "complete",
      });
      const goto = await goToDefinition(index, await positionOf(root, "main.tf", ".region", 1));
      expect(goto.status === "ok" && goto.definition.range.start.line).toBe(1);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reads an index after a single module call as an output, not an instance", async () => {
    const root = await createTempProjectRoot("cg-terraform-single-index-", [
      {
        path: "main.tf",
        contents: 'module "net" {\n  source = "./net"\n}\nlocals {\n  a = module.net["settings"].vpc_id\n}\n',
      },
      // `vpc_id` is also an output name: the decoy an object field must not resolve to.
      { path: "net/main.tf", contents: 'output "settings" {}\noutput "vpc_id" {}\n' },
    ]);
    try {
      const index = await buildProjectIndex(root);
      const field = await goToDefinition(index, await positionOf(root, "main.tf", "].vpc_id", 2));
      expect(field.status).toBe("not_found");
      expect(await referenceSummary(index, root, "net/main.tf", '"vpc_id"')).toEqual({
        sites: ["net/main.tf:2"],
        coverage: "partial",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("includes a module file symlinked inside the project and excludes one escaping it", async () => {
    const root = await mkTmpDir("cg-terraform-link-");
    const outside = await mkTmpDir("cg-terraform-link-outside-");
    try {
      await fsp.mkdir(path.join(root, "net"));
      await fsp.mkdir(path.join(root, "real"));
      await fsp.writeFile(path.join(root, "real", "inside.tf"), 'variable "a" {}\n', "utf8");
      await fsp.writeFile(path.join(outside, "outside.tf"), 'variable "b" {}\n', "utf8");
      await fsp.writeFile(path.join(root, "net", "plain.tf"), 'variable "c" {}\n', "utf8");
      try {
        await fsp.symlink(path.join(root, "real", "inside.tf"), path.join(root, "net", "inside.tf"), "file");
        await fsp.symlink(path.join(outside, "outside.tf"), path.join(root, "net", "outside.tf"), "file");
      } catch (error) {
        if (isSymlinkUnavailable(error)) return;
        throw error;
      }
      const resolved = await resolveTerraformModuleSourcePaths(root, "./net", path.join(root, "main.tf"));
      expect(resolved.map((file) => relative(normalizePath(root), file))).toEqual(["net/inside.tf", "net/plain.tf"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
      await fsp.rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps a dynamic iterator in its labels off a same-named resource", async () => {
    const root = await createTempProjectRoot("cg-terraform-dynamic-labels-", [
      {
        path: "main.tf",
        contents: [
          'resource "aws_subnet" "key" {}',
          'resource "aws_x" "y" {',
          '  dynamic "rule" {',
          "    for_each = [aws_subnet.key]",
          "    iterator = aws_subnet",
          "    labels   = [aws_subnet.key]",
          "    content {}",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ]);
    try {
      const index = await buildProjectIndex(root);
      const inLabels = await goToDefinition(index, await positionOf(root, "main.tf", "aws_subnet.key]", 11, 1));
      expect(inLabels.status).toBe("not_found");
      // `for_each` stays in the enclosing scope, so its use still names the resource.
      expect(await referenceSummary(index, root, "main.tf", '"key"')).toEqual({
        sites: ["main.tf:1", "main.tf:4"],
        coverage: "complete",
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("binds a check block's data use to its scoped data source, not the module-wide one", async () => {
    const root = await createTempProjectRoot("cg-terraform-check-data-", [
      {
        path: "main.tf",
        contents: [
          'data "http" "health" {}',
          'check "up" {',
          '  data "http" "health" {}',
          "  assert {",
          "    condition = data.http.health.status_code == 200",
          "  }",
          "}",
          "locals {",
          "  body = data.http.health.response_body",
          "}",
          "",
        ].join("\n"),
      },
    ]);
    try {
      const index = await buildProjectIndex(root);
      const inCheck = await goToDefinition(index, await positionOf(root, "main.tf", "data.http.health.status", 10));
      expect(inCheck.status).toBe("not_found");
      expect(await referenceSummary(index, root, "main.tf", '"health"')).toEqual({
        sites: ["main.tf:1", "main.tf:9"],
        coverage: "complete",
      });
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "health" });
      const rename = await previewRenameWithSession(session, {
        root,
        handle: symbols.symbols[0]!.handle,
        newName: "status",
      });
      expect(rename.edits.map((edit) => `${edit.file}:${edit.range.start.line}`)).toEqual(["main.tf:1", "main.tf:9"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("does not rename ECMAScript-like export text in Terraform comments", async () => {
    const root = await createTempProjectRoot("cg-terraform-export-comment-", [
      { path: "main.tf", contents: 'variable "region" {}\n# export { region }\nlocals {\n  r = var.region\n}\n' },
    ]);
    try {
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "region" });
      const rename = await previewRenameWithSession(session, {
        root,
        handle: symbols.symbols[0]!.handle,
        newName: "zone",
      });
      expect(rename.edits.map((edit) => `${edit.file}:${edit.range.start.line}:${edit.kind}`)).toEqual([
        "main.tf:1:definition",
        "main.tf:4:reference",
      ]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("finds references that are operands of binary and unary operators", async () => {
    const root = await createTempProjectRoot("cg-terraform-operators-", [
      {
        path: "main.tf",
        contents: [
          'variable "a" {}',
          'variable "b" {}',
          "locals {",
          "  sum  = var.a + var.b",
          "  not  = !var.b",
          "  both = var.a == 1 && -var.b > 0",
          "}",
          "",
        ].join("\n"),
      },
    ]);
    try {
      const index = await buildProjectIndex(root);
      const summary = await findReferences(index, await positionOf(root, "main.tf", '"b"', 1));
      expect(summary.status).toBe("ok");
      if (summary.status !== "ok") return;
      expect(
        summary.references.map((reference) => `${reference.range.start.line}:${reference.range.start.column}`),
      ).toEqual(["2:11", "4:22", "5:15", "6:29"]);
      const right = await goToDefinition(index, await positionOf(root, "main.tf", "+ var.b", 6));
      expect(right.status === "ok" && right.definition.localName).toBe("b");
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("reaches same-module files in transitive impact, including after a file is deleted", async () => {
    // `region` feeds `main.tf`'s resource; `outputs.tf` reads that resource, not `region`.
    const changed = await locateChangedSymbols(fixtureIndex, fixtureFile("variables.tf"), [
      { oldStart: 3, newStart: 3, lines: ['+  default = "us-west-2"'] },
    ]);
    const fromInput = await analyzeImpact(
      fixtureIndex,
      changed,
      [{ path: fixtureFile("variables.tf"), kind: "modified", hunks: [] }],
      { depth: 3 },
    );
    expect(fromInput.map((item) => relative(fixtureRoot, item.file))).toEqual(
      expect.arrayContaining(["main.tf", "outputs.tf"]),
    );

    const root = await createTempProjectRoot("cg-terraform-deleted-", [
      { path: "main.tf", contents: "locals {\n  a = aws_s3_bucket.logs.id\n}\n" },
      { path: "other/main.tf", contents: 'variable "x" {}\n' },
    ]);
    try {
      const index = await buildProjectIndex(root);
      const deleted = normalizePath(path.join(root, "storage.tf"));
      const impacted = await analyzeImpact(index, [], [{ path: deleted, kind: "deleted", hunks: [] }], { depth: 2 });
      expect(impacted.map((item) => relative(root, item.file))).toEqual(["main.tf"]);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects renaming a data source to a name a check block declares for itself", async () => {
    const root = await createTempProjectRoot("cg-terraform-check-capture-", [
      {
        path: "main.tf",
        contents: [
          'data "http" "health" {}',
          'check "up" {',
          '  data "http" "status" {}',
          "  assert {",
          "    condition = data.http.health.status_code == 200",
          "  }",
          "}",
          "",
        ].join("\n"),
      },
    ]);
    try {
      const session = createAgentSession({ root, freshness: { policy: "check" } });
      const symbols = await workspaceSymbolsWithSession(session, { root, query: "health" });
      const handle = symbols.symbols[0]!.handle;
      const captured = await previewRenameWithSession(session, { root, handle, newName: "status" });
      expect(captured.safe).toBe(false);
      expect(captured.conflicts.map((conflict) => `${conflict.reason}:${conflict.location?.range.start.line}`)).toEqual(
        ["shadowing:5"],
      );
      const free = await previewRenameWithSession(session, { root, handle, newName: "probe" });
      expect(free.safe).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps child input references partial when a caller file cannot be read", async () => {
    await withCopiedFixture(fixtureRoot, async (root) => {
      const index = await buildProjectIndex(root, { cache: "off", keepParsed: false });
      // `main.tf` holds the only `module "network"` call; it disappears after indexing.
      await fsp.rm(path.join(root, "main.tf"));
      const references = await findReferences(
        index,
        await positionOf(root, "modules/network/variables.tf", '"region"', 1),
      );
      expect(references.status).toBe("ok");
      if (references.status !== "ok") return;
      expect(references.referenceCoverage?.state).toBe("partial");
      expect(references.referenceCoverage?.affectedFiles).toContain(normalizePath(path.join(root, "main.tf")));
    });
  });
});
