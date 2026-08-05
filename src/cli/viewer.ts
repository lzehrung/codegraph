import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { buildCodegraphGraphJson } from "../agent/artifact.js";
import { createAgentSession } from "../agent/session.js";
import type { AllowedHostHeaderRules } from "../mcp/http.js";
import path from "node:path";
import { getCodegraphPackageRoot } from "./packageInfo.js";
import {
  buildAllowedHostHeaders,
  closeHttpServer,
  formatHostForUrl,
  getHttpServerPort,
  isAllowedHostHeader,
  listenOnHttpServer,
} from "../mcp/http.js";
import { parseOptionalBoundedIntegerOption } from "./options.js";
import { assertFilePathWithinRoot, resolveFilePathFromRoot } from "../util/paths.js";
const DEFAULT_VIEWER_HOST = "127.0.0.1";
const DEFAULT_VIEWER_PORT = 4173;

const VIEWER_ASSETS: Record<string, { file: string; contentType: string }> = {
  "/": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", contentType: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", contentType: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", contentType: "text/css; charset=utf-8" },
  "/graph-builder.js": { file: "graph-builder.js", contentType: "text/javascript; charset=utf-8" },
  "/file-tree-model.js": { file: "file-tree-model.js", contentType: "text/javascript; charset=utf-8" },
  "/file-tree-filters.js": { file: "file-tree-filters.js", contentType: "text/javascript; charset=utf-8" },
  "/vendor/graphology.js": { file: "vendor/graphology.js", contentType: "text/javascript; charset=utf-8" },
  "/vendor/graphology-layout-forceatlas2.js": {
    file: "vendor/graphology-layout-forceatlas2.js",
    contentType: "text/javascript; charset=utf-8",
  },
  "/vendor/sigma.js": { file: "vendor/sigma.js", contentType: "text/javascript; charset=utf-8" },
};

const graphFileDescriptors = new WeakMap<http.Server, number>();

export type ViewerGraphProvider = () => Promise<string>;

export type ViewerServerOptions = {
  root: string;
  graph?: string | undefined;
  graphProvider?: ViewerGraphProvider | undefined;
  host?: string | undefined;
  port?: number | undefined;
};

export type ViewerCommandContext = {
  getOpt: (name: string) => string | undefined;
  hasFlag: (name: string) => boolean;
  cwd: () => string;
  writeStderrLine: (line: string) => void;
  writeStdoutLine: (line: string) => void;
  exit: (code: number) => void;
};

type OpenedGraphFile = {
  fileDescriptor: number;
  path: string;
};

type ResolvedViewerOptions = {
  assetRoot: string;
  graphFile: OpenedGraphFile | undefined;
  graphProvider: ViewerGraphProvider | undefined;
};

function openGraphFile(lexicalRoot: string, root: string, graph: string): OpenedGraphFile {
  const lexicalGraphPath = assertFilePathWithinRoot(lexicalRoot, graph, "Graph");
  const fileDescriptor = fs.openSync(lexicalGraphPath, "r");

  try {
    const openedStats = fs.fstatSync(fileDescriptor);
    if (!openedStats.isFile()) {
      throw new Error(`Graph must be a regular file: ${lexicalGraphPath}`);
    }
    const graphPath = assertFilePathWithinRoot(root, fs.realpathSync.native(lexicalGraphPath), "Graph");
    const resolvedStats = fs.statSync(graphPath);
    if (openedStats.dev !== resolvedStats.dev || openedStats.ino !== resolvedStats.ino) {
      throw new Error(`Graph changed during validation: ${lexicalGraphPath}`);
    }
    return { fileDescriptor, path: graphPath };
  } catch (error) {
    fs.closeSync(fileDescriptor);
    throw error;
  }
}

function closeResolvedGraphFile(options: ResolvedViewerOptions): void {
  if (options.graphFile) fs.closeSync(options.graphFile.fileDescriptor);
}

function resolveViewerOptions(options: ViewerServerOptions): ResolvedViewerOptions {
  const lexicalRoot = path.resolve(options.root);
  const root = fs.realpathSync.native(lexicalRoot);
  if (!fs.statSync(root).isDirectory()) {
    throw new Error(`Viewer root is not a directory: ${root}`);
  }

  const packageRoot = getCodegraphPackageRoot();
  const assetRoot = fs.realpathSync.native(path.join(packageRoot, "docs", "graph-visualization"));
  if (!fs.statSync(assetRoot).isDirectory()) {
    throw new Error(`Viewer assets directory is not a directory: ${assetRoot}`);
  }

  if (options.graph !== undefined && options.graphProvider) {
    throw new Error("Viewer options cannot combine a graph file with a graph provider.");
  }
  const graphFile = options.graph === undefined ? undefined : openGraphFile(lexicalRoot, root, options.graph);
  const graphProvider = graphFile ? undefined : (options.graphProvider ?? createProjectGraphProvider(root));
  return { assetRoot, graphFile, graphProvider };
}

function createProjectGraphProvider(root: string): ViewerGraphProvider {
  let inFlight: Promise<string> | undefined;
  return async () => {
    const graphPromise =
      inFlight ??
      createAgentSession({ root })
        .loadProject()
        .then((snapshot) => JSON.stringify(buildCodegraphGraphJson(snapshot)));
    inFlight = graphPromise;
    try {
      return await graphPromise;
    } finally {
      if (inFlight === graphPromise) inFlight = undefined;
    }
  };
}

function writeFileResponse(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  filePath: string,
  contentType: string,
  fileDescriptor?: number,
): void {
  const fileStats = fileDescriptor === undefined ? fs.statSync(filePath) : fs.fstatSync(fileDescriptor);
  response.writeHead(200, {
    "Content-Length": String(fileStats.size),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream =
    fileDescriptor === undefined
      ? fs.createReadStream(filePath)
      : fs.createReadStream(filePath, { autoClose: false, fd: fileDescriptor, start: 0 });
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(500);
    response.end();
  });
  stream.pipe(response);
}

async function writeGeneratedGraphResponse(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  graphProvider: ViewerGraphProvider,
): Promise<void> {
  try {
    const graphJson = await graphProvider();
    response.writeHead(200, {
      "Content-Length": String(Buffer.byteLength(graphJson)),
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : graphJson);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Unable to build the current project graph: ${detail}`;
    response.writeHead(500, {
      "Content-Length": String(Buffer.byteLength(message)),
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : message);
  }
}

function viewerRequestHandler(
  options: ResolvedViewerOptions,
  getAllowedHostHeaders: () => AllowedHostHeaderRules,
): http.RequestListener {
  return (request, response) => {
    if (!isAllowedHostHeader(request, getAllowedHostHeaders())) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }

    const rawPathname = (request.url ?? "/").split(/[?#]/, 1)[0] ?? "/";
    try {
      if (
        decodeURIComponent(rawPathname)
          .split("/")
          .some((segment) => segment === "..")
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
    } catch {
      response.writeHead(404);
      response.end();
      return;
    }

    const pathname = new URL(request.url ?? "/", "http://viewer.local").pathname;
    if (pathname === "/graph.json") {
      if (options.graphFile) {
        writeFileResponse(
          request,
          response,
          options.graphFile.path,
          "application/json; charset=utf-8",
          options.graphFile.fileDescriptor,
        );
        return;
      }
      if (options.graphProvider) {
        void writeGeneratedGraphResponse(request, response, options.graphProvider);
        return;
      }
    }

    const asset = VIEWER_ASSETS[pathname];
    if (!asset) {
      response.writeHead(404);
      response.end();
      return;
    }
    writeFileResponse(request, response, path.join(options.assetRoot, asset.file), asset.contentType);
  };
}

export function createViewerServer(options: ViewerServerOptions): http.Server {
  const resolvedOptions = resolveViewerOptions(options);
  const graphFileDescriptor = resolvedOptions.graphFile?.fileDescriptor;
  try {
    let allowedHostHeaders: AllowedHostHeaderRules | undefined;
    const host = options.host ?? DEFAULT_VIEWER_HOST;
    const server = http.createServer();
    const handler = viewerRequestHandler(resolvedOptions, () => {
      allowedHostHeaders ??= buildAllowedHostHeaders(host, getHttpServerPort(server.address()));
      return allowedHostHeaders;
    });
    server.on("request", handler);
    if (graphFileDescriptor !== undefined) {
      graphFileDescriptors.set(server, graphFileDescriptor);
      server.once("close", () => {
        const descriptor = graphFileDescriptors.get(server);
        if (descriptor === undefined) return;
        graphFileDescriptors.delete(server);
        fs.closeSync(descriptor);
      });
    }
    return server;
  } catch (error) {
    closeResolvedGraphFile(resolvedOptions);
    throw error;
  }
}

export async function startViewerServer(options: ViewerServerOptions): Promise<{ server: http.Server; url: string }> {
  const server = createViewerServer(options);
  const host = options.host ?? DEFAULT_VIEWER_HOST;
  const port = options.port ?? DEFAULT_VIEWER_PORT;
  try {
    await listenOnHttpServer(server, port, host);
  } catch (error) {
    await closeViewerServer(server);
    throw error;
  }
  const actualPort = getHttpServerPort(server.address());
  return { server, url: viewerUrl(host, actualPort) };
}

export async function closeViewerServer(server: http.Server): Promise<void> {
  await closeHttpServer(server);
  const graphFileDescriptor = graphFileDescriptors.get(server);
  if (graphFileDescriptor !== undefined) {
    graphFileDescriptors.delete(server);
    fs.closeSync(graphFileDescriptor);
  }
}

export function viewerUrl(host: string, port: number): string {
  return `http://${formatHostForUrl(host)}:${port}/`;
}

export function openViewerUrl(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => {});
  child.unref();
}

export async function handleViewerCommand(context: ViewerCommandContext): Promise<void> {
  let options: ViewerServerOptions | undefined;
  try {
    const port = parseOptionalBoundedIntegerOption(context.getOpt("--port"), "--port", 0, 65535) ?? DEFAULT_VIEWER_PORT;
    const host = context.getOpt("--host") ?? DEFAULT_VIEWER_HOST;
    if (!host.trim()) {
      throw new Error("Invalid --host value. Expected a non-empty host name or address.");
    }
    const preview = context.hasFlag("--print-url");
    if (preview && context.hasFlag("--open")) {
      throw new Error("--print-url cannot be used with --open.");
    }
    if (preview && port === 0) {
      throw new Error("--print-url cannot use --port 0.");
    }

    const graph = context.getOpt("--graph");
    options = {
      root: resolveFilePathFromRoot(context.cwd(), context.getOpt("--root") ?? "."),
      ...(graph !== undefined ? { graph } : {}),
      host,
      port,
    };
    const resolvedOptions = resolveViewerOptions(options);
    closeResolvedGraphFile(resolvedOptions);
    if (preview) {
      context.writeStdoutLine(viewerUrl(host, port));
      return;
    }
  } catch (error) {
    context.writeStderrLine(error instanceof Error ? error.message : String(error));
    context.exit(2);
    return;
  }

  if (!options) return;
  const { url } = await startViewerServer(options);
  context.writeStdoutLine(url);
  if (context.hasFlag("--open")) openViewerUrl(url);
}
