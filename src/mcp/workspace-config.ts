import fs from "node:fs/promises";
import path from "node:path";
import { isPlainRecord } from "../util/guards.js";
import { fileIdentityKey, isFilePathWithinRoot, normalizePath } from "../util/paths.js";
import { openConfinedReadableFile } from "../util/confined-file.js";

export const MAX_WORKSPACE_PROJECTS = 64;
export const MAX_WORKSPACE_CONFIG_BYTES = 1_000_000;

export type WorkspaceProject = {
  id: string;
  path: string;
  root: string;
  aliases: string[];
};

export type WorkspaceDependency = {
  from: string;
  to: string;
  configuredFrom: string;
  configuredTo: string;
};

export type WorkspaceMcpConfig = {
  root: string;
  logicalRoot: string;
  projects: WorkspaceProject[];
  dependencies: WorkspaceDependency[];
  aliases: Map<string, WorkspaceProject>;
};

type WorkspaceConfigInput = {
  projects: Array<{ id: string; path: string }>;
  dependencies: Array<{ from: string; to: string }>;
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function assertRelativePath(value: string, label: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (
    !normalized.length ||
    path.isAbsolute(value) ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.startsWith("//")
  ) {
    throw new Error(`${label} must be a relative path inside the workspace root.`);
  }
  return normalized;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return true;
  }
  return false;
}

function parseConfig(value: unknown): WorkspaceConfigInput {
  if (!isPlainRecord(value)) throw new Error("Workspace config must be a JSON object.");
  const allowedKeys = new Set(["projects", "dependencies"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`Unknown workspace config property: ${key}.`);
  }
  if (!Array.isArray(value.projects) || !value.projects.length) {
    throw new Error("Workspace config must contain at least one project.");
  }
  if (value.projects.length > MAX_WORKSPACE_PROJECTS) {
    throw new Error(`Workspace config supports at most ${MAX_WORKSPACE_PROJECTS} projects.`);
  }
  const projects = value.projects.map((entry, index) => {
    if (!isPlainRecord(entry)) throw new Error(`Workspace project ${index + 1} must be an object.`);
    for (const key of Object.keys(entry)) {
      if (key !== "id" && key !== "path")
        throw new Error(`Unknown property in workspace project ${index + 1}: ${key}.`);
    }
    if (
      typeof entry.id !== "string" ||
      !entry.id.length ||
      entry.id.length > 128 ||
      entry.id.trim() !== entry.id ||
      hasControlCharacters(entry.id)
    ) {
      throw new Error(`Workspace project ${index + 1} must have a non-empty printable id of at most 128 characters.`);
    }
    if (typeof entry.path !== "string") throw new Error(`Workspace project '${entry.id}' must have a path.`);
    return { id: entry.id, path: entry.path };
  });
  const dependenciesValue = Object.hasOwn(value, "dependencies") ? value.dependencies : [];
  if (!Array.isArray(dependenciesValue)) throw new Error("Workspace dependencies must be an array.");
  const dependencies = dependenciesValue.map((entry, index) => {
    if (!isPlainRecord(entry)) throw new Error(`Workspace dependency ${index + 1} must be an object.`);
    for (const key of Object.keys(entry)) {
      if (key !== "from" && key !== "to")
        throw new Error(`Unknown property in workspace dependency ${index + 1}: ${key}.`);
    }
    if (typeof entry.from !== "string" || !entry.from.length || typeof entry.to !== "string" || !entry.to.length) {
      throw new Error(`Workspace dependency ${index + 1} must name both 'from' and 'to' project ids.`);
    }
    return { from: entry.from, to: entry.to };
  });
  return { projects, dependencies };
}

export async function loadWorkspaceMcpConfig(root: string, configPath: string): Promise<WorkspaceMcpConfig> {
  const logicalRoot = path.resolve(root);
  const physicalRoot = await fs.realpath(logicalRoot);
  const rootStat = await fs.stat(physicalRoot);
  if (!rootStat.isDirectory()) throw new Error("Workspace root must be a directory.");

  const relativeConfigPath = assertRelativePath(configPath, "Workspace config path");
  const candidateConfigPath = path.resolve(logicalRoot, ...relativeConfigPath.split("/"));
  if (!isFilePathWithinRoot(logicalRoot, candidateConfigPath) || !isWithin(logicalRoot, candidateConfigPath)) {
    throw new Error("Workspace config path must stay inside the workspace root.");
  }
  const confinedConfig = await openConfinedReadableFile(physicalRoot, logicalRoot, candidateConfigPath);
  let source: string;
  try {
    if (confinedConfig.size > MAX_WORKSPACE_CONFIG_BYTES) {
      throw new Error(`Workspace config exceeds the ${MAX_WORKSPACE_CONFIG_BYTES}-byte limit.`);
    }
    source = await confinedConfig.handle.readFile({ encoding: "utf8" });
  } finally {
    await confinedConfig.handle.close();
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(source) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Workspace config is not valid JSON: ${detail}`);
  }
  const input = parseConfig(parsedJson);
  const projectIds = new Set<string>();
  const projectByIdentity = new Map<string, WorkspaceProject>();
  const aliases = new Map<string, WorkspaceProject>();
  const projects: WorkspaceProject[] = [];

  for (const declaration of input.projects) {
    if (projectIds.has(declaration.id)) throw new Error(`Duplicate workspace project id: ${declaration.id}.`);
    projectIds.add(declaration.id);
    const relativeProjectPath = assertRelativePath(declaration.path, `Path for project '${declaration.id}'`);
    const candidatePath = path.resolve(logicalRoot, ...relativeProjectPath.split("/"));
    if (!isFilePathWithinRoot(logicalRoot, candidatePath) || !isWithin(logicalRoot, candidatePath)) {
      throw new Error(`Workspace project '${declaration.id}' must stay inside the workspace root.`);
    }
    const physicalProjectPath = await fs.realpath(candidatePath);
    if (!isFilePathWithinRoot(physicalRoot, physicalProjectPath) || !isWithin(physicalRoot, physicalProjectPath)) {
      throw new Error(`Workspace project '${declaration.id}' resolves outside the workspace root.`);
    }
    const projectStat = await fs.stat(physicalProjectPath);
    if (!projectStat.isDirectory()) throw new Error(`Workspace project '${declaration.id}' is not a directory.`);

    const identity = fileIdentityKey(physicalProjectPath);
    const existingProject = projectByIdentity.get(identity);
    if (existingProject) {
      existingProject.aliases.push(declaration.id);
      aliases.set(declaration.id, existingProject);
      continue;
    }
    const relativeToRoot = normalizePath(path.relative(logicalRoot, candidatePath)) || ".";
    const project: WorkspaceProject = {
      id: declaration.id,
      path: relativeToRoot,
      root: physicalProjectPath,
      aliases: [],
    };
    projectByIdentity.set(identity, project);
    aliases.set(declaration.id, project);
    projects.push(project);
  }

  const dependencyKeys = new Set<string>();
  const dependencies = input.dependencies.map((dependency) => {
    const sourceProject = aliases.get(dependency.from);
    const targetProject = aliases.get(dependency.to);
    if (!sourceProject) throw new Error(`Workspace dependency references unknown source project '${dependency.from}'.`);
    if (!targetProject) throw new Error(`Workspace dependency references unknown target project '${dependency.to}'.`);
    const key = `${dependency.from}\u0000${dependency.to}`;
    if (dependencyKeys.has(key)) {
      throw new Error(`Duplicate workspace dependency: '${dependency.from}' -> '${dependency.to}'.`);
    }
    dependencyKeys.add(key);
    return {
      from: sourceProject.id,
      to: targetProject.id,
      configuredFrom: dependency.from,
      configuredTo: dependency.to,
    };
  });

  return { root: physicalRoot, logicalRoot, projects, dependencies, aliases };
}
