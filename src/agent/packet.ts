import type { ReviewReport } from "../review.js";
import { explainCodegraphTarget, type AgentExplainTarget, type AgentExplanation } from "./explain.js";

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

const ACCEPTED_HANDLE_PREFIXES = ["file:", "symbol:", "chunk:", "sql:", "graph:"];

export async function getCodegraphPacket(request: AgentPacketRequest): Promise<AgentPacketResponse> {
  const kind = kindForHandle(request.handle);
  if (!kind) {
    throw new Error(`Unsupported packet handle. Expected one of: ${ACCEPTED_HANDLE_PREFIXES.join(", ")}`);
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

  const explanation = await explainCodegraphTarget(explainRequest);
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

function kindForHandle(handle: string): AgentPacketKind | null {
  if (handle.startsWith("file:")) return "file";
  if (handle.startsWith("symbol:")) return "symbol";
  if (handle.startsWith("chunk:")) return "chunk";
  if (handle.startsWith("sql:")) return "sql_object";
  if (handle.startsWith("graph:")) return "graph";
  return null;
}
