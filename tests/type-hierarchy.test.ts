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
      "export abstract class AbstractJob {",
      "  abstract execute(): void;",
      "}",
      "export class ConcreteJob extends AbstractJob {",
      "  execute(): void {}",
      "}",
      "export class InheritedJob extends ConcreteJob {}",
      "export class IncompatibleJob extends AbstractJob { execute(value: string): void {} }",
      "export class NumberIncompatibleJob extends AbstractJob { execute(value: number): void {} }",
      "export class ThirdIncompatibleJob extends AbstractJob { execute(value: boolean): void {} }",
      "export interface Overloaded { run(value: string): void; run(value: number): void }",
      "export class OverloadedWorker implements Overloaded { run(value: string | number): void {} }",
      "export interface DistinctOverloaded { run(): void; run(value: string): void }",
      "export class ZeroWorker implements DistinctOverloaded { run(): void {}; run(value: string): void {} }",
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
    expect(
      result.relations.map((relation) => [
        byName.get(graph.nodes.get(relation.targetId)!.name)?.name,
        relation.relation,
        relation.depth,
      ]),
    ).toEqual([
      ["Worker", "extends", 1],
      ["Base", "extends", 2],
      ["Service", "implements", 2],
    ]);
    expect(result.omitted).toBe(0);
    expect(result.relations.every((relation) => relation.site?.file.endsWith("types.ts"))).toBe(true);
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
    expect(memberResult.implementations.map((entry) => graph.nodes.get(entry.symbolId)?.name)).toEqual(["run"]);
    expect(
      memberResult.implementations.map((entry) =>
        entry.implementingTypeId ? graph.nodes.get(entry.implementingTypeId)?.name : undefined,
      ),
    ).toEqual(["Worker"]);
    expect(memberResult.implementations[0]?.site?.file.endsWith("types.ts")).toBe(true);
    expect(
      memberResult.implementations.some(
        (entry) => graph.nodes.get(entry.implementingTypeId ?? "")?.name === "Unrelated",
      ),
    ).toBe(false);
  });
  it("finds abstract overrides once and excludes inherited declarations without overrides", async () => {
    const { index, graph, byName } = await hierarchyFixture();
    const abstractJob = byName.get("AbstractJob");
    expect(abstractJob).toBeDefined();
    const typeResult = findImplementations(index, graph, abstractJob!.id, { limit: 1 });
    expect(typeResult.status).toBe("ok");
    if (typeResult.status !== "ok") return;
    expect(typeResult.implementations.map((entry) => graph.nodes.get(entry.symbolId)?.name)).toEqual(["ConcreteJob"]);
    expect(typeResult.omitted).toBe(4);
    expect(typeResult.implementations[0]?.site?.file.endsWith("types.ts")).toBe(true);

    const executeId = graph.edges
      .filter((edge) => edge.to === abstractJob!.id && edge.label === "member_of")
      .map((edge) => edge.from)
      .find((id) => graph.nodes.get(id)?.name === "execute");
    expect(executeId).toBeDefined();

    const result = findImplementations(index, graph, executeId!, { limit: 1 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.implementations.map((entry) => graph.nodes.get(entry.symbolId)?.name)).toEqual(["execute"]);
    expect(
      result.implementations.map((entry) =>
        entry.implementingTypeId ? graph.nodes.get(entry.implementingTypeId)?.name : undefined,
      ),
    ).toEqual(["ConcreteJob"]);
    expect(result.implementations[0]?.site?.file.endsWith("types.ts")).toBe(true);
    expect(result.omitted).toBe(3);
    expect(result.ambiguous).toBe(3);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0]?.site?.file.endsWith("types.ts")).toBe(true);
  });

  it("rejects overloaded members and ordinary concrete types instead of guessing", async () => {
    const { index, graph, byName } = await hierarchyFixture();
    const overloaded = byName.get("Overloaded");
    const base = byName.get("Base");
    const distinct = byName.get("DistinctOverloaded");
    expect(overloaded).toBeDefined();
    expect(base).toBeDefined();
    expect(distinct).toBeDefined();
    const overloadedMemberIds = graph.edges
      .filter((edge) => edge.to === overloaded!.id && edge.label === "member_of")
      .map((edge) => edge.from)
      .filter((id) => graph.nodes.get(id)?.name === "run");
    expect(overloadedMemberIds.length).toBeGreaterThan(1);

    const memberResult = findImplementations(index, graph, overloadedMemberIds[0]!);
    expect(memberResult).toMatchObject({ status: "unsupported_target" });
    if (memberResult.status === "unsupported_target") {
      expect(memberResult.reason).toMatch(/ambiguous|overload/i);
    }
    const distinctMemberIds = graph.edges
      .filter((edge) => edge.to === distinct!.id && edge.label === "member_of")
      .map((edge) => edge.from)
      .filter((id) => graph.nodes.get(id)?.name === "run");
    const zeroArityMember = distinctMemberIds.find((id) => graph.nodes.get(id)?.memberArity === 0);
    const oneArityMember = distinctMemberIds.find((id) => graph.nodes.get(id)?.memberArity === 1);
    expect(zeroArityMember).toBeDefined();
    expect(oneArityMember).toBeDefined();
    const distinctResult = findImplementations(index, graph, zeroArityMember!);
    expect(distinctResult.status).toBe("ok");
    if (distinctResult.status === "ok") {
      expect(
        distinctResult.implementations.map((entry) =>
          entry.implementingTypeId ? graph.nodes.get(entry.implementingTypeId)?.name : undefined,
        ),
      ).toEqual(["ZeroWorker"]);
      expect(graph.nodes.get(distinctResult.implementations[0]!.symbolId)?.memberArity).toBe(0);
      expect(distinctResult.ambiguous).toBe(0);
      expect(distinctResult.unresolved).toEqual([]);
    }
    const oneArityResult = findImplementations(index, graph, oneArityMember!);
    expect(oneArityResult.status).toBe("ok");
    if (oneArityResult.status === "ok") {
      expect(oneArityResult.implementations).toHaveLength(1);
      expect(
        oneArityResult.implementations.map((entry) =>
          entry.implementingTypeId ? graph.nodes.get(entry.implementingTypeId)?.name : undefined,
        ),
      ).toEqual(["ZeroWorker"]);
      expect(graph.nodes.get(oneArityResult.implementations[0]!.symbolId)?.memberArity).toBe(1);
      expect(oneArityResult.ambiguous).toBe(0);
      expect(oneArityResult.unresolved).toEqual([]);
    }
    expect(findImplementations(index, graph, base!.id)).toMatchObject({
      status: "unsupported_target",
      reason: expect.stringContaining("abstract"),
    });
  });
  it("pins omission counts at and just past the limit for type hierarchy and implementations", async () => {
    const { index, graph, byName } = await hierarchyFixture();
    const specialized = byName.get("SpecializedWorker");
    expect(specialized).toBeDefined();

    const atSuperLimit = findTypeHierarchy(graph, specialized!.id, "super", { depth: 3, limit: 3 });
    expect(atSuperLimit).toMatchObject({ status: "ok", omitted: 0 });
    if (atSuperLimit.status === "ok") {
      expect(atSuperLimit.relations).toHaveLength(3);
    }

    const pastSuperLimit = findTypeHierarchy(graph, specialized!.id, "super", { depth: 3, limit: 2 });
    expect(pastSuperLimit).toMatchObject({ status: "ok", omitted: 1 });
    if (pastSuperLimit.status === "ok") {
      expect(pastSuperLimit.relations).toHaveLength(2);
    }

    const service = byName.get("Service");
    expect(service).toBeDefined();

    const atImplLimit = findImplementations(index, graph, service!.id, { limit: 2 });
    expect(atImplLimit).toMatchObject({ status: "ok", omitted: 0 });
    if (atImplLimit.status === "ok") {
      expect(atImplLimit.implementations).toHaveLength(2);
    }

    const pastImplLimit = findImplementations(index, graph, service!.id, { limit: 1 });
    expect(pastImplLimit).toMatchObject({ status: "ok", omitted: 1 });
    if (pastImplLimit.status === "ok") {
      expect(pastImplLimit.implementations).toHaveLength(1);
    }
  });
});
