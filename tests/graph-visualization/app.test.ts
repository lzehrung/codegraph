// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const portablePayload = {
  format: "codegraph.graph-json",
  files: ["src/a.ts", "src/b.ts"],
  fileEdges: [{ from: "src/a.ts", to: { type: "file", path: "src/b.ts" } }],
  symbols: [
    { id: "src/a.ts:foo", file: "src/a.ts", name: "foo", kind: "function" },
    { id: "src/b.ts:bar", file: "src/b.ts", name: "bar", kind: "function" },
  ],
  symbolEdges: [{ from: "src/a.ts:foo", to: "src/b.ts:bar", label: "calls" }],
};

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
});

describe("packaged viewer graph loading", () => {
  it("auto-loads the fixed same-origin graph route and reuses it for the default control", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/?graph=%2Fgraph.json");

    await import("../../docs/graph-visualization/app.js");
    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toBe("Rendered 4 nodes and 4 edges."),
    );
    expect(fetchMock).toHaveBeenCalledWith("/graph.json");

    document.getElementById("load-default")?.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith("/graph.json");
  });

  it.each([
    "https%3A%2F%2Fexample.com%2Fgraph.json",
    "%2Fother.json",
    "%2Fgraph.json%3Fdownload%3D1",
    "%2Fgraph.json%23fragment",
  ])("rejects unsafe graph query %s", async (graph) => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", `/?graph=${graph}`);

    await import("../../docs/graph-visualization/app.js");
    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toBe("Ignoring an unsafe graph URL."),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains the conventional default control without a query graph", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    await import("../../docs/graph-visualization/app.js");

    document.getElementById("load-default")?.click();

    await vi.waitFor(() =>
      expect(document.getElementById("status")?.textContent).toBe("Rendered 4 nodes and 4 edges."),
    );
    expect(fetchMock).toHaveBeenCalledWith("../../codegraph.json");
  });

  it("retains manual file upload without a query graph", async () => {
    const fetchMock = successfulFetch();
    vi.stubGlobal("fetch", fetchMock);
    await import("../../docs/graph-visualization/app.js");
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
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
