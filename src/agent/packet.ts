import { buildReviewReport, type ReviewReport } from "../review.js";
import type { BuildOptions } from "../indexer/types.js";
import { explainCodegraphTargetWithSession, type AgentExplainTarget, type AgentExplanation } from "./explain.js";
import { createAgentSession, type AgentSession } from "./session.js";
import { quoteShellArg } from "./shell.js";

export type AgentPacketKind = "file" | "symbol" | "chunk" | "sql_object" | "graph" | "review";

export type AgentPacketRequest = {
  root: string;
  target: string;
  buildOptions?: BuildOptions;
  maxSymbols?: number;
  maxSnippets?: number;
  maxDuplicates?: number;
};

export type AgentPacketPayload = AgentExplanation | ReviewReport;

export type AgentPacketResponse = {
  schemaVersion: 2;
  root: string;
  target: string;
  kind: AgentPacketKind;
  packet: AgentPacketPayload;
  limits: Record<string, number>;
  omittedCounts: Record<string, number>;
  followUps: string[];
};

export async function getCodegraphPacket(request: AgentPacketRequest): Promise<AgentPacketResponse> {
  const kind = inferPacketKind(request.target);
  if (kind === "review") {
    return await buildReviewPacket(request);
  }

  const session = createAgentSession({
    root: request.root,
    ...(request.buildOptions ? { buildOptions: request.buildOptions } : {}),
  });
  return await buildExplainPacket(session, request, kind);
}

export async function getCodegraphPacketWithSession(
  session: AgentSession,
  request: AgentPacketRequest,
): Promise<AgentPacketResponse> {
  const kind = inferPacketKind(request.target);
  if (kind === "review") {
    return await buildReviewPacket(request);
  }

  return await buildExplainPacket(session, request, kind);
}

async function buildExplainPacket(
  session: AgentSession,
  request: AgentPacketRequest,
  kind: AgentPacketKind | null,
): Promise<AgentPacketResponse> {
  const explainRequest: AgentExplainTarget = {
    root: request.root,
    target: request.target,
  };
  if (request.maxSymbols !== undefined) {
    explainRequest.maxSymbols = request.maxSymbols;
  }
  if (request.maxSnippets !== undefined) {
    explainRequest.maxSnippets = request.maxSnippets;
  }
  if (request.maxDuplicates !== undefined) {
    explainRequest.maxDuplicates = request.maxDuplicates;
  }

  const explanation = await explainCodegraphTargetWithSession(session, explainRequest);
  if (explanation.target.kind === "not_found") {
    throw new Error(`Packet target did not resolve: ${request.target}`);
  }

  return {
    schemaVersion: 2,
    root: explanation.root,
    target: request.target,
    kind: kind ?? packetKindForResolvedTarget(explanation.target.kind),
    packet: explanation,
    limits: explanation.limits,
    omittedCounts: explanation.omittedCounts,
    followUps: explanation.followUps,
  };
}

function inferPacketKind(target: string): AgentPacketKind | null {
  return kindForHandle(target);
}

function packetKindForResolvedTarget(kind: AgentExplanation["target"]["kind"]): AgentPacketKind {
  if (kind === "sql_object") return "sql_object";
  if (kind === "symbol") return "symbol";
  return "file";
}

async function buildReviewPacket(request: AgentPacketRequest): Promise<AgentPacketResponse> {
  const range = parseReviewHandle(request.target);
  if (!range) {
    throw new Error("Invalid review packet target. Expected review:base=<encoded-ref>;head=<encoded-ref>.");
  }
  const report = await buildReviewReport(request.root, {
    gitBase: range.base,
    gitHead: range.head,
    reviewDepth: "minimal",
  });
  return {
    schemaVersion: 2,
    root: request.root,
    target: request.target,
    kind: "review",
    packet: report,
    limits: {
      changedFiles: report.changedFiles.length,
      candidateTests: report.candidateTests.length,
      reviewTasks: report.reviewTasks.length,
    },
    omittedCounts: {
      changedFiles: 0,
      candidateTests: 0,
      reviewTasks: 0,
    },
    followUps: [
      `codegraph impact --provider git --base ${quoteShellArg(range.base)} --head ${quoteShellArg(range.head)}`,
      `codegraph review --base ${quoteShellArg(range.base)} --head ${quoteShellArg(range.head)}`,
    ],
  };
}

function parseReviewHandle(target: string): { base: string; head: string } | null {
  if (!target.startsWith("review:")) return null;
  const fields = new Map<string, string>();
  for (const part of target.slice("review:".length).split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    const decodedValue = decodeReviewHandleField(value);
    if (decodedValue === null) return null;
    fields.set(key, decodedValue);
  }
  const base = fields.get("base");
  const head = fields.get("head");
  if (!base || !head) return null;
  return { base, head };
}

function decodeReviewHandleField(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function kindForHandle(handle: string): AgentPacketKind | null {
  if (handle.startsWith("file:")) return "file";
  if (handle.startsWith("symbol:")) return "symbol";
  if (handle.startsWith("chunk:")) return "chunk";
  if (handle.startsWith("sql:")) return "sql_object";
  if (handle.startsWith("graph:")) return "graph";
  if (handle.startsWith("review:")) return "review";
  return null;
}
