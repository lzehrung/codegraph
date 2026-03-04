import Graph from "https://esm.sh/graphology@0.25.4";
import Sigma from "https://esm.sh/sigma@3.0.0-beta.33";
import forceAtlas2 from "https://esm.sh/graphology-layout-forceatlas2@0.10.1";

const graphContainer = document.getElementById("graph-container");
const fileInput = document.getElementById("graph-file");
const statusEl = document.getElementById("status");
const showExternalInput = document.getElementById("show-external");
const includeSymbolsInput = document.getElementById("include-symbols");
const loadDefaultButton = document.getElementById("load-default");
const resetCameraButton = document.getElementById("reset-camera");

let sigma = null;
let lastPayload = null;

const FILE_NODE_COLOR = "#4da3ff";
const EXTERNAL_NODE_COLOR = "#f59e0b";
const SYMBOL_NODE_COLOR = "#6ee7b7";
const DIM_COLOR = "#374151";
const HIGHLIGHT_COLOR = "#93c5fd";

const MAX_LABEL_LENGTH = 28;

function setStatus(message) {
  statusEl.textContent = message;
}

function shortLabel(pathOrName) {
  if (typeof pathOrName !== "string") return "";
  const s = pathOrName.replace(/^ext:/, "");
  const slash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  const basename = slash >= 0 ? s.slice(slash + 1) : s;
  if (basename.length <= MAX_LABEL_LENGTH) return basename;
  return basename.slice(0, MAX_LABEL_LENGTH - 1) + "…";
}

function normalizeToKey(target) {
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

function addNodeIfMissing(graph, key, attributes) {
  if (!graph.hasNode(key)) {
    graph.addNode(key, attributes);
  }
}

function seedNodeCoordinates(graph) {
  if (graph.order === 0) return;

  const radius = Math.max(10, graph.order / 2);
  let index = 0;
  graph.forEachNode((node) => {
    const angle = (index / graph.order) * Math.PI * 2;
    graph.setNodeAttribute(node, "x", Math.cos(angle) * radius);
    graph.setNodeAttribute(node, "y", Math.sin(angle) * radius);
    index += 1;
  });
}

function applyLayout(graph) {
  if (graph.order === 0) return;
  seedNodeCoordinates(graph);

  forceAtlas2.assign(graph, {
    iterations: 500,
    settings: {
      gravity: 0.8,
      scalingRatio: 25,
      strongGravityMode: false,
      barnesHutOptimize: true,
      slowDown: 1,
      linLogMode: true,
      outboundAttractionDistribution: true
    }
  });
}

function edgeKey(from, to) {
  return `${from}->${to}`;
}

function buildGraph(payload, options) {
  const graph = new Graph({ multi: false, type: "directed" });

  if (Array.isArray(payload.nodes) && Array.isArray(payload.edges)) {
    for (const node of payload.nodes) {
      if (typeof node !== "string") continue;
      addNodeIfMissing(graph, node, {
        label: shortLabel(node),
        fullLabel: node,
        size: 6,
        color: FILE_NODE_COLOR,
        kind: "file"
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
        kind: "file"
      });

      addNodeIfMissing(graph, target.key, {
        label: shortLabel(target.key),
        fullLabel: target.key,
        size: isExternalNode ? 4 : 6,
        color: isExternalNode ? EXTERNAL_NODE_COLOR : FILE_NODE_COLOR,
        kind: target.type
      });

      const key = edgeKey(edge.from, target.key);
      if (!graph.hasEdge(key)) {
        graph.addDirectedEdgeWithKey(key, edge.from, target.key, {
          label: typeof edge.raw === "string" ? edge.raw : ""
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
        kind: "file"
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
            label: typeof fileEdge.raw === "string" ? fileEdge.raw : ""
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
          kind: "external"
        });
        const key = edgeKey(fromKey, externalKey);
        if (!graph.hasEdge(key)) {
          graph.addDirectedEdgeWithKey(key, fromKey, externalKey, {
            label: typeof fileEdge.raw === "string" ? fileEdge.raw : ""
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
        const rawName =
          typeof symbol.name === "string"
            ? symbol.name
            : symbolIdIndex?.[index] ?? symbolKey;
        const symbolLabel = shortLabel(rawName) || rawName.slice(0, MAX_LABEL_LENGTH) || symbolKey;
        addNodeIfMissing(graph, symbolKey, {
          label: symbolLabel,
          fullLabel: rawName,
          size: 4,
          color: SYMBOL_NODE_COLOR,
          kind: "symbol"
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
            label: typeof symbolEdge.label === "string" ? symbolEdge.label : "uses"
          });
        }
      });
    }
  } else {
    throw new Error("Unsupported graph payload. Expected graph --json output or --compact-json output.");
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

function disposeSigma() {
  if (!sigma) return;
  sigma.kill();
  sigma = null;
}

function renderGraph(payload) {
  lastPayload = payload;
  const graph = buildGraph(payload, {
    showExternal: showExternalInput.checked,
    includeSymbols: includeSymbolsInput.checked
  });

  let selectedNode = null;
  let neighborSet = null;

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
    labelColor: { color: "#e2e8f0" },
    enableHovering: true,
    nodeReducer: (node, data) => {
      const result = { ...data };
      if (!selectedNode) return result;
      const isSelected = node === selectedNode;
      const isNeighbor = neighborSet?.has(node);
      if (isSelected) {
        result.color = HIGHLIGHT_COLOR;
        result.size = Math.min(14, (result.size ?? 6) * 1.4);
        result.highlighted = true;
      } else if (!isNeighbor) {
        result.color = DIM_COLOR;
        result.label = "";
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
    }
  });

  sigma.on("clickNode", ({ node }) => {
    selectedNode = selectedNode === node ? null : node;
    neighborSet = selectedNode ? new Set(graph.neighbors(selectedNode)) : null;
    sigma.refresh({ skipIndexation: true });
    if (selectedNode) {
      const label = graph.getNodeAttribute(selectedNode, "fullLabel") ?? graph.getNodeAttribute(selectedNode, "label");
      setStatus(`Selected: ${label}`);
    } else {
      setStatus(`Rendered ${graph.order} nodes and ${graph.size} edges.`);
    }
  });

  sigma.on("clickStage", () => {
    selectedNode = null;
    neighborSet = null;
    sigma.refresh({ skipIndexation: true });
    setStatus(`Rendered ${graph.order} nodes and ${graph.size} edges.`);
  });

  sigma.getCamera().animatedReset({ duration: 400 });
  setStatus(`Rendered ${graph.order} nodes and ${graph.size} edges.`);
}

function refreshGraph() {
  if (lastPayload == null) {
    setStatus("Load a graph first, then use Refresh to re-apply options.");
    return;
  }
  renderGraph(lastPayload);
}

async function loadGraphFromText(text) {
  const parsed = JSON.parse(text);
  renderGraph(parsed);
}

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
  setStatus("Toggle changed. Click Refresh to re-apply.");
});

includeSymbolsInput.addEventListener("change", () => {
  setStatus("Toggle changed. Click Refresh to re-apply.");
});

loadDefaultButton.addEventListener("click", async () => {
  try {
    const response = await fetch("../../codegraph.json");
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const text = await response.text();
    await loadGraphFromText(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    setStatus(`Failed to load ./codegraph.json: ${message}`);
  }
});

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
          el.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      const onRelease = (upEv) => {
        window.removeEventListener("pointerup", onRelease, true);
        window.removeEventListener("mouseup", onRelease, true);
        if (upEv.target && container.contains(upEv.target)) return;
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
            relatedTarget: null
          })
        );
        target.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            cancelable: true,
            button: upEv.button,
            buttons: 0,
            clientX: upEv.clientX,
            clientY: upEv.clientY
          })
        );
      };
      window.addEventListener("pointerup", onRelease, true);
      window.addEventListener("mouseup", onRelease, true);
    },
    { capture: true }
  );
})();
