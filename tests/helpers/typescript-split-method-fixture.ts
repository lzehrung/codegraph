import path from "node:path";
import ts from "typescript";
import { expect } from "vitest";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";

export function typescriptSplitMethodSources(extension: "ts" | "tsx"): Record<string, string> {
  return {
    [`types.${extension}`]: [
      "export interface Base { m(value: number): void }",
      "export interface Contract extends Base {",
      "  readonly m?",
      "  <T>(): void",
      "}",
      "export class Parent { m(value: number): void {} }",
      "export class Child extends Parent {",
      "  m",
      "  <T>(): void {}",
      "}",
      "",
    ].join("\n"),
    [`use.${extension}`]: [
      'import { Contract, Child } from "./types";',
      "export function run(x: Contract, child: Child) {",
      "  x.m<string>();",
      "  x.m();",
      "  child.m<string>();",
      "  child.m();",
      "}",
      "",
    ].join("\n"),
    [`decoy.${extension}`]: "export interface Other { m(): void }\n",
  };
}

export async function expectTypeScriptSplitMethods(
  index: ProjectIndex,
  root: string,
  extension: "ts" | "tsx",
): Promise<void> {
  const sources = typescriptSplitMethodSources(extension);
  const types = path.join(root, `types.${extension}`).replace(/\\/g, "/");
  const use = path.join(root, `use.${extension}`).replace(/\\/g, "/");
  const source = sources[`types.${extension}`]!;
  const consumer = sources[`use.${extension}`]!;
  const compiler = ts.createLanguageService({
    getScriptFileNames: () => Object.keys(sources).map((name) => path.join(root, name)),
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      const text = sources[path.basename(name)];
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => ({ noLib: true, jsx: ts.JsxEmit.Preserve }),
    getDefaultLibFileName: () => "",
    fileExists: (name) => sources[path.basename(name)] !== undefined,
    readFile: (name) => sources[path.basename(name)],
  });
  try {
    expect(compiler.getSyntacticDiagnostics(types)).toEqual([]);
    const parsed = compiler.getProgram()!.getSourceFile(types)!;
    const contract = parsed.statements[1]!;
    const child = parsed.statements[3]!;
    if (!ts.isInterfaceDeclaration(contract) || !ts.isClassDeclaration(child)) throw new Error("Missing owners");
    expect(contract.members.map((member) => ts.SyntaxKind[member.kind])).toEqual(["MethodSignature"]);
    expect(child.members.map((member) => ts.SyntaxKind[member.kind])).toEqual(["MethodDeclaration"]);
    const module = index.byFile.get(fileIdentityKey(types));
    const graph = await buildSymbolGraphDetailed(index);
    for (const [declarationLine, useLines] of [
      [3, [3, 4]],
      [8, [5, 6]],
    ] as const) {
      const definition = module?.locals.find((local) => local.range.start.line === declarationLine);
      expect(definition?.kind).toBe("function");
      expect(definition?.callable?.arity).toEqual({ minArgs: 0, maxArgs: 0 });
      const declarationIndex = definition!.range.start.index!;
      for (const line of useLines) {
        const column = consumer.split("\n")[line - 1]!.indexOf("m") + 1;
        const useIndex =
          consumer
            .split("\n")
            .slice(0, line - 1)
            .join("\n").length + column;
        expect(compiler.getDefinitionAtPosition(use, useIndex)?.map((target) => target.textSpan.start)).toEqual([
          declarationIndex,
        ]);
        const target = await goToDefinition(index, { file: use, line, column });
        expect(target.status).toBe("ok");
        if (target.status === "ok") {
          expect(fileIdentityKey(target.definition.file)).toBe(fileIdentityKey(types));
          expect(target.definition.range.start.line).toBe(declarationLine);
          expect(target.definition.kind).toBe("function");
          expect(target.definition.callable?.arity).toEqual({ minArgs: 0, maxArgs: 0 });
        }
      }
      const compilerRefs = compiler.findReferences(types, declarationIndex);
      const ownRefs = compilerRefs?.find((group) => group.definition.textSpan.start === declarationIndex);
      expect(ownRefs?.references).toHaveLength(3);
      const references = await findReferences(index, {
        file: types,
        line: declarationLine,
        column: source.split("\n")[declarationLine - 1]!.indexOf("m") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok") {
        // Native class recovery still contains a missing name. Preserve the calls
        // without claiming that every candidate in this module parsed completely.
        expect(references.referenceCoverage.state).toBe("partial");
        expect(references.referenceCoverage.reasons).toContain("parse_error");
        expect(
          references.references.map((reference) => [path.basename(reference.file), reference.range.start.line]),
        ).toEqual([[`types.${extension}`, declarationLine], ...useLines.map((line) => [`use.${extension}`, line])]);
      }
      const targetId = `${types}::m::${declarationIndex}`;
      expect(graph.edges.some((edge) => edge.label === "member_of" && edge.from === targetId)).toBe(true);
      expect(graph.edges.some((edge) => edge.label === "calls" && edge.to === targetId)).toBe(true);
    }
    for (const line of [1, 6]) {
      const references = await findReferences(index, {
        file: types,
        line,
        column: source.split("\n")[line - 1]!.indexOf("m(") + 1,
      });
      expect(references.status).toBe("ok");
      if (references.status === "ok")
        expect(references.references.map((reference) => reference.range.start.line)).toEqual([line]);
    }
  } finally {
    compiler.dispose();
  }
}
