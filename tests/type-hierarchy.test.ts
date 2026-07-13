import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildProjectIndex } from "../src/indexer/build-index.js";
import { findImplementations, findTypeHierarchy } from "../src/indexer/type-hierarchy.js";
import { buildSymbolGraphDetailed } from "../src/graphs/symbol-graph-detailed.js";
import { mkTmpDir } from "./helpers/filesystem.js";

async function hierarchyFixture() {
  const root = await mkTmpDir("cg-type-hierarchy-");
  await fsp.writeFile(
    path.join(root, "types.ts"),
    [
      "export interface Service { run(): void }",
      "export class Base {}",
      "export class Worker extends Base implements Service { run(): void {} }",
      "export class SpecializedWorker extends Worker {}",
      "export class Unrelated { run(): void {} }",
    ].join("\n"),
  );
  const index = await buildProjectIndex(root);
  const graph = await buildSymbolGraphDetailed(index);
  const byName = new Map([...graph.nodes.values()].map((node) => [node.name, node]));
  return { index, graph, byName };
}

describe("type hierarchy", () => {
  it("returns deterministic direct and transitive relations with relation kinds", async () => {
    const { graph, byName } = await hierarchyFixture();
    const specialized = byName.get("SpecializedWorker");
    expect(specialized).toBeDefined();

    const result = findTypeHierarchy(graph, specialized!.id, "super", { depth: 3, limit: 10 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.relations.map((relation) => [byName.get(graph.nodes.get(relation.targetId)!.name)?.name, relation.relation, relation.depth])).toEqual([
      ["Worker", "extends", 1],
      ["Base", "extends", 2],
      ["Service", "implements", 2],
    ]);
    expect(result.omitted).toBe(0);
  });

  it("bounds cycles and records post-ranking omissions", () => {
    const graph = {
      nodes: new Map([
        ["a", { id: "a", file: "a.ts", name: "A", kind: "class" as const }],
        ["b", { id: "b", file: "b.ts", name: "B", kind: "class" as const }],
        ["c", { id: "c", file: "c.ts", name: "C", kind: "class" as const }],
      ]),
      edges: [
        { from: "a", to: "b", label: "extends" },
        { from: "b", to: "a", label: "extends" },
        { from: "c", to: "a", label: "extends" },
      ],
    };
    const result = findTypeHierarchy(graph, "a", "sub", { depth: 10, limit: 1 });
    expect(result).toMatchObject({ status: "ok", omitted: 1 });
    if (result.status !== "ok") return;
    expect(result.relations).toEqual([{ targetId: "b", relation: "extends", depth: 1 }]);
  });

  it("finds proven type and interface-member implementations without unrelated name matches", async () => {
    const { index, graph, byName } = await hierarchyFixture();
    const service = byName.get("Service");
    expect(service).toBeDefined();

    const typeResult = findImplementations(index, graph, service!.id);
    expect(typeResult.status).toBe("ok");
    if (typeResult.status !== "ok") return;
    expect(typeResult.implementations.map((entry) => graph.nodes.get(entry.symbolId)?.name)).toEqual([
      "SpecializedWorker",
      "Worker",
    ]);

    const memberEdge = graph.edges.find((edge) => edge.to === service!.id && edge.label === "member_of");
    expect(memberEdge).toBeDefined();
    const memberNode = memberEdge ? graph.nodes.get(memberEdge.from) : undefined;
    expect(memberNode?.name).toBe("run");

    const memberResult = findImplementations(index, graph, memberNode!.id);
    expect(memberResult.status).toBe("ok");
    if (memberResult.status !== "ok") return;
    const implementationNames = memberResult.implementations.map((entry) =>
      entry.implementedMemberId ? graph.nodes.get(entry.implementedMemberId)?.name : undefined,
    );
    expect(implementationNames).toEqual(["run"]);
    expect(memberResult.implementations.map((entry) => graph.nodes.get(entry.symbolId)?.name)).toEqual(["Worker"]);
    expect(memberResult.implementations.some((entry) => graph.nodes.get(entry.symbolId)?.name === "Unrelated")).toBe(false);
  });
});
