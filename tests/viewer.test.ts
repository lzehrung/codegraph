import fs from "node:fs";
import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as viewerModule from "../src/cli/viewer.js";
import { closeViewerServer, createViewerServer, startViewerServer } from "../src/cli/viewer.js";
import { buildAllowedHostHeaders } from "../src/mcp/http.js";
import { captureCli } from "./helpers/cli.js";

type HttpResult = {
  body: string;
  headers: http.IncomingHttpHeaders;
  statusCode: number | undefined;
};

const servers: http.Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => await closeViewerServer(server)));
  await Promise.all(
    directories.splice(0).map(async (directory) => await fsp.rm(directory, { force: true, recursive: true })),
  );
});

async function createViewerFixture(): Promise<{ graphPath: string; root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-viewer-"));
  directories.push(root);
  const graphPath = path.join(root, "graph.json");
  await fsp.writeFile(graphPath, '{"nodes":[],"edges":[]}\n', "utf8");
  return { graphPath, root };
}

async function request(
  server: http.Server,
  requestPath: string,
  method = "GET",
  host = "127.0.0.1",
): Promise<HttpResult> {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Viewer server did not expose a TCP address.");

  const { promise, reject, resolve } = Promise.withResolvers<HttpResult>();
  const client = http.request(
    {
      headers: { Host: `${host}:${address.port}` },
      host: "127.0.0.1",
      method,
      path: requestPath,
      port: address.port,
    },
    (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ body, headers: response.headers, statusCode: response.statusCode }));
    },
  );
  client.on("error", reject);
  client.end();
  return await promise;
}

describe("viewer server", () => {
  test("prints the deterministic graph URL without starting a server", async () => {
    const { root } = await createViewerFixture();

    const result = await captureCli(["viewer", "--graph", "graph.json", "--print-url"], { cwd: root });

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("http://127.0.0.1:4173/\n");
  });

  test("reports invalid viewer arguments on stderr with exit code 2", async () => {
    const { root } = await createViewerFixture();

    const result = await captureCli(["viewer", "--root", root, "--port", "70000", "--print-url"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Invalid --port");
  });

  test("appears in command-specific and global help", async () => {
    const [commandHelp, globalHelp] = await Promise.all([captureCli(["viewer", "--help"]), captureCli(["--help"])]);

    expect(commandHelp.stdout).toContain("codegraph viewer - Serve the bundled graph visualization viewer");
    expect(commandHelp.stdout).toContain("--print-url");
    expect(globalHelp.stdout).toContain("viewer");
    expect(globalHelp.stdout).toContain("Serve the bundled graph visualization viewer for people");
  });

  test("serves fixed assets and the selected graph, then closes cleanly", async () => {
    const { graphPath, root } = await createViewerFixture();
    const { server, url } = await startViewerServer({ graph: graphPath, port: 0, root });
    servers.push(server);

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const [index, app, graph, head, sigma, graphology, forceAtlas2] = await Promise.all([
      request(server, "/"),
      request(server, "/app.js"),
      request(server, "/graph.json"),
      request(server, "/styles.css", "HEAD"),
      request(server, "/vendor/sigma.js"),
      request(server, "/vendor/graphology.js"),
      request(server, "/vendor/graphology-layout-forceatlas2.js"),
    ]);

    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("Codegraph Project Viewer");
    expect(app.headers["content-type"]).toContain("text/javascript");
    expect(graph).toMatchObject({ body: '{"nodes":[],"edges":[]}\n', statusCode: 200 });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBeDefined();
    for (const asset of [sigma, graphology, forceAtlas2]) {
      expect(asset.statusCode).toBe(200);
      expect(asset.headers["content-type"]).toContain("text/javascript");
      expect(asset.body.length).toBeGreaterThan(0);
    }

    await closeViewerServer(server);
    expect(server.listening).toBe(false);
    servers.splice(servers.indexOf(server), 1);
  });

  test("serves graph data only at /graph.json and rejects unsafe requests", async () => {
    const { graphPath, root } = await createViewerFixture();
    const { server } = await startViewerServer({ graph: graphPath, port: 0, root });
    servers.push(server);

    const [otherPath, traversal, post, deniedHost] = await Promise.all([
      request(server, "/graph.json.bak"),
      request(server, "/%2e%2e%2fapp.js"),
      request(server, "/", "POST"),
      request(server, "/", "GET", "untrusted.example"),
    ]);

    expect(otherPath.statusCode).toBe(404);
    expect(traversal.statusCode).toBe(404);
    expect(post.statusCode).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    expect(deniedHost.statusCode).toBe(403);
  });

  test("builds and refreshes the current project graph without an exported JSON file", async () => {
    const { root } = await createViewerFixture();
    const sourceDirectory = path.join(root, "src");
    await fsp.mkdir(sourceDirectory);
    await fsp.writeFile(path.join(sourceDirectory, "alpha.ts"), "export const alpha = 1;\n", "utf8");
    const { server, url } = await startViewerServer({ port: 0, root });
    servers.push(server);

    expect(url).not.toContain("graph=");
    const first = await request(server, "/graph.json");
    expect(first.statusCode).toBe(200);
    const firstPayload = JSON.parse(first.body) as { files: string[] };
    expect(firstPayload.files).toContain("src/alpha.ts");

    await fsp.writeFile(path.join(sourceDirectory, "beta.ts"), "export const beta = 2;\n", "utf8");
    const [refreshed, obsoleteRoute] = await Promise.all([
      request(server, "/graph.json"),
      request(server, "/codegraph.json"),
    ]);
    expect(refreshed.statusCode).toBe(200);
    const refreshedPayload = JSON.parse(refreshed.body) as { files: string[] };
    expect(refreshedPayload.files).toContain("src/beta.ts");
    expect(obsoleteRoute.statusCode).toBe(404);
  });

  test("returns an actionable graph build error without taking down the viewer", async () => {
    const { root } = await createViewerFixture();
    const { server } = await startViewerServer({
      graphProvider: async () => {
        throw new Error("index unavailable");
      },
      port: 0,
      root,
    });
    servers.push(server);

    const graph = await request(server, "/graph.json");
    const index = await request(server, "/");
    expect(graph).toMatchObject({
      body: "Unable to build the current project graph: index unavailable",
      statusCode: 500,
    });
    expect(index.statusCode).toBe(200);
  });

  test("accepts portless Host headers for the default HTTP port", () => {
    const rules = buildAllowedHostHeaders("127.0.0.1", 80);

    expect(rules.exact.has("127.0.0.1")).toBe(true);
    expect(rules.exact.has("localhost")).toBe(true);
  });

  test("rejects a graph replaced between opening and identity validation", async () => {
    const { graphPath, root } = await createViewerFixture();
    const replacementPath = path.join(root, "replacement.json");
    const openedPath = path.join(root, "opened.json");
    await fsp.writeFile(replacementPath, '{"nodes":["replacement.ts"],"edges":[]}', "utf8");
    const realpathNative = fs.realpathSync.native;
    let replaced = false;
    const realpathSpy = vi.spyOn(fs.realpathSync, "native").mockImplementation((target) => {
      if (!replaced && path.resolve(String(target)) === graphPath) {
        replaced = true;
        fs.renameSync(graphPath, openedPath);
        fs.copyFileSync(replacementPath, graphPath);
      }
      return realpathNative(target);
    });

    try {
      expect(() => createViewerServer({ graph: graphPath, root })).toThrow(/changed during validation/i);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  test("warns when no disk cache is available for a current-project viewer", async () => {
    const { root } = await createViewerFixture();
    const stderr: string[] = [];
    const stdout: string[] = [];
    const server = http.createServer();
    const startSpy = vi.spyOn(viewerModule, "startViewerServer").mockResolvedValue({
      server,
      url: "http://127.0.0.1:4173/",
    });

    try {
      await viewerModule.handleViewerCommand({
        getOpt: (name) => (name === "--root" ? root : undefined),
        hasFlag: () => false,
        cwd: () => root,
        writeStderrLine: (line) => stderr.push(line),
        writeStdoutLine: (line) => stdout.push(line),
        exit: (code) => {
          throw new Error(`viewer exit ${code}`);
        },
      });

      expect(stdout).toEqual(["http://127.0.0.1:4173/"]);
      expect(stderr.some((line) => line.includes("No disk cache found under"))).toBe(true);
      expect(stderr.some((line) => line.includes("codegraph init --root"))).toBe(true);
    } finally {
      startSpy.mockRestore();
      await closeViewerServer(server);
    }
  });

  test("rejects graph paths outside the root", async () => {
    const { root } = await createViewerFixture();
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-viewer-outside-"));
    directories.push(outside);
    const graphPath = path.join(outside, "graph.json");
    await fsp.writeFile(graphPath, "{}", "utf8");

    expect(() => createViewerServer({ graph: graphPath, root })).toThrow(/outside project root/i);
  });

  test("rejects graph symlinks that escape the root when symlinks are supported", async () => {
    const { root } = await createViewerFixture();
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-viewer-outside-"));
    directories.push(outside);
    const outsideGraph = path.join(outside, "graph.json");
    const escapedGraph = path.join(root, "escaped.json");
    await fsp.writeFile(outsideGraph, "{}", "utf8");
    try {
      await fsp.symlink(outsideGraph, escapedGraph, "file");
    } catch {
      return;
    }

    expect(() => createViewerServer({ graph: escapedGraph, root })).toThrow(/outside project root/i);
  });
  test("returns 500 when statSync or fstatSync throws during GET and continues serving subsequent requests", async () => {
    const { root, graphPath } = await createViewerFixture();
    const server = await startViewerServer({ graph: graphPath, port: 0, root });
    servers.push(server.server);

    // 1. Test fstatSync throwing during GET /graph.json
    let throwFstat = true;
    const originalFstatSync = fs.fstatSync;
    const fstatSpy = vi.spyOn(fs, "fstatSync").mockImplementation((...args) => {
      if (throwFstat) {
        throw new Error("Simulated filesystem fstatSync error");
      }
      return originalFstatSync(...args);
    });

    try {
      const firstFstatResponse = await request(server.server, "/graph.json");
      expect(firstFstatResponse.statusCode).toBe(500);

      throwFstat = false;
      const secondFstatResponse = await request(server.server, "/graph.json");
      expect(secondFstatResponse.statusCode).toBe(200);
      expect(secondFstatResponse.body).toContain('"nodes":[]');
    } finally {
      fstatSpy.mockRestore();
    }

    // 2. Test statSync throwing during GET /
    let throwStat = true;
    const originalStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      if (throwStat) {
        throw new Error("Simulated filesystem statSync error");
      }
      return originalStatSync(...args);
    });

    try {
      const firstStatResponse = await request(server.server, "/");
      expect(firstStatResponse.statusCode).toBe(500);

      throwStat = false;
      const secondStatResponse = await request(server.server, "/");
      expect(secondStatResponse.statusCode).toBe(200);
    } finally {
      statSpy.mockRestore();
    }
  });
});
