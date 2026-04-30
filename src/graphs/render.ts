import type { EdgeTo, Graph } from "../types.js";

function edgeTargetToString(target: EdgeTo): string {
  return target.type === "file" ? target.path : target.name;
}

function buildNodeIdMap(graph: Graph): {
  idOf: Map<string, string>;
  labels: Map<string, string>;
} {
  const idOf = new Map<string, string>();
  const labels = new Map<string, string>();
  let index = 0;
  const ensure = (label: string) => {
    if (!idOf.has(label)) {
      const id = `n${index++}`;
      idOf.set(label, id);
      labels.set(id, label);
    }
  };
  for (const file of graph.nodes) ensure(file);
  for (const edge of graph.edges) {
    ensure(edge.from);
    ensure(edgeTargetToString(edge.to));
  }
  return { idOf, labels };
}

export function dotLabel(label: string): string {
  return label.replace(/\\/g, "/").replace(/"/g, '\\"');
}

export function mermaidLabel(label: string): string {
  return label.replace(/\\/g, "/").replace(/"/g, "#quot;");
}

export function graphToDOT(graph: Graph): string {
  const { idOf } = buildNodeIdMap(graph);
  const lines: string[] = [];
  lines.push("digraph G {");
  lines.push("  rankdir=LR;");
  lines.push('  node [shape=box, fontsize=10, fontname="Arial"];\n');

  const declared = new Set<string>();
  const declare = (label: string, attrs: string) => {
    const id = idOf.get(label)!;
    if (declared.has(id)) return;
    declared.add(id);
    lines.push(`  ${id} [label="${dotLabel(label)}"${attrs ? ", " + attrs : ""}];`);
  };

  for (const file of graph.nodes) declare(file, "");
  for (const edge of graph.edges) {
    const target = edgeTargetToString(edge.to);
    if (edge.to.type === "external") declare(target, "shape=ellipse, style=dashed");
    else declare(target, "");
  }
  for (const edge of graph.edges) {
    const fromId = idOf.get(edge.from)!;
    const toId = idOf.get(edgeTargetToString(edge.to))!;
    const attrs: string[] = [];
    if (edge.typeOnly) attrs.push("style=dotted");
    lines.push(`  ${fromId} -> ${toId}${attrs.length ? " [" + attrs.join(",") + "]" : ""};`);
  }
  lines.push("}");
  return lines.join("\n");
}

export function graphToMermaid(graph: Graph): string {
  const { idOf } = buildNodeIdMap(graph);
  const declared = new Set<string>();
  const lines: string[] = ["flowchart LR"];
  const declare = (label: string, isExternal: boolean) => {
    const id = idOf.get(label)!;
    if (declared.has(id)) return;
    declared.add(id);
    lines.push(isExternal ? `${id}(["${mermaidLabel(label)}"])` : `${id}["${mermaidLabel(label)}"]`);
  };
  for (const file of graph.nodes) declare(file, false);
  for (const edge of graph.edges) declare(edgeTargetToString(edge.to), edge.to.type === "external");
  for (const edge of graph.edges) {
    const fromId = idOf.get(edge.from)!;
    const toId = idOf.get(edgeTargetToString(edge.to))!;
    lines.push(edge.typeOnly ? `${fromId} -.-> ${toId}` : `${fromId} --> ${toId}`);
  }
  return lines.join("\n");
}
