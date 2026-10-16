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
import { createTempProjectRoot, readOnlySamplePath, withCopiedFixture } from "../helpers/filesystem.js";

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
      ["modules/network/outputs.tf:1:9", "outputs.tf:6:26"],
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
    });
  });
});
