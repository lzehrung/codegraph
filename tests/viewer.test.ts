import http from "node:http";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { closeViewerServer, createViewerServer, startViewerServer } from "../src/cli/viewer.js";
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
    expect(result.stdout).toBe("http://127.0.0.1:4173/?graph=%2Fgraph.json\n");
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

    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?graph=%2Fgraph\.json$/);
    const [index, app, graph, head] = await Promise.all([
      request(server, "/"),
      request(server, "/app.js"),
      request(server, "/graph.json"),
      request(server, "/styles.css", "HEAD"),
    ]);

    expect(index.statusCode).toBe(200);
    expect(index.body).toContain("Codegraph Sigma Viewer");
    expect(app.headers["content-type"]).toContain("text/javascript");
    expect(graph).toMatchObject({ body: '{"nodes":[],"edges":[]}\n', statusCode: 200 });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBeDefined();

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
});
