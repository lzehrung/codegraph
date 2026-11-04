import type { Server as HttpServer, IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ensureSharedOwnerServer, retireIdleSharedOwner, type SharedOwnerConnection } from "../cli/server.js";
import { getCodegraphPackageIdentity } from "../util/package-info.js";
import { isPlainRecord } from "../util/guards.js";
import { getSharedOwnerIdentity, resolveSharedOwnerOptions, type SharedOwnerOptions } from "./owner-identity.js";
import { readMcpLifecycleHealthToken } from "./lifecycle-health.js";

export type { SharedOwnerOptions } from "./owner-identity.js";
export type { SharedOwnerConnection } from "../cli/server.js";

const SHARED_OWNER_IDLE_MS = 30 * 60 * 1000;

export async function ensureSharedOwner(options: SharedOwnerOptions): Promise<SharedOwnerConnection> {
  const resolved = await resolveSharedOwnerOptions(options);
  // Both the npm package and the standalone archive ship the whole compiled dist tree.
  // Never derive this path from the host application's process.argv or bundled import.meta.url.
  const entryPath = path.join(getCodegraphPackageIdentity().packageRoot, "dist", "mcp", "shared-owner.js");
  return await ensureSharedOwnerServer(resolved, () => getSharedOwnerIdentity(resolved), entryPath);
}

/** The idle check is repeated under the lifecycle lease before the listening socket closes. */
export function installSharedOwnerIdleTimeout(
  server: HttpServer,
  retire: (isIdle: () => boolean) => Promise<boolean>,
  timeoutMs = SHARED_OWNER_IDLE_MS,
): () => void {
  let activeRequests = 0;
  let lastActivityAt = Date.now();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const isIdle = (): boolean => !activeRequests && Date.now() - lastActivityAt >= timeoutMs;
  const schedule = (retryDelayMs = 0): void => {
    if (stopped) return;
    clearTimeout(timer);
    const remaining = Math.max(1, retryDelayMs, timeoutMs - (Date.now() - lastActivityAt));
    timer = setTimeout(() => void checkIdle(), activeRequests ? timeoutMs : remaining);
    timer.unref();
  };
  const checkIdle = async (): Promise<void> => {
    if (stopped) return;
    if (!isIdle()) {
      schedule();
      return;
    }
    try {
      if (await retire(isIdle)) {
        dispose();
        return;
      }
    } catch (error) {
      console.error(
        `[codegraph] Shared MCP owner idle shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      schedule(1_000);
      return;
    }
    schedule();
  };
  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    lastActivityAt = Date.now();
    // An open event stream is not an in-flight tool. POST requests cover active calls;
    // close() also drains operations whose client disconnected while they were running.
    const tracked = request.method !== "GET" && request.url?.split("?", 1)[0] === "/mcp";
    if (tracked) {
      activeRequests += 1;
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        activeRequests -= 1;
        lastActivityAt = Date.now();
        schedule();
      };
      response.once("finish", finish);
      response.once("close", finish);
    }
    schedule();
  };
  const dispose = (): void => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    server.off("request", onRequest);
    server.off("close", dispose);
  };
  server.on("request", onRequest);
  server.once("close", dispose);
  schedule();
  return dispose;
}

function runSharedOwnerProcess(): void {
  if (!process.send || !readMcpLifecycleHealthToken()) {
    throw new Error("Shared Codegraph owner requires a private startup channel and lifecycle credential.");
  }
  let registered = false;
  let started = false;
  let closeOwner: (() => Promise<void>) | undefined;
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (process.connected) process.disconnect();
    void (closeOwner?.() ?? Promise.resolve()).catch((error: unknown) => {
      console.error(
        `[codegraph] Shared MCP owner shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
  };
  process.once("disconnect", () => {
    if (!registered) shutdown();
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.on("message", (message: unknown) => {
    if (!isPlainRecord(message)) return;
    if (message.kind === "registered" && started && closeOwner) {
      registered = true;
      process.send?.({ kind: "registered" });
      return;
    }
    if (
      message.kind !== "start" ||
      started ||
      !isPlainRecord(message.options) ||
      typeof message.identity !== "string"
    ) {
      return;
    }
    const rawOptions = message.options;
    const identity = message.identity;
    started = true;
    void (async () => {
      try {
        if (typeof rawOptions.root !== "string") throw new Error("Shared owner root is missing.");
        const options = await resolveSharedOwnerOptions({ ...rawOptions, root: rawOptions.root });
        if ((await getSharedOwnerIdentity(options)) !== identity) {
          throw new Error("Shared Codegraph owner runtime or configuration changed during startup.");
        }
        if (shuttingDown) return;
        // The HTTP/session/index graph belongs only to the owner process, not the stdio bridge.
        const { startCodegraphMcpHttpServer } = await import("./http-transport.js");
        const server = await startCodegraphMcpHttpServer({
          ...options,
          // The registry authenticates these merged startup options, not later configuration edits.
          useConfig: false,
          host: "127.0.0.1",
          port: 0,
          sharedOwnerIdentity: identity,
        });
        closeOwner = server.close;
        if (shuttingDown) {
          await server.close();
          return;
        }
        installSharedOwnerIdleTimeout(server.server, async (isIdle) =>
          retireIdleSharedOwner(options.root, identity, isIdle, server.close),
        );
        process.send?.({ kind: "ready", url: server.url });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
        if (process.connected && process.send) process.send({ kind: "error", message: detail }, shutdown);
        else shutdown();
      }
    })();
  });
}

if (process.argv[2] === "--codegraph-shared-owner" && process.send) {
  try {
    runSharedOwnerProcess();
  } catch (error: unknown) {
    console.error(
      `[codegraph] Shared MCP owner startup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
