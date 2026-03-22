/**
 * Pure data-structure functions for building and querying the file tree.
 * No DOM dependency -- safe to import from tests or workers.
 */

export function findCommonPrefix(paths) {
  if (!paths.length) return "";
  const normalized = paths.map((p) => p.replace(/\\/g, "/"));
  const first = normalized[0];
  let prefixEnd = 0;
  for (let i = 0; i < first.length; i++) {
    if (normalized.every((p) => p[i] === first[i])) {
      if (first[i] === "/") prefixEnd = i + 1;
    } else {
      break;
    }
  }
  return first.slice(0, prefixEnd);
}

/**
 * Build a hierarchical tree from a codegraph payload.
 *
 * Returns `{ root, itemsByKey }` where `itemsByKey` is a Map<string, TreeItem>
 * for O(1) lookups by graphKey.
 */
export function buildFileTree(payload) {
  const files = payload.files || payload.nodes || [];
  const isCompact = Array.isArray(payload.files);
  const stringFiles = files.filter((f) => typeof f === "string");
  const prefix = findCommonPrefix(stringFiles);

  const root = { name: "", type: "directory", children: [], expanded: true, parent: null };
  const itemsByKey = new Map();

  const symbolsByFile = new Map();
  if (isCompact && Array.isArray(payload.symbols)) {
    payload.symbols.forEach((s, idx) => {
      if (!s) return;
      let list = symbolsByFile.get(s.file);
      if (!list) {
        list = [];
        symbolsByFile.set(s.file, list);
      }
      list.push({
        name: s.name || payload.symbolIdIndex?.[idx] || `symbol_${idx}`,
        type: "symbol",
        kind: s.kind || "variable",
        symbolIndex: idx,
        graphKey: `s:${idx}`,
        fullId: payload.symbolIdIndex?.[idx] || s.name,
        parent: null,
      });
    });
  }

  for (let i = 0; i < files.length; i++) {
    const filePath = files[i];
    if (typeof filePath !== "string") continue;

    const relative = filePath.replace(/\\/g, "/").slice(prefix.length);
    const parts = relative.split("/").filter(Boolean);
    let current = root;

    for (let j = 0; j < parts.length - 1; j++) {
      let dir = current.children.find((c) => c.type === "directory" && c.name === parts[j]);
      if (!dir) {
        dir = {
          name: parts[j],
          type: "directory",
          children: [],
          expanded: false,
          parent: current,
        };
        current.children.push(dir);
      }
      current = dir;
    }

    const fileName = parts[parts.length - 1] || filePath;
    const graphKey = isCompact ? `f:${i}` : filePath;

    const symbols = symbolsByFile.get(i) || [];

    const fileNode = {
      name: fileName,
      type: "file",
      fileIndex: i,
      graphKey,
      fullPath: filePath,
      symbols,
      expanded: false,
      parent: current,
    };

    symbols.forEach((s) => {
      s.parent = fileNode;
      itemsByKey.set(s.graphKey, s);
    });
    current.children.push(fileNode);
    itemsByKey.set(graphKey, fileNode);
  }

  sortTree(root);
  autoExpandSingleChildren(root);
  return { root, itemsByKey };
}

export function sortTree(node) {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (a.type !== "directory" && b.type === "directory") return 1;
    return a.name.localeCompare(b.name);
  });
  node.children.forEach(sortTree);
}

export function autoExpandSingleChildren(node) {
  if (node.type !== "directory") return;
  const dirChildren = node.children.filter((c) => c.type === "directory");
  if (node.children.length === 1 && dirChildren.length === 1) {
    node.expanded = true;
    autoExpandSingleChildren(node.children[0]);
  }
}

/**
 * Build index maps for O(1) edge lookups by source or target index.
 *
 * Returns `{ fileEdgesByFrom, fileEdgesByTo, symbolEdgesByFrom, symbolEdgesByTo }`
 * where each value is a `Map<number, Edge[]>`.
 */
export function buildEdgeIndexes(payload) {
  const fileEdgesByFrom = new Map();
  const fileEdgesByTo = new Map();
  const symbolEdgesByFrom = new Map();
  const symbolEdgesByTo = new Map();

  if (Array.isArray(payload.fileEdges)) {
    for (const edge of payload.fileEdges) {
      if (!edge || typeof edge !== "object") continue;
      if (typeof edge.from === "number") {
        let list = fileEdgesByFrom.get(edge.from);
        if (!list) { list = []; fileEdgesByFrom.set(edge.from, list); }
        list.push(edge);
      }
      const to = edge.to;
      if (to && typeof to === "object" && to.type === "file" && typeof to.path === "number") {
        let list = fileEdgesByTo.get(to.path);
        if (!list) { list = []; fileEdgesByTo.set(to.path, list); }
        list.push(edge);
      }
    }
  }

  if (Array.isArray(payload.symbolEdges)) {
    for (const edge of payload.symbolEdges) {
      if (!edge || typeof edge !== "object") continue;
      if (typeof edge.from === "number") {
        let list = symbolEdgesByFrom.get(edge.from);
        if (!list) { list = []; symbolEdgesByFrom.set(edge.from, list); }
        list.push(edge);
      }
      if (typeof edge.to === "number") {
        let list = symbolEdgesByTo.get(edge.to);
        if (!list) { list = []; symbolEdgesByTo.set(edge.to, list); }
        list.push(edge);
      }
    }
  }

  return { fileEdgesByFrom, fileEdgesByTo, symbolEdgesByFrom, symbolEdgesByTo };
}
