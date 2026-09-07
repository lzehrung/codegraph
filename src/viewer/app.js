import Sigma from "./vendor/sigma.js";
import {
  buildGraph,
  normalizeGraphPayload,
  shortLabel,
  FILE_NODE_COLOR,
  SYMBOL_NODE_COLOR,
  EXTERNAL_NODE_COLOR,
} from "./graph-builder.js";
import { buildFileTree, buildEdgeIndexes } from "./file-tree-model.js";
import { matchesFilter, subtreeMatchesFilter, highlightMatch, kindAbbrev } from "./file-tree-filters.js";

// ===== Constants =====

const DIM_COLOR = "#374151";
const HIGHLIGHT_COLOR = "#93c5fd";
const DEFAULT_GRAPH_PATH = "/graph.json";

// ===== DOM refs (with runtime assertions) =====

function requireElement(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required element #${id}`);
  return el;
}

const graphContainer = requireElement("graph-container");
const fileInput = requireElement("graph-file");
const statusEl = requireElement("status");
const showExternalInput = requireElement("show-external");
const includeSymbolsInput = requireElement("include-symbols");
const loadDefaultButton = requireElement("load-default");
const resetCameraButton = requireElement("reset-camera");

const treeContainer = requireElement("file-tree");
const treeSearchInput = requireElement("tree-search");
const detailPanel = requireElement("detail-panel");
const detailTitleEl = requireElement("detail-title");
const detailContentEl = requireElement("detail-content");
const detailCloseBtn = requireElement("detail-close");

// ===== Module state =====

let sigma = null;
let lastPayload = null;
let currentGraph = null;
let selectedNode = null;
let neighborSet = null;

// Tree state
let treeRoot = null;
let treePayload = null;
let edgeIndexes = null;
let itemsByKey = null;
let selectedTreeKey = null;
const treeRowElements = new Map();

// ===== Status =====

function setStatus(message) {
  statusEl.textContent = message;
}

// ===== Sigma lifecycle =====

function disposeSigma() {
  if (!sigma) return;
  sigma.kill();
  sigma = null;
}

/**
 * Custom hover renderer that always draws dark label text on a white background,
 * regardless of the node's labelColor attribute.  This keeps hover labels
 * readable on every node (default, selected, neighbor, or dimmed).
 */
function drawNodeHover(context, data, settings) {
  const size = settings.labelSize;
  const font = settings.labelFont;
  const weight = settings.labelWeight;
  context.font = `${weight} ${size}px ${font}`;

  const label = data.label;
  if (!label) return;

  const textWidth = context.measureText(label).width;
  const padding = 2;
  const boxWidth = Math.round(textWidth + 5);
  const boxHeight = Math.round(size + 2 * padding);
  const radius = Math.max(data.size, size / 2) + padding;

  const x = data.x;
  const y = data.y;

  // Node halo
  context.beginPath();
  context.fillStyle = data.color;
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.closePath();
  context.fill();

  // Label background
  context.fillStyle = "#ffffff";
  context.fillRect(x + radius + 1, y - boxHeight / 2, boxWidth, boxHeight);

  // Label text -- always dark for readability on white background
  context.fillStyle = "#111111";
  context.font = `${weight} ${size}px ${font}`;
  context.fillText(label, x + radius + 1 + padding, y + size / 3);
}

function renderGraph(payload) {
  const isNewPayload = payload !== lastPayload;
  lastPayload = payload;

  let graph;
  try {
    graph = buildGraph(payload, {
      showExternal: showExternalInput.checked,
      includeSymbols: includeSymbolsInput.checked,
    });
  } catch (err) {
    setStatus(`Failed to build graph: ${err instanceof Error ? err.message : err}`);
    return;
  }

  currentGraph = graph;
  selectedNode = null;
  neighborSet = null;

  disposeSigma();
  sigma = new Sigma(graph, graphContainer, {
    renderLabels: true,
    labelDensity: 0.6,
    labelRenderedSizeThreshold: 14,
    defaultEdgeColor: "#3d5a73",
    defaultNodeColor: FILE_NODE_COLOR,
    hideEdgesOnMove: true,
    hideLabelsOnMove: true,
    labelFont: "Inter, system-ui, sans-serif",
    labelSize: 12,
    labelColor: { attribute: "labelColor" },
    defaultDrawNodeHover: drawNodeHover,
    enableHovering: true,
    nodeReducer: (node, data) => {
      const result = { ...data };
      result.labelColor = "#e2e8f0";
      if (!selectedNode) return result;
      const isSelected = node === selectedNode;
      const isNeighbor = neighborSet?.has(node);
      if (isSelected) {
        result.color = HIGHLIGHT_COLOR;
        result.labelColor = "#111111";
        result.size = Math.min(14, (result.size ?? 6) * 1.4);
        result.forceLabel = true;
        result.highlighted = true;
      } else if (isNeighbor) {
        result.labelColor = "#e2e8f0";
        result.forceLabel = true;
      } else {
        result.color = DIM_COLOR;
      }
      return result;
    },
    edgeReducer: (edge, data) => {
      const result = { ...data };
      if (!selectedNode) return result;
      const [source, target] = graph.extremities(edge);
      const connected = source === selectedNode || target === selectedNode;
      if (!connected) result.hidden = true;
      else {
        result.color = "#6b9dc4";
      }
      return result;
    },
  });

  sigma.on("clickNode", ({ node }) => {
    selectedNode = selectedNode === node ? null : node;
    neighborSet = selectedNode ? new Set(graph.neighbors(selectedNode)) : null;
    sigma.refresh({ skipIndexation: true });
    if (selectedNode) {
      syncTreeFromGraph(selectedNode);
      setStatus(`Selected: ${selectedNodeLabel(selectedNode)}`);
    } else {
      clearTreeSync();
      setStatus(`Rendered ${graph.order} nodes and ${graph.size} edges.`);
    }
  });

  sigma.on("clickStage", () => {
    selectedNode = null;
    neighborSet = null;
    sigma.refresh({ skipIndexation: true });
    clearTreeSync();
    setStatus(`Rendered ${graph.order} nodes and ${graph.size} edges.`);
  });

  sigma.getCamera().animatedReset({ duration: 400 });
  setStatus(`Rendered ${graph.order} nodes and ${graph.size} edges.`);

  if (isNewPayload) {
    onPayloadLoaded(payload);
  }
}

// ===== Load / refresh =====

function refreshGraph() {
  if (lastPayload == null) {
    setStatus("Load a graph first, then use Refresh to re-apply options.");
    return;
  }
  renderGraph(lastPayload);
}

async function loadGraphFromText(text) {
  const parsed = JSON.parse(text);
  renderGraph(normalizeGraphPayload(parsed));
}

// ===== File Tree: Render =====

function renderTree(rootNode, filter) {
  treeRowElements.clear();
  treeContainer.innerHTML = "";

  if (!rootNode || !rootNode.children?.length) {
    treeContainer.innerHTML = '<p class="empty-state">Load a graph to see the file tree.</p>';
    return;
  }

  const ul = document.createElement("ul");
  ul.className = "tree-list";
  for (const child of rootNode.children) {
    renderTreeNode(child, ul, 0, filter);
  }
  treeContainer.appendChild(ul);
}

function renderTreeNode(node, parentUl, depth, filter) {
  if (filter && !subtreeMatchesFilter(node, filter)) return;

  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row";
  if (node.graphKey === selectedTreeKey) row.classList.add("selected");
  row.style.paddingLeft = `${8 + depth * 16}px`;
  if (node.graphKey) row.dataset.key = node.graphKey;

  if (node.type === "directory") {
    const isExpanded = filter ? true : node.expanded;

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle clickable";
    toggle.textContent = isExpanded ? "\u25BE" : "\u25B8";
    row.appendChild(toggle);

    const label = document.createElement("span");
    label.className = "tree-label";
    label.appendChild(highlightMatch(node.name, filter));
    row.appendChild(label);

    li.appendChild(row);

    const childUl = document.createElement("ul");
    childUl.className = `tree-list tree-children${isExpanded ? "" : " collapsed"}`;
    for (const child of node.children) {
      renderTreeNode(child, childUl, depth + 1, filter);
    }
    li.appendChild(childUl);

    row.addEventListener("click", (e) => {
      e.stopPropagation();
      node.expanded = !node.expanded;
      toggle.textContent = node.expanded ? "\u25BE" : "\u25B8";
      childUl.classList.toggle("collapsed", !node.expanded);
    });
  } else if (node.type === "file") {
    const hasSymbols = node.symbols.length > 0;
    const isExpanded = filter ? true : node.expanded;

    const toggle = document.createElement("span");
    toggle.className = hasSymbols ? "tree-toggle clickable" : "tree-toggle";
    toggle.textContent = hasSymbols ? (isExpanded ? "\u25BE" : "\u25B8") : "";
    row.appendChild(toggle);

    const label = document.createElement("span");
    label.className = "tree-label";
    label.appendChild(highlightMatch(node.name, filter));
    row.appendChild(label);

    if (hasSymbols) {
      const badge = document.createElement("span");
      badge.className = "tree-badge";
      badge.textContent = node.symbols.length;
      row.appendChild(badge);
    }

    const locateBtn = document.createElement("button");
    locateBtn.className = "tree-locate";
    locateBtn.title = "Select this node in the graph";
    locateBtn.setAttribute("aria-label", "Select this node in the graph");
    locateBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectAndPanToNode(node.graphKey);
    });
    row.appendChild(locateBtn);

    li.appendChild(row);

    if (hasSymbols) {
      const childUl = document.createElement("ul");
      childUl.className = `tree-list tree-children${isExpanded ? "" : " collapsed"}`;

      const symbolsToShow = filter ? node.symbols.filter((s) => matchesFilter(s.name, filter)) : node.symbols;

      for (const sym of symbolsToShow) {
        renderSymbolNode(sym, childUl, depth + 1, filter);
      }
      li.appendChild(childUl);

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        node.expanded = !node.expanded;
        toggle.textContent = node.expanded ? "\u25BE" : "\u25B8";
        childUl.classList.toggle("collapsed", !node.expanded);
        selectTreeItem(node);
      });
    } else {
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        selectTreeItem(node);
      });
    }

    treeRowElements.set(node.graphKey, row);
  }

  parentUl.appendChild(li);
}

function renderSymbolNode(sym, parentUl, depth, filter) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "tree-row";
  if (sym.graphKey === selectedTreeKey) row.classList.add("selected");
  row.style.paddingLeft = `${8 + depth * 16}px`;
  row.dataset.key = sym.graphKey;

  const spacer = document.createElement("span");
  spacer.className = "tree-toggle";
  row.appendChild(spacer);

  const badge = document.createElement("span");
  badge.className = `kind-badge kind-${sym.kind}`;
  badge.textContent = kindAbbrev(sym.kind);
  row.appendChild(badge);

  const label = document.createElement("span");
  label.className = "tree-label";
  label.appendChild(highlightMatch(sym.name, filter));
  row.appendChild(label);

  const locateBtn = document.createElement("button");
  locateBtn.className = "tree-locate";
  locateBtn.title = "Select this node in the graph";
  locateBtn.setAttribute("aria-label", "Select this node in the graph");
  locateBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    selectAndPanToNode(sym.graphKey);
  });
  row.appendChild(locateBtn);

  row.addEventListener("click", (e) => {
    e.stopPropagation();
    selectTreeItem(sym);
  });

  li.appendChild(row);
  parentUl.appendChild(li);
  treeRowElements.set(sym.graphKey, row);
}

// ===== File Tree: Selection & Detail =====

function selectTreeItem(item) {
  if (selectedTreeKey) {
    const prevRow = treeRowElements.get(selectedTreeKey);
    if (prevRow) prevRow.classList.remove("selected");
  }

  selectedTreeKey = item.graphKey;
  const row = treeRowElements.get(item.graphKey);
  if (row) row.classList.add("selected");

  showDetail(item);
}

function showDetail(item) {
  detailPanel.classList.remove("hidden");
  detailContentEl.innerHTML = "";

  if (item.type === "file") {
    detailTitleEl.textContent = item.name;
    showFileDetail(item);
  } else if (item.type === "symbol") {
    detailTitleEl.textContent = item.name;
    showSymbolDetail(item);
  }
}

function showFileDetail(fileItem) {
  const payload = treePayload;
  if (!payload) return;

  const content = detailContentEl;
  const isCompact = Array.isArray(payload.files);

  const meta = document.createElement("div");
  meta.className = "detail-meta";
  meta.textContent = `${fileItem.symbols.length} symbol${fileItem.symbols.length !== 1 ? "s" : ""}`;
  content.appendChild(meta);

  if (!isCompact || !edgeIndexes) return;

  const outgoing = edgeIndexes.fileEdgesByFrom.get(fileItem.fileIndex) || [];
  if (outgoing.length) {
    const section = document.createElement("div");
    section.className = "detail-section";
    const h4 = document.createElement("h4");
    h4.textContent = `Imports (${outgoing.length})`;
    section.appendChild(h4);

    const ul = document.createElement("ul");
    ul.className = "ref-list";
    for (const edge of outgoing) {
      const li = createFileRefItem(edge, payload);
      if (li) ul.appendChild(li);
    }
    section.appendChild(ul);
    content.appendChild(section);
  }

  const incoming = edgeIndexes.fileEdgesByTo.get(fileItem.fileIndex) || [];
  if (incoming.length) {
    const section = document.createElement("div");
    section.className = "detail-section";
    const h4 = document.createElement("h4");
    h4.textContent = `Imported by (${incoming.length})`;
    section.appendChild(h4);

    const ul = document.createElement("ul");
    ul.className = "ref-list";
    for (const edge of incoming) {
      const li = document.createElement("li");
      li.className = "ref-item";

      const fromFile = payload.files[edge.from];
      const link = document.createElement("span");
      link.className = "ref-link";
      link.textContent = shortLabel(fromFile || `file ${edge.from}`);
      link.title = fromFile || "";
      link.addEventListener("click", () => revealInTree(`f:${edge.from}`));
      li.appendChild(link);

      if (edge.raw) {
        const rawLabel = document.createElement("span");
        rawLabel.className = "ref-label";
        rawLabel.textContent = edge.raw;
        li.appendChild(rawLabel);
      }

      li.appendChild(createRefLocateBtn(`f:${edge.from}`));
      ul.appendChild(li);
    }
    section.appendChild(ul);
    content.appendChild(section);
  }
}

function createFileRefItem(edge, payload) {
  const to = edge.to;
  if (!to || typeof to !== "object") return null;

  const li = document.createElement("li");
  li.className = "ref-item";

  if (to.type === "file" && typeof to.path === "number") {
    const targetFile = payload.files[to.path];
    const link = document.createElement("span");
    link.className = "ref-link";
    link.textContent = shortLabel(targetFile || `file ${to.path}`);
    link.title = targetFile || "";
    link.addEventListener("click", () => revealInTree(`f:${to.path}`));
    li.appendChild(link);

    if (edge.raw) {
      const rawLabel = document.createElement("span");
      rawLabel.className = "ref-label";
      rawLabel.textContent = edge.raw;
      li.appendChild(rawLabel);
    }

    li.appendChild(createRefLocateBtn(`f:${to.path}`));
  } else if (to.type === "external" && typeof to.name === "string") {
    const label = document.createElement("span");
    label.className = "ref-link";
    label.style.color = EXTERNAL_NODE_COLOR;
    label.textContent = to.name;
    li.appendChild(label);

    const extBadge = document.createElement("span");
    extBadge.className = "ref-label";
    extBadge.textContent = "external";
    li.appendChild(extBadge);

    li.appendChild(createRefLocateBtn(`ext:${to.name}`));
  }

  return li;
}

function showSymbolDetail(symItem) {
  const payload = treePayload;
  if (!payload || !edgeIndexes) return;

  const content = detailContentEl;
  const idx = symItem.symbolIndex;

  const meta = document.createElement("div");
  meta.className = "detail-meta";
  const parentFile = symItem.parent;
  meta.textContent = `${symItem.kind}${parentFile ? ` in ${parentFile.name}` : ""}`;
  content.appendChild(meta);

  const outgoing = edgeIndexes.symbolEdgesByFrom.get(idx) || [];
  if (outgoing.length) {
    const section = document.createElement("div");
    section.className = "detail-section";
    const h4 = document.createElement("h4");
    h4.textContent = `References to (${outgoing.length})`;
    section.appendChild(h4);

    const ul = document.createElement("ul");
    ul.className = "ref-list";
    for (const edge of outgoing) {
      const targetSym = payload.symbols[edge.to];
      if (!targetSym) continue;

      const li = document.createElement("li");
      li.className = "ref-item";

      const edgeLabel = document.createElement("span");
      edgeLabel.className = "ref-label";
      edgeLabel.textContent = edge.label || "uses";
      li.appendChild(edgeLabel);

      const link = document.createElement("span");
      link.className = "ref-link";
      const targetName = targetSym.name || payload.symbolIdIndex?.[edge.to] || `symbol ${edge.to}`;
      link.textContent = targetName;
      link.title = payload.symbolIdIndex?.[edge.to] || targetName;
      link.addEventListener("click", () => revealInTree(`s:${edge.to}`));
      li.appendChild(link);

      const targetFile = payload.files?.[targetSym.file];
      if (targetFile) {
        const fileLabel = document.createElement("span");
        fileLabel.className = "ref-file";
        fileLabel.textContent = shortLabel(targetFile);
        li.appendChild(fileLabel);
      }

      li.appendChild(createRefLocateBtn(`s:${edge.to}`));
      ul.appendChild(li);
    }
    section.appendChild(ul);
    content.appendChild(section);
  }

  const incoming = edgeIndexes.symbolEdgesByTo.get(idx) || [];
  if (incoming.length) {
    const section = document.createElement("div");
    section.className = "detail-section";
    const h4 = document.createElement("h4");
    h4.textContent = `Referenced by (${incoming.length})`;
    section.appendChild(h4);

    const ul = document.createElement("ul");
    ul.className = "ref-list";
    for (const edge of incoming) {
      const sourceSym = payload.symbols[edge.from];
      if (!sourceSym) continue;

      const li = document.createElement("li");
      li.className = "ref-item";

      const edgeLabel = document.createElement("span");
      edgeLabel.className = "ref-label";
      edgeLabel.textContent = edge.label || "uses";
      li.appendChild(edgeLabel);

      const link = document.createElement("span");
      link.className = "ref-link";
      const sourceName = sourceSym.name || payload.symbolIdIndex?.[edge.from] || `symbol ${edge.from}`;
      link.textContent = sourceName;
      link.title = payload.symbolIdIndex?.[edge.from] || sourceName;
      link.addEventListener("click", () => revealInTree(`s:${edge.from}`));
      li.appendChild(link);

      const sourceFile = payload.files?.[sourceSym.file];
      if (sourceFile) {
        const fileLabel = document.createElement("span");
        fileLabel.className = "ref-file";
        fileLabel.textContent = shortLabel(sourceFile);
        li.appendChild(fileLabel);
      }

      li.appendChild(createRefLocateBtn(`s:${edge.from}`));
      ul.appendChild(li);
    }
    section.appendChild(ul);
    content.appendChild(section);
  }

  if (!outgoing.length && !incoming.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No references found for this symbol.";
    content.appendChild(empty);
  }
}

function createRefLocateBtn(graphKey) {
  const btn = document.createElement("button");
  btn.className = "ref-locate";
  btn.title = "Show in graph";
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    selectAndPanToNode(graphKey);
  });
  return btn;
}

function hideDetail() {
  detailPanel.classList.add("hidden");
  if (selectedTreeKey) {
    const prevRow = treeRowElements.get(selectedTreeKey);
    if (prevRow) prevRow.classList.remove("selected");
  }
  selectedTreeKey = null;
}

// ===== Graph integration =====

function selectedNodeLabel(graphKey) {
  const item = itemsByKey?.get(graphKey);
  if (item?.type === "file") {
    const parts = [];
    let current = item;
    while (current?.name) {
      parts.push(current.name);
      current = current.parent;
    }
    return parts.reverse().join("/");
  }
  return currentGraph?.getNodeAttribute(graphKey, "fullLabel") || currentGraph?.getNodeAttribute(graphKey, "label");
}

function selectAndPanToNode(graphKey) {
  if (!sigma || !currentGraph) {
    setStatus("Load a graph first.");
    return;
  }

  if (!currentGraph.hasNode(graphKey)) {
    if (graphKey.startsWith("s:")) {
      setStatus("Enable 'Include symbols' and click Refresh to see this node in the graph.");
    } else if (graphKey.startsWith("ext:")) {
      setStatus("Enable 'Show external package nodes' and click Refresh to see this node.");
    } else {
      setStatus("Node not found in current graph view.");
    }
    return;
  }

  selectedNode = graphKey;
  neighborSet = new Set(currentGraph.neighbors(graphKey));
  sigma.refresh({ skipIndexation: true });

  const nodeDisplayData = sigma.getNodeDisplayData(graphKey);
  if (nodeDisplayData) {
    sigma.getCamera().animate({ x: nodeDisplayData.x, y: nodeDisplayData.y, ratio: 0.15 }, { duration: 400 });
  }

  setStatus(`Selected: ${selectedNodeLabel(graphKey)}`);
}

function syncTreeFromGraph(graphKey) {
  clearTreeSync();

  const item = itemsByKey?.get(graphKey);
  if (!item) return;

  // Expand ancestors surgically without full re-render when possible
  let ancestor = item.parent;
  let needsRerender = false;
  while (ancestor) {
    if (!ancestor.expanded) {
      ancestor.expanded = true;
      needsRerender = true;
    }
    ancestor = ancestor.parent;
  }

  if (needsRerender) {
    renderTree(treeRoot, null);
    treeSearchInput.value = "";
  }

  const row = treeRowElements.get(graphKey);
  if (row) {
    row.classList.add("synced");
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function clearTreeSync() {
  document.querySelectorAll(".tree-row.synced").forEach((el) => el.classList.remove("synced"));
}

// ===== Tree navigation =====

function revealInTree(graphKey) {
  treeSearchInput.value = "";

  const item = itemsByKey?.get(graphKey);
  if (!item) return;

  let ancestor = item.parent;
  while (ancestor) {
    if (!ancestor.expanded) ancestor.expanded = true;
    ancestor = ancestor.parent;
  }

  renderTree(treeRoot, null);
  selectTreeItem(item);

  const row = treeRowElements.get(graphKey);
  if (row) {
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

// ===== Tree search =====

let searchTimeout = null;

treeSearchInput.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    const query = treeSearchInput.value.trim();
    renderTree(treeRoot, query || null);
  }, 200);
});

// ===== Tree init =====

function onPayloadLoaded(payload) {
  treePayload = payload;
  const result = buildFileTree(payload);
  treeRoot = result.root;
  itemsByKey = result.itemsByKey;
  edgeIndexes = buildEdgeIndexes(payload);
  selectedTreeKey = null;
  hideDetail();
  treeSearchInput.value = "";
  renderTree(treeRoot, null);
}

detailCloseBtn.addEventListener("click", hideDetail);

// ===== Event listeners =====

fileInput.addEventListener("change", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files?.[0];
  if (!file) return;
  const text = await file.text();

  try {
    await loadGraphFromText(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(`Failed to parse graph: ${message}`);
  }
});

showExternalInput.addEventListener("change", () => {
  setStatus("Toggle changed. Click Apply filters to re-apply.");
});

includeSymbolsInput.addEventListener("change", () => {
  setStatus("Toggle changed. Click Apply filters to re-apply.");
});

async function fetchGraph(graphPath) {
  const response = await fetch(graphPath);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text.trim() || `Request failed with status ${response.status}`);
  }
  await loadGraphFromText(text);
}

async function loadGraphPath(graphPath) {
  setStatus("Loading current project graph...");
  try {
    await fetchGraph(graphPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(`Could not load the project graph: ${message}. Run codegraph doctor, then retry.`);
  }
}

async function loadDefaultGraph() {
  await loadGraphPath(DEFAULT_GRAPH_PATH);
}

loadDefaultButton.addEventListener("click", () => {
  void loadDefaultGraph();
});

async function loadInitialGraph() {
  await loadDefaultGraph();
}

resetCameraButton.addEventListener("click", () => {
  sigma?.getCamera().animatedReset();
});

const refreshButton = document.getElementById("refresh");
if (refreshButton) {
  refreshButton.addEventListener("click", () => refreshGraph());
}

(function setupDragReleaseFix() {
  const container = graphContainer;
  container.addEventListener(
    "pointerdown",
    (e) => {
      const el = e.target instanceof Element ? e.target : container;
      if (container.contains(el) && typeof el.setPointerCapture === "function") {
        try {
          // setPointerCapture can fail if the pointer is already captured or
          // the element is not connected -- safe to ignore.
          el.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      const onRelease = (upEv) => {
        window.removeEventListener("pointerup", onRelease, true);
        window.removeEventListener("mouseup", onRelease, true);
        if (upEv.target instanceof Node && container.contains(upEv.target)) return;
        const canvas = container.querySelector("canvas");
        const target = canvas || container;
        const pointerId = typeof upEv.pointerId === "number" ? upEv.pointerId : 1;
        target.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: upEv.pointerType ?? "mouse",
            button: upEv.button,
            buttons: 0,
            clientX: upEv.clientX,
            clientY: upEv.clientY,
            relatedTarget: null,
          }),
        );
        target.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            cancelable: true,
            button: upEv.button,
            buttons: 0,
            clientX: upEv.clientX,
            clientY: upEv.clientY,
          }),
        );
      };
      window.addEventListener("pointerup", onRelease, true);
      window.addEventListener("mouseup", onRelease, true);
    },
    { capture: true },
  );
})();

void loadInitialGraph();
