import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { isInitializeRequest, Server } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { errorMessage } from "../util/errors.js";
import { getHeaderValue, writeJsonRpcError } from "./http.js";

type LegacyMcpSession = {
  server: Server;
  transport: NodeStreamableHTTPServerTransport;
  lastActivityAt: number;
  inFlightRequests: number;
  openSseStreams: number;
};

const legacyRequestAbortStorage = new AsyncLocalStorage<AbortSignal>();

export function getLegacyRequestAbortSignal(): AbortSignal | undefined {
  return legacyRequestAbortStorage.getStore();
}
export async function handleLegacyMcpHttpPost(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  sessionStore: LegacyMcpSessionStore,
  createProtocolServer: () => Server,
): Promise<void> {
  const sessionId = getHeaderValue(request.headers["mcp-session-id"]);
  if (sessionId !== undefined) {
    const session = sessionStore.get(sessionId);
    if (!session) {
      writeJsonRpcError(response, 400, "Bad Request: No valid session ID provided");
      return;
    }
    sessionStore.touch(sessionId);
    await handleLegacyMcpSessionRequest(session, request, response, body);
    return;
  }

  if (!isInitializeRequest(body)) {
    writeJsonRpcError(response, 400, "Bad Request: No valid session ID provided");
    return;
  }

  const hasCapacity = await sessionStore.ensureCapacityForNewSession();
  if (!hasCapacity) {
    writeJsonRpcError(
      response,
      503,
      "MCP session capacity reached: all configured sessions are active; close an existing session and retry.",
    );
    return;
  }
  let capacityReservationHeld = true;
  const releaseCapacityReservation = (): void => {
    if (!capacityReservationHeld) return;
    capacityReservationHeld = false;
    sessionStore.releaseCapacityReservation();
  };
  const protocolServer = createProtocolServer();
  let initializedSessionId: string | undefined;
  // The transport callbacks close over the session, but the session needs the
  // transport, so the binding is resolved through a ref rather than a mutable let.
  const sessionRef: { current: LegacyMcpSession | undefined } = { current: undefined };
  const transport = new NodeStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      initializedSessionId = newSessionId;
      const initialized = sessionRef.current;
      if (initialized === undefined) {
        throw new Error("MCP session state was not initialized before the transport session.");
      }
      sessionStore.set(newSessionId, initialized);
      releaseCapacityReservation();
    },
    onsessionclosed: (closedSessionId) => {
      void sessionStore.delete(closedSessionId);
    },
  });
  const session: LegacyMcpSession = {
    server: protocolServer,
    transport,
    lastActivityAt: Date.now(),
    inFlightRequests: 0,
    openSseStreams: 0,
  };
  sessionRef.current = session;
  // The SDK transport reports every per-request validation rejection through onerror
  // too (bad Accept header, wrong Content-Type, malformed JSON, an unsupported
  // protocol version, ...) - each of those already answered its own request with a
  // 4xx response and left the transport fully usable. Deleting the session here would
  // tear down an otherwise healthy session over one malformed follow-up request. Only
  // onclose reflects the transport actually shutting down (an explicit DELETE, an
  // eviction we triggered, or a real fatal failure), so session teardown is driven by
  // onclose alone; onerror only logs.
  transport.onerror = (error) => {
    console.error(`[codegraph] MCP HTTP session transport error: ${error.message}`);
  };
  transport.onclose = () => {
    if (initializedSessionId !== undefined) void sessionStore.delete(initializedSessionId);
  };

  try {
    await protocolServer.connect(transport);
    await handleLegacyMcpSessionRequest(session, request, response, body);
    if (initializedSessionId === undefined) {
      // The transport answered a pre-session 4xx (invalid Accept header, wrong
      // Content-Type, malformed JSON, ...) without throwing and without ever reaching
      // onsessioninitialized, so nothing else releases this capacity reservation or
      // closes this ad hoc protocol server/transport pair.
      releaseCapacityReservation();
      await closeMcpSession(session);
    }
  } catch (error) {
    if (initializedSessionId !== undefined) {
      await sessionStore.delete(initializedSessionId);
    } else {
      await closeMcpSession(session);
    }
    releaseCapacityReservation();
    throw error;
  }
}

export async function handleExistingMcpSessionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  sessionStore: LegacyMcpSessionStore,
): Promise<void> {
  const sessionId = getHeaderValue(request.headers["mcp-session-id"]);
  if (sessionId === undefined) {
    writeJsonRpcError(response, 400, "Invalid or missing session ID");
    return;
  }
  const session = sessionStore.get(sessionId);
  if (!session) {
    writeJsonRpcError(response, 400, "Invalid or missing session ID");
    return;
  }
  sessionStore.touch(sessionId);
  await handleLegacyMcpSessionRequest(session, request, response);
}

/**
 * Runs one legacy HTTP request with a signal that aborts when its connection closes.
 * The signal is scoped to this request and is available to nested MCP tool dispatch.
 */
export async function runWithLegacyRequestAbortSignal<T>(
  request: IncomingMessage,
  response: ServerResponse,
  operation: () => Promise<T>,
): Promise<T> {
  const abortController = new AbortController();
  let completed = false;
  const abortDisconnectedRequest = (): void => {
    if (completed) return;
    if (request.aborted || (!response.writableFinished && response.destroyed)) {
      abortController.abort(new Error("MCP HTTP request connection closed."));
    }
  };
  request.on("aborted", abortDisconnectedRequest);
  request.on("close", abortDisconnectedRequest);
  response.on("close", abortDisconnectedRequest);
  try {
    return await legacyRequestAbortStorage.run(abortController.signal, operation);
  } finally {
    completed = true;
    request.off("aborted", abortDisconnectedRequest);
    request.off("close", abortDisconnectedRequest);
    response.off("close", abortDisconnectedRequest);
  }
}

async function handleLegacyMcpSessionRequest(
  session: LegacyMcpSession,
  request: IncomingMessage,
  response: ServerResponse,
  body?: unknown,
): Promise<void> {
  const tracksSseStream = isLegacySseRequest(request);
  session.inFlightRequests += 1;
  if (tracksSseStream) session.openSseStreams += 1;
  try {
    await runWithLegacyRequestAbortSignal(request, response, async () => {
      await session.transport.handleRequest(request, response, body);
    });
  } finally {
    session.inFlightRequests -= 1;
    if (tracksSseStream) session.openSseStreams -= 1;
    session.lastActivityAt = Date.now();
  }
}

function isLegacySseRequest(request: IncomingMessage): boolean {
  if (request.method !== "GET") return false;
  return getHeaderValue(request.headers.accept)?.includes("text/event-stream") ?? false;
}

type LegacyMcpSessionStoreOptions = {
  idleMs: number;
  maxCount: number;
  evictionIntervalMs: number;
};

export type LegacyMcpSessionStore = {
  sessions: Map<string, LegacyMcpSession>;
  get(sessionId: string): LegacyMcpSession | undefined;
  set(sessionId: string, session: LegacyMcpSession): void;
  touch(sessionId: string): void;
  delete(sessionId: string): Promise<void>;
  ensureCapacityForNewSession(): Promise<boolean>;
  releaseCapacityReservation(): void;
  stop(): void;
};

export function createLegacyMcpSessionStore(options: LegacyMcpSessionStoreOptions): LegacyMcpSessionStore {
  const sessions = new Map<string, LegacyMcpSession>();
  let stopped = false;
  let evictionTimer: ReturnType<typeof setInterval> | undefined;
  let pendingInitializations = 0;

  const store: LegacyMcpSessionStore = {
    sessions,
    get(sessionId) {
      return sessions.get(sessionId);
    },
    set(sessionId, session) {
      sessions.set(sessionId, session);
    },
    touch(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.lastActivityAt = Date.now();
    },
    async delete(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) return;
      sessions.delete(sessionId);
      await closeMcpSession(session);
    },
    async ensureCapacityForNewSession() {
      await evictIdleLegacyMcpSessions(store, options.idleMs);
      if (sessions.size + pendingInitializations < options.maxCount) {
        pendingInitializations += 1;
        return true;
      }
      const oldest = [...sessions.entries()]
        .filter(([, session]) => !session.inFlightRequests && !session.openSseStreams)
        .sort((left, right) => left[1].lastActivityAt - right[1].lastActivityAt);
      while (sessions.size + pendingInitializations >= options.maxCount && oldest.length) {
        const oldestSession = oldest.shift();
        if (oldestSession === undefined) break;
        const [sessionId, session] = oldestSession;
        if (session.inFlightRequests || session.openSseStreams) continue;
        await store.delete(sessionId);
      }
      if (sessions.size + pendingInitializations >= options.maxCount) return false;
      pendingInitializations += 1;
      return true;
    },
    releaseCapacityReservation() {
      if (pendingInitializations) pendingInitializations -= 1;
    },
    stop() {
      stopped = true;
      if (evictionTimer !== undefined) {
        clearInterval(evictionTimer);
        evictionTimer = undefined;
      }
    },
  };

  if (options.idleMs > 0 && options.evictionIntervalMs > 0) {
    evictionTimer = setInterval(() => {
      if (stopped) return;
      void evictIdleLegacyMcpSessions(store, options.idleMs).catch((error) => {
        console.error(`[codegraph] MCP HTTP session eviction failed: ${errorMessage(error)}`);
      });
    }, options.evictionIntervalMs);
    evictionTimer.unref?.();
  }

  return store;
}

async function evictIdleLegacyMcpSessions(store: LegacyMcpSessionStore, idleMs: number): Promise<void> {
  if (idleMs <= 0) return;
  const cutoff = Date.now() - idleMs;
  for (const [sessionId, session] of store.sessions) {
    if (session.lastActivityAt > cutoff || session.inFlightRequests || session.openSseStreams) continue;
    await store.delete(sessionId);
  }
}

async function closeMcpSession(session: LegacyMcpSession): Promise<void> {
  await Promise.allSettled([session.transport.close(), session.server.close()]);
}

export async function closeLegacyMcpSessions(sessions: Map<string, LegacyMcpSession>): Promise<void> {
  const legacySessions = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(legacySessions.map((session) => closeMcpSession(session)));
}

export async function closeMcpResources(
  sessions: Map<string, LegacyMcpSession>,
  closeModernHandler: () => Promise<void>,
): Promise<void> {
  await Promise.allSettled([closeLegacyMcpSessions(sessions), closeModernHandler()]);
}
