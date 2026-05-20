import path from "node:path";
import { normalizePath, toProjectRelativePath } from "../util/paths.js";
import { quoteShellArg } from "./shell.js";

export function normalizeAgentFilePath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(path.resolve(file));
}

export function normalizeAgentOutputPath(root: string, file: string): string {
  return toProjectRelativePath(root, file) ?? normalizePath(file);
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
