import path from "node:path";
import { normalizePath, toProjectDisplayPath, toProjectRelativePath } from "../util/paths.js";
import { parseSourceLocationInput } from "../util/sourceLocation.js";
import { type AgentFollowUp, toolFollowUp } from "./followUps.js";

export type AgentFileSnapshot = {
  root: string;
  files: readonly string[];
  fileLookup?: ReadonlyMap<string, string>;
};

export type AgentSqlObjectKind = "table" | "view" | "index" | "routine";

export function normalizeAgentFilePath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(path.resolve(file));
}

export function normalizeAgentOutputPath(root: string, file: string): string {
  return toProjectDisplayPath(root, file);
}

export function createAgentFileLookup(files: readonly string[]): Map<string, string> {
  return new Map(files.map((file) => [normalizePath(file), normalizePath(file)]));
}

export function resolveAgentSnapshotFile(snapshot: AgentFileSnapshot, candidate: string): string | null {
  const normalizedFiles = snapshot.fileLookup ?? createAgentFileLookup(snapshot.files);
  const resolveCandidate = (value: string): string | null => {
    const absoluteCandidate = path.isAbsolute(value)
      ? normalizePath(value)
      : normalizePath(path.resolve(snapshot.root, value));
    return normalizedFiles.get(absoluteCandidate) ?? null;
  };
  const direct = resolveCandidate(candidate);
  if (direct) return direct;
  const location = parseSourceLocationInput(candidate);
  return location.file === candidate ? null : resolveCandidate(location.file);
}

export function isAgentSqlFile(file: string): boolean {
  return file.toLowerCase().endsWith(".sql");
}

export function isAgentSqlObjectKind(kind: string): kind is AgentSqlObjectKind {
  return kind === "table" || kind === "view" || kind === "index" || kind === "routine";
}

export function isAgentSqlObjectNode(node: { kind: string }): boolean {
  return isAgentSqlObjectKind(node.kind);
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
