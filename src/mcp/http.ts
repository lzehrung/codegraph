import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";

export type ParsedJsonBody = { status: "ok"; body: unknown } | { status: "too_large" } | { status: "invalid_json" };

export type AllowedHostHeaderRules = {
  exact: Set<string>;
  loopbackOnly: Set<string>;
};

export function getRequestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://127.0.0.1").pathname;
}

export async function readJsonRequestBody(request: IncomingMessage, maxBytes: number): Promise<ParsedJsonBody> {
  const contentLength = getContentLength(request);
  if (contentLength !== undefined && contentLength > maxBytes) {
    request.resume();
    return { status: "too_large" };
  }

  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    bytes += buffer.byteLength;
    if (bytes > maxBytes) {
      return { status: "too_large" };
    }
    chunks.push(buffer);
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  try {
    const body: unknown = rawBody.length ? JSON.parse(rawBody) : null;
    return { status: "ok", body };
  } catch {
    return { status: "invalid_json" };
  }
}

export function emptyAllowedHostHeaderRules(): AllowedHostHeaderRules {
  return { exact: new Set(), loopbackOnly: new Set() };
}

export function isAllowedHostHeader(request: IncomingMessage, allowedHostHeaders: AllowedHostHeaderRules): boolean {
  const host = getHeaderValue(request.headers.host);
  if (host === undefined) return false;
  const normalizedHost = host.toLowerCase();
  if (allowedHostHeaders.exact.has(normalizedHost)) return true;
  return allowedHostHeaders.loopbackOnly.has(normalizedHost) && isLoopbackRemoteAddress(request.socket.remoteAddress);
}

function addAllowedHost(target: Set<string>, host: string, port: number): void {
  target.add(formatHostHeader(host, port).toLowerCase());
  if (port === 80) target.add(formatHostForUrl(host).toLowerCase());
}

export function buildAllowedHostHeaders(host: string, port: number): AllowedHostHeaderRules {
  const allowed = emptyAllowedHostHeaderRules();
  addAllowedHost(allowed.exact, host, port);
  if (isWildcardBindHost(host)) {
    addAllowedHost(allowed.loopbackOnly, "127.0.0.1", port);
    addAllowedHost(allowed.loopbackOnly, "localhost", port);
    addAllowedHost(allowed.loopbackOnly, "::1", port);
    for (const localHost of localInterfaceHostHeaders(port)) {
      allowed.exact.add(localHost);
      if (port === 80) allowed.exact.add(localHost.replace(/:80$/, ""));
    }
  }
  if (host === "127.0.0.1") {
    addAllowedHost(allowed.exact, "localhost", port);
  }
  if (host === "::1" || host === "[::1]") {
    addAllowedHost(allowed.exact, "::1", port);
    addAllowedHost(allowed.exact, "localhost", port);
  }
  return allowed;
}

export function formatHostForUrl(host: string): string {
  if (host.includes(":") && !host.startsWith("[")) return `[${host}]`;
  return host;
}

export function writeJsonRpcError(response: ServerResponse, statusCode: number, message: string, code = -32000): void {
  writeJsonResponse(response, statusCode, {
    jsonrpc: "2.0",
    id: null,
    error: { code, message },
  });
}

export function writeJsonResponse(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export async function listenOnHttpServer(server: HttpServer, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function getHttpServerPort(address: string | AddressInfo | null): number {
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP address.");
  }
  return address.port;
}

export async function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function waitForHttpServerClose(server: HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });
}

export function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function getContentLength(request: IncomingMessage): number | undefined {
  const raw = getHeaderValue(request.headers["content-length"]);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function isWildcardBindHost(host: string): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function localInterfaceHostHeaders(port: number): Set<string> {
  const hosts = new Set<string>();
  const hostname = os.hostname().trim().toLowerCase();
  if (hostname) {
    hosts.add(`${hostname}:${port}`);
  }
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const address = entry.address.split("%")[0] ?? entry.address;
      hosts.add(formatHostHeader(address, port).toLowerCase());
    }
  }
  return hosts;
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address.startsWith("127.");
}

function formatHostHeader(host: string, port: number): string {
  return `${formatHostForUrl(host)}:${port}`;
}
