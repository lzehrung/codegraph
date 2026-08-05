// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const portablePayload = {
  format: "codegraph.graph-json",
  files: ["C:/repo/src/a.ts", "C:/repo/lib/b.ts"],
  fileEdges: [{ from: "C:/repo/src/a.ts", to: { type: "file", path: "C:/repo/lib/b.ts" } }],
  symbols: [
    { id: "C:/repo/src/a.ts:foo", file: "C:/repo/src/a.ts", name: "foo", kind: "function" },
    { id: "C:/repo/lib/b.ts:bar", file: "C:/repo/lib/b.ts", name: "bar", kind: "function" },
  ],
  symbolEdges: [{ from: "C:/repo/src/a.ts:foo", to: "C:/repo/lib/b.ts:bar", label: "calls" }],
};

const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

function mountViewer(): void {
  document.body.innerHTML = `
    <div id="graph-container"></div>
    <input id="graph-file" type="file">
    <div id="status"></div>
    <input id="show-external" type="checkbox">
    <input id="include-symbols" type="checkbox" checked>
    <button id="load-default"></button>
    <button id="reset-camera"></button>
    <button id="refresh"></button>
    <div id="file-tree"></div>
    <input id="tree-search" type="search">
    <section id="detail-panel"></section>
    <h2 id="detail-title"></h2>
    <div id="detail-content"></div>
    <button id="detail-close"></button>
  `;
}

function successfulFetch() {
  return vi.fn(async () => ({
    ok: true,
    text: async () => JSON.stringify(portablePayload),
  }));
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  mountViewer();
  window.history.replaceState({}, "", "/");
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollIntoViewDescriptor);
    return;
  }
  Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

describe("packaged viewer graph loading", () => {
  it("auto-loads the current project graph route and reuses it for the reload control", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await import("../../docs/graph-visualization/app.js");
    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toBe("Rendered 4 nodes and 4 edges."),
    );
    expect(fetchMock).toHaveBeenCalledWith("/graph.json");

    document.getElementById("load-default")?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/graph.json");
  });

  it("shows the server's actionable project graph error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => "Unable to build the current project graph: invalid config",
      })),
    );

    await import("../../docs/graph-visualization/app.js");

    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toBe(
        "Could not load the project graph: Unable to build the current project graph: invalid config. Run codegraph doctor, then retry.",
      ),
    );
  });

  it("forces labels for a selected node and its immediate neighbors", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);

    await import("../../docs/graph-visualization/app.js");
    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toBe("Rendered 4 nodes and 4 edges."),
    );

    const { sigmaInstances } = await import("./__mocks__/sigma.js");
    const instance = sigmaInstances.at(-1);
    if (!instance) throw new Error("Expected the viewer to create a Sigma instance.");
    instance.emit("clickNode", { node: "f:0" });
    expect(document.getElementById("status")?.textContent).toBe("Selected: src/a.ts");

    const reducer = instance.settings.nodeReducer;
    if (!reducer) throw new Error("Expected the viewer to configure a node reducer.");
    expect(reducer("f:0", { color: "#000000", label: "a.ts", size: 6 })).toMatchObject({
      forceLabel: true,
      highlighted: true,
    });
    expect(reducer("f:1", { color: "#000000", label: "b.ts", size: 6 })).toMatchObject({
      forceLabel: true,
      labelColor: "#e2e8f0",
    });
  });

  it("retains manual file upload after automatically loading the default graph", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    await import("../../docs/graph-visualization/app.js");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/graph.json"));

    const fileInput = document.getElementById("graph-file");
    if (!(fileInput instanceof HTMLInputElement)) throw new Error("Missing graph file input.");
    Object.defineProperty(fileInput, "files", {
      configurable: true,
      value: [{ text: async () => JSON.stringify(portablePayload) }],
    });

    fileInput.dispatchEvent(new Event("change"));

    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toBe("Rendered 4 nodes and 4 edges."),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
