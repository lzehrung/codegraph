import Graph from "./vendor/graphology.js";
import forceAtlas2 from "./vendor/graphology-layout-forceatlas2.js";

export const FILE_NODE_COLOR = "#4da3ff";
export const EXTERNAL_NODE_COLOR = "#f59e0b";
export const SYMBOL_NODE_COLOR = "#6ee7b7";

const MAX_LABEL_LENGTH = 28;

export function shortLabel(pathOrName) {
  if (typeof pathOrName !== "string") return "";
  const s = pathOrName.replace(/^ext:/, "");
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  const basename = slash >= 0 ? s.slice(slash + 1) : s;
  if (basename.length <= MAX_LABEL_LENGTH) return basename;
  return basename.slice(0, MAX_LABEL_LENGTH - 1) + "\u2026";
}

export function normalizeToKey(target) {
  if (typeof target === "string") {
    return { key: target, type: "file" };
  }

  if (target && typeof target === "object" && target.type === "file" && typeof target.path === "string") {
    return { key: target.path, type: "file" };
  }

  if (target && typeof target === "object" && target.type === "external" && typeof target.name === "string") {
    return { key: `ext:${target.name}`, type: "external" };
  }

  return null;
}

export function edgeKey(from, to) {
  return `${from}->${to}`;
}

function addNodeIfMissing(graph, key, attributes) {
  if (!graph.hasNode(key)) {
    graph.addNode(key, attributes);
  }
}

function seedNodeCoordinates(graph) {
  const order = graph.order;
  if (order === 0) return;

  const radius = Math.max(10, order / 2);
  let index = 0;
  graph.forEachNode((node) => {
    const angle = (index / order) * Math.PI * 2;
    graph.setNodeAttribute(node, "x", Math.cos(angle) * radius);
    graph.setNodeAttribute(node, "y", Math.sin(angle) * radius);
    index += 1;
  });
}

function applyLayout(graph) {
  if (graph.order === 0) return;
  // Skip heavy layout in typical test environments to keep unit tests fast.
  if (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "test") {
    return;
  }
  // Allow overriding or disabling layout via a global configuration.
  let iterations = 500;
  if (typeof globalThis !== "undefined" && globalThis.GRAPH_LAYOUT_ITERATIONS != null) {
    const configured = Number(globalThis.GRAPH_LAYOUT_ITERATIONS);
    if (Number.isFinite(configured)) {
      iterations = configured;
    }
  }
  if (iterations <= 0) {
    // Non-positive iteration count disables layout.
    return;
  }
  seedNodeCoordinates(graph);

  forceAtlas2.assign(graph, {
    iterations,
    settings: {
      gravity: 0.8,
      scalingRatio: 25,
      strongGravityMode: false,
      barnesHutOptimize: true,
      slowDown: 1,
      linLogMode: true,
      outboundAttractionDistribution: true,
    },
  });
}

function compactIndex(value, indexes, upperBound) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value < upperBound) {
    return value;
  }
  if (typeof value === "string") return indexes.get(value);
  return undefined;
}

export function normalizeGraphPayload(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.files)) return payload;
  const sourceFileEdges = Array.isArray(payload.fileEdges) ? payload.fileEdges : [];
  const sourceSymbols = Array.isArray(payload.symbols) ? payload.symbols : [];
  const sourceSymbolEdges = Array.isArray(payload.symbolEdges) ? payload.symbolEdges : [];
  const portable =
    payload.format === "codegraph.graph-json" ||
    sourceFileEdges.some((edge) => typeof edge?.from === "string") ||
    sourceSymbols.some((symbol) => typeof symbol?.file === "string");
  if (!portable) return payload;

  const fileIndexes = new Map();
  payload.files.forEach((file, index) => {
    if (typeof file === "string") fileIndexes.set(file, index);
  });

  const fileEdges = [];
  for (const edge of sourceFileEdges) {
    if (!edge || typeof edge !== "object") continue;
    const from = compactIndex(edge.from, fileIndexes, payload.files.length);
    if (from === undefined || !edge.to || typeof edge.to !== "object") continue;
    if (edge.to.type === "file") {
      const target = compactIndex(edge.to.path, fileIndexes, payload.files.length);
      if (target !== undefined) fileEdges.push({ ...edge, from, to: { type: "file", path: target } });
      continue;
    }
    if (edge.to.type === "external" && typeof edge.to.name === "string") {
      fileEdges.push({ ...edge, from, to: { type: "external", name: edge.to.name } });
    }
  }

  const symbols = [];
  const symbolIdIndex = [];
  const symbolIndexes = new Map();
  for (let sourceIndex = 0; sourceIndex < sourceSymbols.length; sourceIndex += 1) {
    const symbol = sourceSymbols[sourceIndex];
    if (!symbol || typeof symbol !== "object") continue;
    const file = compactIndex(symbol.file, fileIndexes, payload.files.length);
    if (file === undefined) continue;
    const index = symbols.length;
    const id = typeof symbol.id === "string" ? symbol.id : (payload.symbolIdIndex?.[sourceIndex] ?? symbol.name);
    symbols.push({ ...symbol, file });
    symbolIdIndex.push(id);
    if (typeof id === "string") symbolIndexes.set(id, index);
  }

  const symbolEdges = [];
  for (const edge of sourceSymbolEdges) {
    if (!edge || typeof edge !== "object") continue;
    const from = compactIndex(edge.from, symbolIndexes, symbols.length);
    const to = compactIndex(edge.to, symbolIndexes, symbols.length);
    if (from !== undefined && to !== undefined) symbolEdges.push({ ...edge, from, to });
  }

  return { ...payload, fileEdges, symbols, symbolEdges, symbolIdIndex };
}

export function buildGraph(payload, options) {
  payload = normalizeGraphPayload(payload);
  const graph = new Graph({ multi: false, type: "directed" });

  if (Array.isArray(payload.nodes) && Array.isArray(payload.edges)) {
    for (const node of payload.nodes) {
      if (typeof node !== "string") continue;
      addNodeIfMissing(graph, node, {
        label: shortLabel(node),
        fullLabel: node,
        size: 6,
        color: FILE_NODE_COLOR,
        kind: "file",
      });
    }

    for (const edge of payload.edges) {
      if (!edge || typeof edge !== "object" || typeof edge.from !== "string") continue;
      const target = normalizeToKey(edge.to);
      if (!target) continue;
      const isExternalNode = target.type === "external";
      if (isExternalNode && !options.showExternal) continue;

      addNodeIfMissing(graph, edge.from, {
        label: shortLabel(edge.from),
        fullLabel: edge.from,
        size: 6,
        color: FILE_NODE_COLOR,
        kind: "file",
      });

      addNodeIfMissing(graph, target.key, {
        label: shortLabel(target.key),
        fullLabel: target.key,
        size: isExternalNode ? 4 : 6,
        color: isExternalNode ? EXTERNAL_NODE_COLOR : FILE_NODE_COLOR,
        kind: target.type,
      });

      const key = edgeKey(edge.from, target.key);
      if (!graph.hasEdge(key)) {
        graph.addDirectedEdgeWithKey(key, edge.from, target.key, {
          label: typeof edge.raw === "string" ? edge.raw : "",
        });
      }
    }
  } else if (Array.isArray(payload.files) && Array.isArray(payload.fileEdges)) {
    payload.files.forEach((file, index) => {
      if (typeof file !== "string") return;
      addNodeIfMissing(graph, `f:${index}`, {
        label: shortLabel(file),
        fullLabel: file,
        size: 6,
        color: FILE_NODE_COLOR,
        kind: "file",
      });
    });

    for (const fileEdge of payload.fileEdges) {
      if (!fileEdge || typeof fileEdge !== "object" || typeof fileEdge.from !== "number") continue;
      const fromKey = `f:${fileEdge.from}`;
      if (!graph.hasNode(fromKey)) continue;
      const to = fileEdge.to;
      if (!to || typeof to !== "object") continue;

      if (to.type === "file" && typeof to.path === "number") {
        const toKey = `f:${to.path}`;
        if (!graph.hasNode(toKey)) continue;
        const key = edgeKey(fromKey, toKey);
        if (!graph.hasEdge(key)) {
          graph.addDirectedEdgeWithKey(key, fromKey, toKey, {
            label: typeof fileEdge.raw === "string" ? fileEdge.raw : "",
          });
        }
      }

      if (to.type === "external" && typeof to.name === "string" && options.showExternal) {
        const externalKey = `ext:${to.name}`;
        addNodeIfMissing(graph, externalKey, {
          label: shortLabel(to.name),
          fullLabel: to.name,
          size: 4,
          color: EXTERNAL_NODE_COLOR,
          kind: "external",
        });
        const key = edgeKey(fromKey, externalKey);
        if (!graph.hasEdge(key)) {
          graph.addDirectedEdgeWithKey(key, fromKey, externalKey, {
            label: typeof fileEdge.raw === "string" ? fileEdge.raw : "",
          });
        }
      }
    }

    const hasSymbols = Array.isArray(payload.symbols) && Array.isArray(payload.symbolEdges);
    const symbolIdIndex = Array.isArray(payload.symbolIdIndex) ? payload.symbolIdIndex : null;

    if (options.includeSymbols && hasSymbols) {
      payload.symbols.forEach((symbol, index) => {
        if (!symbol || typeof symbol !== "object" || typeof symbol.file !== "number") return;
        const parentFileKey = `f:${symbol.file}`;
        if (!graph.hasNode(parentFileKey)) return;
        const symbolKey = `s:${index}`;
        const rawName = typeof symbol.name === "string" ? symbol.name : (symbolIdIndex?.[index] ?? symbolKey);
        const symbolLabel = shortLabel(rawName) || symbolKey;
        addNodeIfMissing(graph, symbolKey, {
          label: symbolLabel,
          fullLabel: rawName,
          size: 4,
          color: SYMBOL_NODE_COLOR,
          kind: "symbol",
        });
        const containsEdge = edgeKey(parentFileKey, symbolKey);
        if (!graph.hasEdge(containsEdge)) {
          graph.addDirectedEdgeWithKey(containsEdge, parentFileKey, symbolKey, { label: "contains" });
        }
      });

      payload.symbolEdges.forEach((symbolEdge) => {
        if (!symbolEdge || typeof symbolEdge !== "object") return;
        if (typeof symbolEdge.from !== "number" || typeof symbolEdge.to !== "number") return;
        const fromKey = `s:${symbolEdge.from}`;
        const toKey = `s:${symbolEdge.to}`;
        if (!graph.hasNode(fromKey) || !graph.hasNode(toKey)) return;
        const key = edgeKey(fromKey, toKey);
        if (!graph.hasEdge(key)) {
          graph.addDirectedEdgeWithKey(key, fromKey, toKey, {
            label: typeof symbolEdge.label === "string" ? symbolEdge.label : "uses",
          });
        }
      });
    }
  } else {
    throw new Error("Unsupported graph payload. Expected graph --json output.");
  }

  graph.forEachNode((node) => {
    const degree = graph.degree(node);
    const current = graph.getNodeAttribute(node, "size") ?? 6;
    const size = Math.min(12, Math.max(current, 3 + Math.log2(degree + 1)));
    graph.setNodeAttribute(node, "size", size);
  });

  applyLayout(graph);
  return graph;
}
