import { builtinModules } from "node:module";
import type { FileId, Graph } from "../types.js";
import {
  classifyExternalSpecifier,
  type ExternalSpecifierClassification,
  type ExternalSpecifierClassificationOptions,
} from "./external-classifier.js";

const NODE_BUILTIN_MODULES = new Set<string>([
  ...builtinModules,
  ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `node:${name}`),
]);

function isNodeBuiltinSpecifier(specifier: string): boolean {
  return NODE_BUILTIN_MODULES.has(specifier);
}

export type UnresolvedImportOptions = ExternalSpecifierClassificationOptions;

export function getUnresolvedImports(
  graph: Graph,
  opts: UnresolvedImportOptions = {},
): Array<{
  name: string;
  importers: Array<{ file: FileId; raw: string }>;
}> {
  const unresolved = new Map<string, Array<{ file: FileId; raw: string }>>();
  const classificationCache = new Map<string, ExternalSpecifierClassification>();
  for (const edge of graph.edges) {
    if (edge.to.type !== "external") continue;
    if (isNodeBuiltinSpecifier(edge.to.name) || isNodeBuiltinSpecifier(edge.raw)) continue;
    const classificationKey = `${edge.from}\0${edge.to.name}\0${edge.raw}\0${opts.projectRoot ?? ""}`;
    let classification = classificationCache.get(classificationKey);
    if (!classification) {
      classification = classifyExternalSpecifier({
        raw: edge.raw,
        externalName: edge.to.name,
        importerFile: edge.from,
        options: opts,
      });
      classificationCache.set(classificationKey, classification);
    }
    if (classification.status !== "unresolved") continue;
    const importers = unresolved.get(edge.to.name) ?? [];
    importers.push({ file: edge.from, raw: edge.raw });
    unresolved.set(edge.to.name, importers);
  }
  return Array.from(unresolved.entries())
    .map(([name, importers]) => ({ name, importers }))
    .sort((left, right) => right.importers.length - left.importers.length);
}
