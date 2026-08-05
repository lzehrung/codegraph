import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { awaitStdioMcpLifecycle } from "../src/mcp/stdioLifecycle.js";

function createFakeStdin(): Readable & EventEmitter {
  const stdin = new Readable({
    read() {
      // pull-based; tests push explicitly
    },
  });
  return stdin;
}

describe("awaitStdioMcpLifecycle", () => {
  it("closes on stdin EOF", async () => {
    const stdin = createFakeStdin();
    const close = vi.fn(async () => undefined);
    const pending = awaitStdioMcpLifecycle(
      { close },
      {
        stdin,
        connected: false,
        idleTimeoutMs: 0,
      },
    );
    stdin.push(null);
    await expect(pending).resolves.toBe("stdin_eof");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes on parent disconnect", async () => {
    const stdin = createFakeStdin();
    const listeners = new Set<() => void>();
    const close = vi.fn(async () => undefined);
    const pending = awaitStdioMcpLifecycle(
      { close },
      {
        stdin,
        connected: true,
        idleTimeoutMs: 0,
        onDisconnect: (listener) => listeners.add(listener),
        offDisconnect: (listener) => listeners.delete(listener),
      },
    );
    for (const listener of listeners) listener();
    await expect(pending).resolves.toBe("parent_disconnect");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes after the idle timeout when stdin is quiet", async () => {
    vi.useFakeTimers();
    const stdin = createFakeStdin();
    const close = vi.fn(async () => undefined);
    const pending = awaitStdioMcpLifecycle(
      { close },
      {
        stdin,
        connected: false,
        idleTimeoutMs: 1_000,
      },
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toBe("idle_timeout");
    expect(close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
