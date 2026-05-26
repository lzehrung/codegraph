import { buildReviewReport, type ReviewReport } from "../review.js";
import {
  explainCodegraphTargetWithSession,
  type AgentExplainTarget,
  type AgentExplanation,
} from "./explain.js";
import { createAgentSession, type AgentSession } from "./session.js";
import { quoteShellArg } from "./shell.js";

export type AgentPacketKind = "file" | "symbol" | "chunk" | "sql_object" | "graph" | "review";

export type AgentPacketRequest = {
  root: string;
  handle: string;
  maxSymbols?: number;
  maxSnippets?: number;
};

export type AgentPacketPayload = AgentExplanation | ReviewReport;

export type AgentPacketResponse = {
  schemaVersion: 1;
  root: string;
  handle: string;
  kind: AgentPacketKind;
  packet: AgentPacketPayload;
  limits: Record<string, number>;
  omittedCounts: Record<string, number>;
  followUps: string[];
};

const ACCEPTED_HANDLE_PREFIXES = ["file:", "symbol:", "chunk:", "sql:", "graph:", "review:"];

export async function getCodegraphPacket(request: AgentPacketRequest): Promise<AgentPacketResponse> {
  const session = createAgentSession({ root: request.root });
  return await getCodegraphPacketWithSession(session, request);
}

export async function getCodegraphPacketWithSession(
  session: AgentSession,
  request: AgentPacketRequest,
): Promise<AgentPacketResponse> {
  const kind = kindForHandle(request.handle);
  if (!kind) {
    throw new Error(`Unsupported packet handle. Expected one of: ${ACCEPTED_HANDLE_PREFIXES.join(", ")}`);
  }
  if (kind === "review") {
    return await buildReviewPacket(request);
  }

  const explainRequest: AgentExplainTarget = {
    root: request.root,
    target: request.handle,
  };
  if (request.maxSymbols !== undefined) {
    explainRequest.maxSymbols = request.maxSymbols;
  }
  if (request.maxSnippets !== undefined) {
    explainRequest.maxSnippets = request.maxSnippets;
  }

  const explanation = await explainCodegraphTargetWithSession(session, explainRequest);
  if (explanation.target.kind === "not_found") {
    throw new Error(`Packet handle did not resolve: ${request.handle}`);
  }

  return {
    schemaVersion: 1,
    root: explanation.root,
    handle: request.handle,
    kind,
    packet: explanation,
    limits: explanation.limits,
    omittedCounts: explanation.omittedCounts,
    followUps: explanation.followUps,
  };
}

async function buildReviewPacket(request: AgentPacketRequest): Promise<AgentPacketResponse> {
  const range = parseReviewHandle(request.handle);
  if (!range) {
    throw new Error("Invalid review packet handle. Expected review:base=<encoded-ref>;head=<encoded-ref>.");
  }
  const report = await buildReviewReport(request.root, {
    gitBase: range.base,
    gitHead: range.head,
    reviewDepth: "minimal",
  });
  return {
    schemaVersion: 1,
    root: request.root,
    handle: request.handle,
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
      `codegraph impact --provider git --base ${quoteShellArg(range.base)} --head ${quoteShellArg(range.head)} --pretty`,
      `codegraph review --base ${quoteShellArg(range.base)} --head ${quoteShellArg(range.head)} --summary`,
    ],
  };
}

function parseReviewHandle(handle: string): { base: string; head: string } | null {
  if (!handle.startsWith("review:")) return null;
  const fields = new Map<string, string>();
  for (const part of handle.slice("review:".length).split(";")) {
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
