import path from "node:path";
import { normalizePath, toProjectDisplayPath, toProjectRelativePath } from "../util/paths.js";
import { quoteShellArg } from "./shell.js";

export type AgentFileSnapshot = {
  root: string;
  files: readonly string[];
};

export type AgentSqlObjectKind = "table" | "view" | "index" | "routine";

export function normalizeAgentFilePath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(path.resolve(file));
}

export function normalizeAgentOutputPath(root: string, file: string): string {
  return toProjectDisplayPath(root, file);
}

export function resolveAgentSnapshotFile(snapshot: AgentFileSnapshot, candidate: string): string | null {
  const normalizedFiles = new Map(snapshot.files.map((file) => [normalizePath(file), normalizePath(file)]));
  const absoluteCandidate = path.isAbsolute(candidate)
    ? normalizePath(candidate)
    : normalizePath(path.resolve(snapshot.root, candidate));
  return normalizedFiles.get(absoluteCandidate) ?? null;
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

export function collectFileFollowUps(file: string): string[] {
  return [
    `codegraph deps ${quoteShellArg(file)} --json`,
    `codegraph rdeps ${quoteShellArg(file)} --json`,
    `codegraph chunk ${quoteShellArg(file)}`,
  ];
}

export function collectDefinitionFollowUps(file: string, line: number, column: number): string[] {
  return [
    `codegraph goto ${quoteShellArg(file)} ${line} ${column}`,
    `codegraph refs --file ${quoteShellArg(file)} --line ${line} --col ${column} --pretty`,
  ];
}
