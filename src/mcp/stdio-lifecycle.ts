import type { Readable } from "node:stream";

export const DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export type StdioServerCloseHandle = {
  close(): Promise<void>;
};

export type StdioLifecycleOptions = {
  stdin?: Readable;
  idleTimeoutMs?: number;
  connected?: boolean;
  onDisconnect?: (listener: () => void) => void;
  offDisconnect?: (listener: () => void) => void;
  setIdleTimer?: (callback: () => void, ms: number) => { clear(): void };
  now?: () => number;
  onShutdown?: (reason: "stdin_eof" | "parent_disconnect" | "idle_timeout") => void;
};

/**
 * Keeps a stdio MCP server alive until stdin EOF, parent disconnect, or idle timeout.
 * Returns when the server handle has been closed.
 */
export async function awaitStdioMcpLifecycle(
  handle: StdioServerCloseHandle,
  options: StdioLifecycleOptions = {},
): Promise<"stdin_eof" | "parent_disconnect" | "idle_timeout"> {
  const stdin = options.stdin ?? process.stdin;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS;
  const connected = options.connected ?? Boolean(process.connected);
  const now = options.now ?? Date.now;
  const setIdleTimer =
    options.setIdleTimer ??
    ((callback, ms) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return {
        clear: () => clearTimeout(timer),
      };
    });

  let settled = false;
  let idleTimer: { clear(): void } | undefined;

  const { promise, resolve } = Promise.withResolvers<"stdin_eof" | "parent_disconnect" | "idle_timeout">();

  const shutdown = async (nextReason: "stdin_eof" | "parent_disconnect" | "idle_timeout") => {
    if (settled) return;
    settled = true;
    idleTimer?.clear();
    stdin.off("end", onStdinEnd);
    stdin.off("close", onStdinClose);
    stdin.off("data", onStdinActivity);
    if (connected) {
      options.offDisconnect?.(onParentDisconnect);
      if (!options.offDisconnect) process.off("disconnect", onParentDisconnect);
    }
    options.onShutdown?.(nextReason);
    try {
      await handle.close();
    } catch {
      // Closing is best-effort; the lifecycle still completes.
    }
    resolve(nextReason);
  };

  const armIdleTimer = () => {
    idleTimer?.clear();
    if (!(idleTimeoutMs > 0)) return;
    const deadline = now() + idleTimeoutMs;
    const schedule = () => {
      const remaining = deadline - now();
      if (remaining <= 0) {
        void shutdown("idle_timeout");
        return;
      }
      idleTimer = setIdleTimer(schedule, remaining);
    };
    schedule();
  };

  const onStdinEnd = () => {
    void shutdown("stdin_eof");
  };
  const onStdinClose = () => {
    void shutdown("stdin_eof");
  };
  const onStdinActivity = () => {
    armIdleTimer();
  };
  const onParentDisconnect = () => {
    void shutdown("parent_disconnect");
  };

  stdin.on("end", onStdinEnd);
  stdin.on("close", onStdinClose);
  stdin.on("data", onStdinActivity);
  if (connected) {
    if (options.onDisconnect) options.onDisconnect(onParentDisconnect);
    else process.on("disconnect", onParentDisconnect);
  }
  armIdleTimer();

  return await promise;
}
