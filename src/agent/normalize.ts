import path from "node:path";
import {
  fileIdentityKey,
  normalizePath,
  resolveFilePathFromRoot,
  toProjectDisplayPath,
  toProjectRelativePath,
} from "../util/paths.js";
import { parseSourceLocationInput } from "../util/source-location.js";
import { type AgentFollowUp, toolFollowUp } from "./follow-ups.js";

export type AgentFileSnapshot = {
  root: string;
  files: readonly string[];
  fileLookup?: ReadonlyMap<string, string>;
};

export function normalizeAgentFilePath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(path.resolve(file));
}

export function normalizeAgentOutputPath(root: string, file: string): string {
  return toProjectDisplayPath(root, file);
}

export function createAgentFileLookup(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [fileIdentityKey(file), normalizePath(file)]));
}

export function resolveAgentSnapshotFile(snapshot: AgentFileSnapshot, candidate: string): string | null {
  const normalizedFiles = snapshot.fileLookup ?? createAgentFileLookup(snapshot.files);
  const resolveCandidate = (value: string): string | null => {
    const absoluteCandidate = resolveFilePathFromRoot(snapshot.root, value);
    return normalizedFiles.get(fileIdentityKey(absoluteCandidate)) ?? null;
  };
  const direct = resolveCandidate(candidate);
  if (direct) return direct;
  const location = parseSourceLocationInput(candidate);
  return location.file === candidate ? null : resolveCandidate(location.file);
}

export function isAgentSqlObjectNode(node: { kind: string }): boolean {
  return node.kind === "table" || node.kind === "view" || node.kind === "index" || node.kind === "routine";
}

export function collectFileFollowUps(file: string): AgentFollowUp[] {
  return [
    toolFollowUp("file_deps", { file, direction: "deps" }),
    toolFollowUp("file_deps", { file, direction: "rdeps" }),
    toolFollowUp("chunk", { file }),
  ];
}

export function collectDefinitionFollowUps(file: string, line: number, column: number): AgentFollowUp[] {
  return [toolFollowUp("goto", { file, line, column }), toolFollowUp("refs", { file, line, column })];
}
