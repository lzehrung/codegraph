import path from "node:path";
import type { Graph } from "../types.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { dotLabel, mermaidLabel } from "./render.js";

type SymbolNodeLike = {
  id: string;
  name: string;
  file: string;
  kind: string;
};

type SymbolEdgeLike = {
  from: string;
  to: string;
  label?: string;
};

type SymbolGraphLike = {
  nodes: Map<string, SymbolNodeLike>;
  edges: SymbolEdgeLike[];
};

function symbolDisplayLabel(node: SymbolNodeLike, projectRoot?: string): string {
  const relativeFile = toProjectDisplayPath(projectRoot, node.file);
  const base = path.basename(relativeFile);
  if (node.kind === "import") return `${base}:${node.name} (import)`;
  if (node.kind === "namespaceImport") return `${base}:${node.name} (namespace)`;
  return `${base}:${node.name}`;
}

export function graphToMermaidSymbols(sg: SymbolGraphLike, projectRoot?: string): string {
  const idOf = new Map<string, string>();
  const labels = new Map<string, string>();
  let index = 0;
  for (const [id, node] of sg.nodes) {
    const nodeId = `n${index++}`;
    idOf.set(id, nodeId);
    labels.set(nodeId, symbolDisplayLabel(node, projectRoot));
  }
  const declared = new Set<string>();
  const lines: string[] = ["flowchart LR"];
  for (const [id, label] of labels) {
    if (declared.has(id)) continue;
    declared.add(id);
    lines.push(`${id}["${mermaidLabel(label)}"]`);
  }
  for (const edge of sg.edges) {
    const fromId = idOf.get(edge.from)!;
    const toId = idOf.get(edge.to)!;
    if (edge.label) lines.push(`${fromId} -- "${mermaidLabel(edge.label)}" --> ${toId}`);
    else lines.push(`${fromId} --> ${toId}`);
  }
  return lines.join("\n");
}

export function graphToDOTSymbols(sg: SymbolGraphLike, projectRoot?: string): string {
  const idOf = new Map<string, string>();
  const labels = new Map<string, string>();
  let index = 0;
  for (const [id, node] of sg.nodes) {
    const nodeId = `n${index++}`;
    idOf.set(id, nodeId);
    labels.set(nodeId, symbolDisplayLabel(node, projectRoot));
  }
  const lines: string[] = [];
  lines.push("digraph G {");
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, fontsize=10, fontname="Arial"];\n');
  for (const [id, label] of labels) {
    lines.push(`  ${id} [label="${dotLabel(label)}"];`);
  }
  for (const edge of sg.edges) {
    const fromId = idOf.get(edge.from)!;
    const toId = idOf.get(edge.to)!;
    const attrs: string[] = [];
    if (edge.label) attrs.push(`label="${dotLabel(edge.label)}"`);
    lines.push(`  ${fromId} -> ${toId}${attrs.length ? " [" + attrs.join(",") + "]" : ""};`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function graphToMermaidSymbolsWithFiles(sg: SymbolGraphLike, fg: Graph, projectRoot?: string): string {
  const fileIdOf = new Map<string, string>();
  const fileNodeMeta = new Map<string, { label: string; external: boolean }>();
  let fileIndex = 0;
  const fileLabel = (file: string) => toProjectDisplayPath(projectRoot, file);
  const ensureFile = (file: string) => {
    if (!fileIdOf.has(file)) {
      const id = `f${fileIndex++}`;
      fileIdOf.set(file, id);
      fileNodeMeta.set(id, { label: fileLabel(file), external: false });
    }
  };
  const ensureExternal = (name: string) => {
    if (!fileIdOf.has(name)) {
      const id = `f${fileIndex++}`;
      fileIdOf.set(name, id);
      fileNodeMeta.set(id, { label: name, external: true });
    }
  };
  for (const file of fg.nodes) ensureFile(file);
  for (const edge of fg.edges) {
    ensureFile(edge.from);
    if (edge.to.type === "file") ensureFile(edge.to.path);
    else ensureExternal(edge.to.name);
  }

  const symbolIdOf = new Map<string, string>();
  const symbolLabels = new Map<string, string>();
  let symbolIndex = 0;
  for (const [id, node] of sg.nodes) {
    const symbolId = `s${symbolIndex++}`;
    symbolIdOf.set(id, symbolId);
    symbolLabels.set(symbolId, symbolDisplayLabel(node));
  }

  const declared = new Set<string>();
  const lines: string[] = ["flowchart LR"];
  for (const [id, meta] of fileNodeMeta) {
    if (declared.has(id)) continue;
    declared.add(id);
    lines.push(meta.external ? `${id}(["${mermaidLabel(meta.label)}"])` : `${id}["${mermaidLabel(meta.label)}"]`);
  }
  for (const [id, label] of symbolLabels) {
    if (declared.has(id)) continue;
    declared.add(id);
    lines.push(`${id}["${mermaidLabel(label)}"]`);
  }
  for (const edge of fg.edges) {
    const fromId = fileIdOf.get(edge.from)!;
    const targetKey = edge.to.type === "file" ? edge.to.path : edge.to.name;
    const toId = fileIdOf.get(targetKey)!;
    lines.push(`${fromId} --> ${toId}`);
  }
  for (const [symbolKey, symbolId] of symbolIdOf) {
    const node = sg.nodes.get(symbolKey)!;
    const fileId = fileIdOf.get(node.file);
    if (fileId) lines.push(`${fileId} --> ${symbolId}`);
  }
  for (const edge of sg.edges) {
    const fromId = symbolIdOf.get(edge.from)!;
    const toId = symbolIdOf.get(edge.to)!;
    if (edge.label) lines.push(`${fromId} -- "${mermaidLabel(edge.label)}" --> ${toId}`);
    else lines.push(`${fromId} --> ${toId}`);
  }
  return lines.join("\n");
}

export function graphToDOTSymbolsWithFiles(sg: SymbolGraphLike, fg: Graph, projectRoot?: string): string {
  const fileIdOf = new Map<string, string>();
  const fileNodeMeta = new Map<string, { label: string; external: boolean }>();
  let fileIndex = 0;
  const fileLabel = (file: string) => toProjectDisplayPath(projectRoot, file);
  const ensureFile = (file: string) => {
    if (!fileIdOf.has(file)) {
      const id = `f${fileIndex++}`;
      fileIdOf.set(file, id);
      fileNodeMeta.set(id, { label: fileLabel(file), external: false });
    }
  };
  const ensureExternal = (name: string) => {
    if (!fileIdOf.has(name)) {
      const id = `f${fileIndex++}`;
      fileIdOf.set(name, id);
      fileNodeMeta.set(id, { label: name, external: true });
    }
  };
  for (const file of fg.nodes) ensureFile(file);
  for (const edge of fg.edges) {
    ensureFile(edge.from);
    if (edge.to.type === "file") ensureFile(edge.to.path);
    else ensureExternal(edge.to.name);
  }

  const symbolIdOf = new Map<string, string>();
  const symbolLabels = new Map<string, string>();
  let symbolIndex = 0;
  for (const [id, node] of sg.nodes) {
    const symbolId = `s${symbolIndex++}`;
    symbolIdOf.set(id, symbolId);
    symbolLabels.set(symbolId, symbolDisplayLabel(node));
  }

  const lines: string[] = [];
  lines.push("digraph G {");
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, fontsize=10, fontname="Arial"];\n');
  for (const [id, meta] of fileNodeMeta) {
    lines.push(
      `  ${id} [label="${dotLabel(meta.label)}", ${meta.external ? "shape=ellipse, style=dashed" : "shape=box"}];`,
    );
  }
  for (const [id, label] of symbolLabels) {
    lines.push(`  ${id} [label="${dotLabel(label)}"];`);
  }
  for (const edge of fg.edges) {
    const fromId = fileIdOf.get(edge.from)!;
    const targetKey = edge.to.type === "file" ? edge.to.path : edge.to.name;
    const toId = fileIdOf.get(targetKey)!;
    lines.push(`  ${fromId} -> ${toId};`);
  }
  for (const [symbolKey, symbolId] of symbolIdOf) {
    const node = sg.nodes.get(symbolKey)!;
    const fileId = fileIdOf.get(node.file);
    if (fileId) lines.push(`  ${fileId} -> ${symbolId};`);
  }
  for (const edge of sg.edges) {
    const fromId = symbolIdOf.get(edge.from)!;
    const toId = symbolIdOf.get(edge.to)!;
    const attrs: string[] = [];
    if (edge.label) attrs.push(`label="${dotLabel(edge.label)}"`);
    lines.push(`  ${fromId} -> ${toId}${attrs.length ? " [" + attrs.join(",") + "]" : ""};`);
  }
  lines.push("}");
  return lines.join("\n");
}
