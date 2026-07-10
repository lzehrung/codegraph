import fs from "node:fs/promises";
import path from "node:path";

import type { BuildOptions } from "../indexer/types.js";
import { resolveProjectFile, resolveReadableFile } from "../util/confinedFile.js";
import { toProjectDisplayPath } from "../util/paths.js";
import {
  createAgentSession,
  type AgentFreshnessResult,
  type AgentProjectSnapshot,
  type AgentSession,
} from "./session.js";
import { quoteShellArg } from "./shell.js";

export const DEFAULT_FILE_VIEW_BYTES = 80_000;
export const MAX_FILE_VIEW_BYTES = 500_000;
export const DEFAULT_FILE_VIEW_LINES = 2_000;
export const MAX_FILE_VIEW_LINES = 10_000;
export const FILE_VIEW_GRAPH_CONTEXT_LIMIT = 100;

export type AgentFileGraphContext = {
  usedBy: string[];
  imports: string[];
  symbols: Array<{ name: string; kind: string; line: number }>;
};

export type AgentFileViewSensitiveKind = "environment" | "authentication-config" | "credential-config" | "key-material";

export type AgentFileViewSensitiveInfo = {
  kind: AgentFileViewSensitiveKind;
  redacted: boolean;
  allowSensitiveRequired: true;
};

export type AgentFileViewRequest = {
  root: string;
  file: string;
  offset?: number;
  limit?: number;
  maxBytes?: number;
  includeGraphContext?: boolean;
  allowSensitive?: boolean;
  buildOptions?: BuildOptions;
};

export type AgentFileViewResponse = {
  schemaVersion: 1;
  file: string;
  offset: number;
  limit: number;
  totalLines: number;
  content: string;
  lineFormat: "number-tab-line";
  text: string;
  truncated: boolean;
  freshness: AgentFreshnessResult;
  graphContext?: AgentFileGraphContext;
  sensitive?: AgentFileViewSensitiveInfo;
  page?: { nextOffset?: number };
};

type FilePage = {
  lines: string[];
  text: string;
  totalLines: number;
  truncated: boolean;
  nextOffset?: number;
};

type SensitiveSummary = {
  text: string;
  scanTruncated: boolean;
};

const READ_BUFFER_BYTES = 64 * 1024;
const SENSITIVE_SCAN_BYTES = 64 * 1024;
const SENSITIVE_KEY_LIMIT = 100;
const BINARY_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bmp",
  ".class",
  ".dll",
  ".dylib",
  ".eot",
  ".exe",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mov",
  ".mp3",
  ".mp4",
  ".o",
  ".otf",
  ".pdf",
  ".png",
  ".so",
  ".tar",
  ".tgz",
  ".ttf",
  ".wav",
  ".webp",
  ".woff",
  ".woff2",
  ".zip",
]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export async function getCodegraphFileView(request: AgentFileViewRequest): Promise<AgentFileViewResponse> {
  let session: AgentSession | undefined;
  if (request.includeGraphContext) {
    session = createAgentSession({
      root: request.root,
      ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
    });
  }
  return await getCodegraphFileViewWithSession(session, request);
}

export async function getCodegraphFileViewWithSession(
  session: AgentSession | undefined,
  request: AgentFileViewRequest,
): Promise<AgentFileViewResponse> {
  const root = path.resolve(request.root);
  const realRoot = await fs.realpath(root);
  const resolvedFile = await resolveReadableFile(realRoot, root, request.file);
  const offset = boundedPositiveInteger(request.offset, 1, Number.MAX_SAFE_INTEGER);
  const limit = boundedPositiveInteger(request.limit, DEFAULT_FILE_VIEW_LINES, MAX_FILE_VIEW_LINES);
  const maxBytes = boundedPositiveInteger(request.maxBytes, DEFAULT_FILE_VIEW_BYTES, MAX_FILE_VIEW_BYTES);
  const sensitiveKind = classifySensitiveFile(resolvedFile.displayPath);

  if (sensitiveKind && !request.allowSensitive) {
    const summary = await buildSensitiveSummary(resolvedFile.realPath, sensitiveKind);
    const page = paginateText(summary.text, offset, limit);
    return buildResponse({
      file: resolvedFile.displayPath,
      offset,
      limit,
      page,
      truncated: summary.scanTruncated,
      freshness: { state: "fresh" },
      sensitive: { kind: sensitiveKind, redacted: true, allowSensitiveRequired: true },
    });
  }

  const page = await readTextFilePage(resolvedFile.realPath, offset, limit, maxBytes);
  let freshness: AgentFreshnessResult = { state: "fresh" };
  let graphContext: AgentFileGraphContext | undefined;
  if (request.includeGraphContext) {
    const activeSession =
      session ??
      createAgentSession({
        root,
        ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
      });
    if (activeSession.checkFreshness) {
      freshness = await activeSession.checkFreshness();
    }
    const projectFile = await resolveProjectFile(realRoot, root, request.file);
    const snapshot = await activeSession.loadProject({ symbolGraph: "skip" });
    graphContext = buildFileGraphContext(snapshot, projectFile);
  }

  return buildResponse({
    file: resolvedFile.displayPath,
    offset,
    limit,
    page,
    truncated: page.truncated,
    freshness,
    ...(graphContext ? { graphContext } : {}),
    ...(sensitiveKind
      ? { sensitive: { kind: sensitiveKind, redacted: false, allowSensitiveRequired: true } as const }
      : {}),
  });
}

export function formatAgentFileViewResponse(response: AgentFileViewResponse): string {
  const lines = [`File: ${response.file}`];
  if (response.sensitive?.redacted) {
    lines.push(`Sensitive ${response.sensitive.kind}: values omitted; pass --allow-sensitive to read raw content.`);
  }
  if (response.graphContext) {
    lines.push(formatUsedByLine(response.graphContext.usedBy));
    lines.push(formatContextLine("Imports", response.graphContext.imports));
    const symbols = response.graphContext.symbols.map(
      (symbol) => `${symbol.name} (${symbol.kind}, line ${symbol.line})`,
    );
    lines.push(formatContextLine("Symbols", symbols));
  }

  const returnedLineCount = response.content ? response.content.split("\n").length : 0;
  let endLine = response.offset - 1;
  if (returnedLineCount) {
    endLine = Math.min(response.totalLines, response.offset + returnedLineCount - 1);
  }
  lines.push(`Lines ${response.offset}-${endLine} of ${response.totalLines}`);
  if (response.content) lines.push(response.content);
  if (response.truncated) {
    lines.push(`Content was truncated by the ${MAX_FILE_VIEW_BYTES}-byte hard limit or a smaller requested maxBytes.`);
  }
  const nextOffset = response.page?.nextOffset;
  if (nextOffset !== undefined) {
    lines.push(
      `Next page: codegraph file ${quoteShellArg(response.file)} --offset ${nextOffset} --limit ${response.limit} --pretty`,
    );
  }
  return lines.join("\n");
}

export function buildFileGraphContext(snapshot: AgentProjectSnapshot, file: string): AgentFileGraphContext | undefined {
  const moduleIndex = snapshot.index.byFile.get(file);
  if (!moduleIndex) return undefined;

  const usedBy = uniqueSorted(
    snapshot.fileGraph.edges
      .filter((edge) => edge.to.type === "file" && edge.to.path === file)
      .map((edge) => toProjectDisplayPath(snapshot.root, edge.from)),
  ).slice(0, FILE_VIEW_GRAPH_CONTEXT_LIMIT);
  const imports = uniqueSorted(
    moduleIndex.imports.map((importBinding) => {
      const resolved = importBinding.resolved;
      if (typeof resolved === "string") return toProjectDisplayPath(snapshot.root, resolved);
      if (resolved) return resolved.external;
      return importBinding.from;
    }),
  ).slice(0, FILE_VIEW_GRAPH_CONTEXT_LIMIT);
  const symbols = moduleIndex.locals
    .map((symbol) => ({ name: symbol.localName, kind: symbol.kind, line: symbol.range.start.line }))
    .sort((left, right) => left.line - right.line || left.name.localeCompare(right.name))
    .slice(0, FILE_VIEW_GRAPH_CONTEXT_LIMIT);

  return { usedBy, imports, symbols };
}

function buildResponse(args: {
  file: string;
  offset: number;
  limit: number;
  page: FilePage;
  truncated: boolean;
  freshness: AgentFreshnessResult;
  graphContext?: AgentFileGraphContext;
  sensitive?: AgentFileViewSensitiveInfo;
}): AgentFileViewResponse {
  return {
    schemaVersion: 1,
    file: args.file,
    offset: args.offset,
    limit: args.limit,
    totalLines: args.page.totalLines,
    content: args.page.lines.map((line, index) => `${args.offset + index}\t${line}`).join("\n"),
    lineFormat: "number-tab-line",
    text: args.page.text,
    truncated: args.truncated,
    freshness: args.freshness,
    ...(args.graphContext ? { graphContext: args.graphContext } : {}),
    ...(args.sensitive ? { sensitive: args.sensitive } : {}),
    ...(args.page.nextOffset !== undefined ? { page: { nextOffset: args.page.nextOffset } } : {}),
  };
}

async function readTextFilePage(filePath: string, offset: number, limit: number, maxBytes: number): Promise<FilePage> {
  if (BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new Error(`Binary files are not supported: ${filePath}`);
  }

  const handle = await fs.open(filePath, "r");
  const selectedLines: string[] = [];
  let lineNumber = 1;
  let remainingBytes = maxBytes;
  let byteBudgetExhausted = false;
  let pageTruncated = false;
  let currentLineInitialized = false;
  let currentLineSelected = false;
  let currentLineTruncated = false;
  let currentLineChunks: Buffer[] = [];
  let lastReturnedLine: number | undefined;

  const initializeLine = (): void => {
    if (currentLineInitialized) return;
    currentLineInitialized = true;
    if (lineNumber < offset || selectedLines.length >= limit || byteBudgetExhausted) return;
    if (selectedLines.length) {
      if (!remainingBytes) {
        byteBudgetExhausted = true;
        return;
      }
      remainingBytes -= 1;
    }
    currentLineSelected = true;
  };

  const consumeSegment = (segment: Buffer): void => {
    initializeLine();
    if (!currentLineSelected || !segment.length) return;
    const bytesToKeep = Math.min(segment.length, remainingBytes);
    if (bytesToKeep) {
      currentLineChunks.push(Buffer.from(segment.subarray(0, bytesToKeep)));
      remainingBytes -= bytesToKeep;
    }
    if (bytesToKeep < segment.length) {
      currentLineTruncated = true;
      byteBudgetExhausted = true;
    }
  };

  const finishLine = (): void => {
    initializeLine();
    if (currentLineSelected) {
      const lineBuffer = currentLineChunks.length === 1 ? currentLineChunks[0]! : Buffer.concat(currentLineChunks);
      selectedLines.push(decodeLineBuffer(lineBuffer, currentLineTruncated, filePath));
      lastReturnedLine = lineNumber;
      if (currentLineTruncated) pageTruncated = true;
    }
    currentLineInitialized = false;
    currentLineSelected = false;
    currentLineTruncated = false;
    currentLineChunks = [];
  };

  try {
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) {
        throw new Error(`Binary files are not supported: ${filePath}`);
      }
      let segmentStart = 0;
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk[index] !== 0x0a) continue;
        consumeSegment(chunk.subarray(segmentStart, index));
        finishLine();
        lineNumber += 1;
        segmentStart = index + 1;
      }
      consumeSegment(chunk.subarray(segmentStart));
    }
    finishLine();
  } finally {
    await handle.close();
  }

  let nextOffset: number | undefined;
  if (lastReturnedLine !== undefined && lastReturnedLine < lineNumber) {
    nextOffset = lastReturnedLine + 1;
  }
  return {
    lines: selectedLines,
    text: selectedLines.join("\n"),
    totalLines: lineNumber,
    truncated: pageTruncated,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}

function decodeLineBuffer(buffer: Buffer, truncated: boolean, filePath: string): string {
  const candidate = truncated ? trimToUtf8Boundary(buffer) : buffer;
  try {
    return UTF8_DECODER.decode(candidate);
  } catch {
    throw new Error(`Binary or non-UTF-8 files are not supported: ${filePath}`);
  }
}

function trimToUtf8Boundary(buffer: Buffer): Buffer {
  if (!buffer.length) return buffer;
  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0) {
    const byte = buffer[leadIndex];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    leadIndex -= 1;
  }
  if (leadIndex < 0) return buffer.subarray(0, 0);
  const leadByte = buffer[leadIndex];
  if (leadByte === undefined) return buffer.subarray(0, 0);
  const continuationBytes = buffer.length - leadIndex - 1;
  const expectedContinuationBytes = expectedUtf8ContinuationBytes(leadByte);
  if (expectedContinuationBytes === null) return buffer.subarray(0, leadIndex);
  if (continuationBytes < expectedContinuationBytes) return buffer.subarray(0, leadIndex);
  return buffer;
}

function expectedUtf8ContinuationBytes(byte: number): number | null {
  if ((byte & 0x80) === 0) return 0;
  if ((byte & 0xe0) === 0xc0) return 1;
  if ((byte & 0xf0) === 0xe0) return 2;
  if ((byte & 0xf8) === 0xf0) return 3;
  return null;
}

function paginateText(text: string, offset: number, limit: number): FilePage {
  const lines = text.split("\n");
  const start = Math.max(0, offset - 1);
  const selectedLines = lines.slice(start, start + limit);
  const lastReturnedLine = start + selectedLines.length;
  let nextOffset: number | undefined;
  if (lastReturnedLine < lines.length) nextOffset = lastReturnedLine + 1;
  return {
    lines: selectedLines,
    text: selectedLines.join("\n"),
    totalLines: lines.length,
    truncated: false,
    ...(nextOffset !== undefined ? { nextOffset } : {}),
  };
}

function classifySensitiveFile(filePath: string): AgentFileViewSensitiveKind | undefined {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === ".env" || basename.startsWith(".env.")) return "environment";
  if (basename === ".npmrc" || basename === ".pypirc" || basename === ".netrc") {
    return "authentication-config";
  }
  if (/^(?:credentials?|secrets?|service-account)(?:\.[^.]+)*\.(?:json|ya?ml|toml|ini)$/i.test(basename)) {
    return "credential-config";
  }
  if (/\.(?:key|pem|p12|pfx)$/i.test(basename) || /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/i.test(basename)) {
    return "key-material";
  }
  return undefined;
}

async function buildSensitiveSummary(filePath: string, kind: AgentFileViewSensitiveKind): Promise<SensitiveSummary> {
  const stat = await fs.stat(filePath);
  if (kind === "key-material") {
    return {
      text: `Sensitive key material omitted.\nSize: ${stat.size} bytes.`,
      scanTruncated: false,
    };
  }

  const handle = await fs.open(filePath, "r");
  try {
    const bytesToRead = Math.min(SENSITIVE_SCAN_BYTES, stat.size);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const keys = extractSensitiveKeys(text).slice(0, SENSITIVE_KEY_LIMIT);
    const keySummary = keys.length ? keys.join(", ") : "No keys detected in bounded structural scan.";
    return {
      text: `Sensitive ${kind} values omitted.\nKeys: ${keySummary}`,
      scanTruncated: stat.size > bytesRead || keys.length >= SENSITIVE_KEY_LIMIT,
    };
  } finally {
    await handle.close();
  }
}

function extractSensitiveKeys(text: string): string[] {
  const keys: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.:-]*)\s*(?:=|:)/g,
    /"([^"\n]+)"\s*:/g,
    /(?:^|\s)(machine|login|password|account)\s+/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const key = match[1];
      if (key) keys.push(key);
    }
  }
  return uniqueSorted(keys);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

function formatUsedByLine(values: readonly string[]): string {
  const noun = values.length === 1 ? "file" : "files";
  if (!values.length) return `Used by 0 ${noun}: none`;
  return `Used by ${values.length} ${noun}: ${values.join(", ")}`;
}

function formatContextLine(label: string, values: readonly string[]): string {
  if (!values.length) return `${label} 0: none`;
  return `${label} ${values.length}: ${values.join(", ")}`;
}
