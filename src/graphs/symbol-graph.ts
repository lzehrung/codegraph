import type { ProjectIndex } from "../indexer/types.js";
import { resolveExport, resolveModuleExports } from "../indexer/navigation-resolve.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey, normalizePath } from "../util/paths.js";

export type SymbolNodeKind =
  | "function"
  | "class"
  | "variable"
  | "interface"
  | "type"
  | "default"
  | "table"
  | "view"
  | "index"
  | "constraint"
  | "routine"
  | "import"
  | "namespaceImport";

export type SymbolVisibility = "public" | "private" | "protected" | "internal";

export type SymbolNode = {
  id: string;
  file: FileId;
  name: string;
  kind: SymbolNodeKind;
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
  visibility?: SymbolVisibility;
  implementationTarget?: boolean;
  memberArity?: number;
};

export type SymbolEdge = {
  from: string;
  to: string;
  label?: string;
  site?: { file: FileId; range: Range };
};

export type SymbolGraph = {
  nodes: Map<string, SymbolNode>;
  edges: SymbolEdge[];
};

export type BuildSymbolGraphOptions = {
  files?: Set<FileId>;
};

function normalizeSymbolNodeKind(kind: string): SymbolNodeKind {
  if (kind === "function") return "function";
  if (kind === "class") return "class";
  if (kind === "variable") return "variable";
  if (kind === "interface") return "interface";
  if (kind === "type") return "type";
  if (kind === "default") return "default";
  if (kind === "table") return "table";
  if (kind === "view") return "view";
  if (kind === "index") return "index";
  if (kind === "constraint") return "constraint";
  if (kind === "routine") return "routine";
  if (kind === "import") return "import";
  if (kind === "namespaceImport") return "namespaceImport";
  return "variable";
}

export function defNodeId(def: { file: string; localName: string; range?: { start: { index?: number } } }): string {
  const index = def.range?.start?.index ?? 0;
  const file = typeof def.file === "string" ? def.file.replace(/\\/g, "/") : def.file;
  return `${file}::${def.localName}::${index}`;
}

export function nodeForDef(def: {
  file: string;
  localName: string;
  kind: string;
  range?: { start: { index?: number } };
  docstring?: string;
  lineSpan?: number;
  complexity?: number;
}): SymbolNode {
  return {
    id: defNodeId(def),
    file: def.file,
    name: def.localName,
    kind: normalizeSymbolNodeKind(def.kind),
    ...(def.docstring ? { docstring: def.docstring } : {}),
    ...(def.lineSpan ? { lineSpan: def.lineSpan } : {}),
    ...(typeof def.complexity === "number" ? { complexity: def.complexity } : {}),
  };
}

function normalizeFileFilter(files?: Set<FileId>): Set<string> | undefined {
  if (!files) return undefined;
  return new Set(Array.from(files, fileIdentityKey));
}

export async function buildSymbolGraph(index: ProjectIndex, opts?: BuildSymbolGraphOptions): Promise<SymbolGraph> {
  await Promise.resolve();
  const nodes = new Map<string, SymbolNode>();
  const edges: SymbolEdge[] = [];
  const seenEdges = new Set<string>();
  const includedFiles = normalizeFileFilter(opts?.files);

  const shouldIncludeFile = (file: FileId): boolean => {
    if (!includedFiles) return true;
    return includedFiles.has(fileIdentityKey(file));
  };

  const addEdge = (from: string, to: string, label?: string) => {
    const key = `${from}->${to}::${label ?? ""}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(label ? { from, to, label } : { from, to });
  };

  const addDefinitionEdge = (aliasId: string, targetFile: FileId, exportedName: string, label: string): void => {
    const resolved = resolveExport(index, targetFile, exportedName);
    if (!resolved || resolved.kind !== "resolved") return;
    const def = resolved.def;
    const targetId = defNodeId(def);
    if (!nodes.has(targetId)) nodes.set(targetId, nodeForDef(def));
    addEdge(aliasId, targetId, label);
  };

  for (const mod of index.byFile.values()) {
    const displayFile = normalizePath(mod.file);
    if (!shouldIncludeFile(displayFile)) continue;
    for (const def of mod.locals) {
      const node = nodeForDef(def);
      if (!nodes.has(node.id)) nodes.set(node.id, node);
    }
  }
  for (const mod of index.byFile.values()) {
    const displayFile = normalizePath(mod.file);
    if (!shouldIncludeFile(displayFile)) continue;
    for (const imp of mod.imports) {
      if (!imp) continue;
      const targetFile = typeof imp.resolved === "string" ? normalizePath(imp.resolved) : undefined;

      if (imp.kind === "named") {
        const aliasId = `${displayFile}::${imp.local}::import`;
        if (!nodes.has(aliasId)) {
          nodes.set(aliasId, {
            id: aliasId,
            file: displayFile,
            name: imp.local,
            kind: "import",
          });
        }
        if (targetFile) addDefinitionEdge(aliasId, targetFile, imp.imported, imp.imported);
      } else if (imp.kind === "default") {
        const aliasId = `${displayFile}::${imp.local}::import`;
        if (!nodes.has(aliasId)) {
          nodes.set(aliasId, {
            id: aliasId,
            file: displayFile,
            name: imp.local,
            kind: "import",
          });
        }
        if (targetFile) addDefinitionEdge(aliasId, targetFile, "default", "default");
      } else if (imp.kind === "namespace") {
        const aliasId = `${displayFile}::${imp.localNS}::import`;
        if (!nodes.has(aliasId)) {
          nodes.set(aliasId, {
            id: aliasId,
            file: displayFile,
            name: imp.localNS,
            kind: "namespaceImport",
          });
        }
        if (targetFile) {
          const exports = resolveModuleExports(index, targetFile, { allowLocalFallback: false });
          for (const [exportedName, resolved] of exports) {
            if (resolved.kind !== "resolved") continue;
            const def = resolved.def;
            const targetId = defNodeId(def);
            if (!nodes.has(targetId)) nodes.set(targetId, nodeForDef(def));
            addEdge(aliasId, targetId, exportedName);
          }
        }
      }
    }
  }

  return { nodes, edges };
}
