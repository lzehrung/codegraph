import fs from "node:fs/promises";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ProtocolError, ProtocolErrorCode, Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  parseAgentChunkHandle,
  parseAgentFileHandle,
  parseAgentGraphHandle,
  parseAgentSqlHandle,
  parseAgentSymbolHandle,
} from "../agent/handles.js";
import type { BuildOptions } from "../indexer/types.js";
import { isAnalysisComplete } from "../analysis-summary.js";
import { errorMessage } from "../util/errors.js";
import { isPlainRecord } from "../util/guards.js";
import { fileIdentityKey, isFilePathWithinRoot } from "../util/paths.js";
import { getCodegraphVersion } from "../util/package-info.js";
import { mapLimit } from "../util/concurrency.js";
import { assertMcpRootScope } from "./root-preflight.js";
import { ensureSharedOwner, type SharedOwnerOptions } from "./shared-owner.js";
import { awaitStdioMcpLifecycle, DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS } from "./stdio-lifecycle.js";
import { createCodegraphMcpStdioTransport } from "./stdio-transport.js";
import { DEFAULT_MCP_TOOL_CONCURRENCY } from "./runtime-limits.js";
import { listCodegraphMcpTools, MCP_TOOL_REGISTRY } from "./tools.js";
import { loadWorkspaceMcpConfig, type WorkspaceMcpConfig, type WorkspaceProject } from "./workspace-config.js";

const WORKSPACE_TOOL_CONCURRENCY = 2;
const PROJECT_QUALIFIER_PREFIX = "cgws1:";
type OwnerOptionsWithoutRoot = Omit<SharedOwnerOptions, "root">;
type WorkspaceProjectCall = (
  project: WorkspaceProject,
  toolName: string,
  arguments_: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

type WorkspaceOwnerClient = {
  client: Client;
};
type WorkspaceOwnerConnection = {
  promise: Promise<WorkspaceOwnerClient>;
  activeCalls: number;
  retired: boolean;
  closePromise?: Promise<void>;
};

type ProjectSummary = Pick<WorkspaceProject, "id" | "path" | "aliases">;
type ProjectCoverage = {
  state: "complete" | "partial" | "pending" | "failed";
  freshness: Record<string, unknown>;
  omittedCounts: Record<string, number>;
};

type WorkspaceQualifiedValue = {
  projectId: string;
  value: string;
};

function withProjectSelector(tool: Tool): Tool {
  const properties = tool.inputSchema.properties ?? {};
  const description =
    tool.name === "search" || tool.name === "workspace_symbols"
      ? `${tool.description} In workspace mode, omit project to query every configured project, or set project to select one.`
      : `${tool.description} In workspace mode, select project or provide a project-qualified handle or path.`;
  return {
    ...tool,
    description,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...properties,
        project: {
          type: "string",
          description:
            "Configured project id. Omit only for workspace search fan-out or use a project-qualified value.",
        },
      },
    },
  };
}

const WORKSPACE_PROJECTS_TOOL: Tool = {
  name: "workspace_projects",
  description:
    "List configured workspace projects and only the dependency relationships explicitly declared in the workspace config.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
};

function listWorkspaceTools(): Tool[] {
  return [...listCodegraphMcpTools().map(withProjectSelector), WORKSPACE_PROJECTS_TOOL];
}

export function qualifyWorkspaceValue(projectId: string, value: string): string {
  // Preserve all JavaScript string code units so project ids round-trip exactly.
  return `${PROJECT_QUALIFIER_PREFIX}${Buffer.from(projectId, "utf16le").toString("base64url")}::${value}`;
}

export function parseWorkspaceQualifiedValue(value: string): WorkspaceQualifiedValue | undefined {
  if (!value.startsWith(PROJECT_QUALIFIER_PREFIX)) return undefined;
  const separator = value.indexOf("::", PROJECT_QUALIFIER_PREFIX.length);
  if (separator < 0) throw new Error("Malformed project-qualified value.");
  const encodedId = value.slice(PROJECT_QUALIFIER_PREFIX.length, separator);
  const decodedId = Buffer.from(encodedId, "base64url").toString("utf16le");
  if (!encodedId || Buffer.from(decodedId, "utf16le").toString("base64url") !== encodedId) {
    throw new Error("Malformed project-qualified project id.");
  }
  const payload = value.slice(separator + 2);
  if (!payload) throw new Error("A project-qualified value cannot be empty.");
  return { projectId: decodedId, value: payload };
}

function summaryForProject(project: WorkspaceProject): ProjectSummary {
  return { id: project.id, path: project.path, aliases: [...project.aliases] };
}

function listWorkspaceProjects(config: WorkspaceMcpConfig): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projects: config.projects.map(summaryForProject),
    dependencies: config.dependencies.map((dependency) => ({
      from: dependency.from,
      to: dependency.to,
      evidence: {
        source: "workspace-config",
        relationship: "explicitly-configured",
        configuredFrom: dependency.configuredFrom,
        configuredTo: dependency.configuredTo,
      },
    })),
    freshness: { state: "configuration-only", queried: false },
  };
}

function getRouteFields(toolName: string): string[] {
  const fields = ["handle", "file", "fileGlob", "target", "from", "to", "outDir"];
  if (toolName === "orient") fields.push("includeRoots");
  return fields;
}

function routeArguments(
  config: WorkspaceMcpConfig,
  toolName: string,
  sourceArguments: Record<string, unknown>,
): { projects: WorkspaceProject[]; arguments_: Record<string, unknown> } {
  const arguments_ = { ...sourceArguments };
  const explicitId = arguments_.project;
  delete arguments_.project;
  let selectedProject = typeof explicitId === "string" ? resolveProject(config, explicitId) : undefined;
  if (explicitId !== undefined && typeof explicitId !== "string") {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Workspace project must be a project id string.");
  }
  if (typeof explicitId === "string" && !selectedProject) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown workspace project: ${explicitId}.`);
  }

  const selectQualifiedProject = (projectId: string): WorkspaceProject => {
    const project = resolveProject(config, projectId);
    if (!project) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Unknown workspace project in qualified value: ${projectId}.`,
      );
    }
    if (selectedProject && selectedProject.id !== project.id) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        `Workspace project '${selectedProject.id}' does not match qualified value for '${project.id}'.`,
      );
    }
    selectedProject = project;
    return project;
  };

  for (const field of getRouteFields(toolName)) {
    const value = arguments_[field];
    if (typeof value === "string") {
      let qualified: WorkspaceQualifiedValue | undefined;
      try {
        qualified = parseWorkspaceQualifiedValue(value);
      } catch (error) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, errorMessage(error));
      }
      if (qualified) {
        selectQualifiedProject(qualified.projectId);
        arguments_[field] = qualified.value;
      }
      continue;
    }
    if (field === "includeRoots" && Array.isArray(value)) {
      arguments_[field] = value.map((entry) => {
        if (typeof entry !== "string") return entry;
        let qualified: WorkspaceQualifiedValue | undefined;
        try {
          qualified = parseWorkspaceQualifiedValue(entry);
        } catch (error) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, errorMessage(error));
        }
        if (!qualified) return entry;
        selectQualifiedProject(qualified.projectId);
        return qualified.value;
      });
    }
  }

  const canFanOut = toolName === "search" || toolName === "workspace_symbols";
  if (!selectedProject && !canFanOut) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      `Workspace tool '${toolName}' requires a project id or a project-qualified handle or path.`,
    );
  }
  const projects = selectedProject ? [selectedProject] : config.projects;
  return { projects, arguments_ };
}

function resolveProject(config: WorkspaceMcpConfig, projectId: string): WorkspaceProject | undefined {
  return config.aliases.get(projectId);
}

function isPortableHandle(value: string): boolean {
  return /^(?:symbol|file|chunk|graph|sql):/.test(value);
}

function assertProjectRelativePath(project: WorkspaceProject, value: string): void {
  if (!value) return;
  if (isPortableHandle(value)) {
    const handle =
      parseAgentSymbolHandle(value) ??
      parseAgentFileHandle(value) ??
      parseAgentChunkHandle(value) ??
      parseAgentGraphHandle(value) ??
      parseAgentSqlHandle(value);
    if (handle) assertRelativePath(project, handle.file);
    return;
  }
  assertRelativePath(project, value);
}

function assertRelativePath(project: WorkspaceProject, fileValue: string): void {
  const normalized = fileValue.replace(/\\/g, "/");
  if (
    path.isAbsolute(fileValue) ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.startsWith("//")
  ) {
    throw new Error("Project paths must be relative to the selected project root.");
  }
  const candidate = path.resolve(project.root, ...normalized.split("/"));
  if (!isFilePathWithinRoot(project.root, candidate)) {
    throw new Error("Project path escapes the selected project root.");
  }
}

async function assertWorkspaceProjectRoot(config: WorkspaceMcpConfig, project: WorkspaceProject): Promise<void> {
  const workspaceRoot = await fs.realpath(config.logicalRoot);
  const projectRoot = await fs.realpath(path.resolve(config.logicalRoot, project.path));
  if (
    fileIdentityKey(workspaceRoot) !== fileIdentityKey(config.root) ||
    fileIdentityKey(projectRoot) !== fileIdentityKey(project.root) ||
    !isFilePathWithinRoot(workspaceRoot, projectRoot)
  ) {
    throw new Error("Workspace project root changed or escaped the workspace; reload the workspace configuration.");
  }
}

function validateProjectPaths(project: WorkspaceProject, toolName: string, arguments_: Record<string, unknown>): void {
  const values: string[] = [];
  if (typeof arguments_.fileGlob === "string" && toolName === "workspace_symbols") {
    values.push(arguments_.fileGlob);
  }
  if (typeof arguments_.handle === "string") values.push(arguments_.handle);
  if (typeof arguments_.file === "string") values.push(arguments_.file);
  if (typeof arguments_.from === "string" && (toolName === "path" || toolName === "search")) {
    values.push(arguments_.from);
  }
  if (typeof arguments_.to === "string" && toolName === "path") values.push(arguments_.to);
  if (typeof arguments_.target === "string" && toolName === "packet_get") values.push(arguments_.target);
  if (typeof arguments_.outDir === "string" && toolName === "artifact_build") values.push(arguments_.outDir);
  if (toolName === "orient" && Array.isArray(arguments_.includeRoots)) {
    for (const value of arguments_.includeRoots) {
      if (typeof value === "string") values.push(value);
    }
  }
  for (const value of values) {
    if (!isPortableHandle(value) && !value.includes("/") && !value.includes("\\") && !value.startsWith(".")) continue;
    assertProjectRelativePath(project, value);
  }
}

function qualifyHandles(value: unknown, projectId: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => qualifyHandles(entry, projectId));
  if (!isPlainRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" &&
      (key === "handle" || key.endsWith("Handle") || (key === "target" && isPortableHandle(entry)))
    ) {
      result[key] = qualifyWorkspaceValue(projectId, entry);
    } else if (key === "followUps" && Array.isArray(entry)) {
      result[key] = entry.map((followUp) => {
        const qualified = qualifyHandles(followUp, projectId);
        if (
          isPlainRecord(qualified) &&
          typeof qualified.tool === "string" &&
          MCP_TOOL_REGISTRY.some((tool) => tool.name === qualified.tool) &&
          isPlainRecord(qualified.arguments)
        ) {
          qualified.arguments = { ...qualified.arguments, project: projectId };
        }
        return qualified;
      });
    } else {
      result[key] = qualifyHandles(entry, projectId);
    }
  }
  return result;
}

function readFreshness(value: unknown): Record<string, unknown> {
  if (isPlainRecord(value) && isPlainRecord(value.freshness)) return value.freshness;
  return { state: "not-reported" };
}

function readOmittedCounts(value: unknown): Record<string, number> {
  if (!isPlainRecord(value) || !isPlainRecord(value.omittedCounts)) return {};
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value.omittedCounts)) {
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) counts[key] = count;
  }
  return counts;
}

function getProjectCoverage(value: unknown): ProjectCoverage {
  const freshness = readFreshness(value);
  const omittedCounts = readOmittedCounts(value);
  const pending = isPlainRecord(value) && value.status === "index_building";
  const unknownFreshness = freshness.state !== "fresh" && freshness.state !== "refreshed";
  const hasOmissions = Object.values(omittedCounts).some((count) => count > 0);
  const bounded =
    isPlainRecord(value) &&
    (Boolean(value.truncated) ||
      (typeof value.omitted === "number" && value.omitted > 0) ||
      (isPlainRecord(value.referenceCoverage) && value.referenceCoverage.state !== "complete"));
  const analysis = isPlainRecord(value) ? value.analysis : undefined;
  const incompleteAnalysis =
    isPlainRecord(analysis) &&
    (typeof analysis.parserDegradedFiles !== "number" ||
      typeof analysis.nativeFilesFellBack !== "number" ||
      !isAnalysisComplete({
        parserDegradedFiles: analysis.parserDegradedFiles,
        nativeFilesFellBack: analysis.nativeFilesFellBack,
      }));
  let state: ProjectCoverage["state"] = "complete";
  if (pending) state = "pending";
  else if (unknownFreshness || hasOmissions || bounded || incompleteAnalysis) state = "partial";
  return {
    state,
    freshness,
    omittedCounts,
  };
}

function failedProjectCoverage(): ProjectCoverage {
  return { state: "failed", freshness: { state: "unavailable" }, omittedCounts: {} };
}

function errorText(error: unknown): string {
  const message = errorMessage(error);
  return message.replace(/(?:[A-Za-z]:)?[/\\][^'"\n]*?(?=(?:[/\\][^'"\n]*)?['"]|$)/g, "<path>");
}

export async function dispatchWorkspaceTool(
  config: WorkspaceMcpConfig,
  toolName: string,
  input: unknown,
  callProjectTool: WorkspaceProjectCall,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (!isPlainRecord(input)) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Workspace tool arguments must be an object.");
  }
  if (toolName === "workspace_projects") {
    if (Object.keys(input).length) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "workspace_projects does not accept arguments.");
    }
    return listWorkspaceProjects(config);
  }
  if (!MCP_TOOL_REGISTRY.some((tool) => tool.name === toolName)) {
    throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown MCP tool: ${toolName}.`);
  }
  const route = routeArguments(config, toolName, input);
  const projectResults = await mapLimit(route.projects, WORKSPACE_TOOL_CONCURRENCY, async (project) => {
    if (signal?.aborted) throw signal.reason ?? new Error("Workspace tool call was cancelled.");
    try {
      await assertWorkspaceProjectRoot(config, project);
      validateProjectPaths(project, toolName, route.arguments_);
      const result = await callProjectTool(project, toolName, route.arguments_, signal);
      const coverage = getProjectCoverage(result);
      const status = coverage.state === "pending" ? ("index_building" as const) : ("ok" as const);
      const qualified = qualifyHandles(result, project.id);
      if (
        isPlainRecord(qualified) &&
        typeof qualified.root === "string" &&
        fileIdentityKey(qualified.root) === fileIdentityKey(project.root)
      ) {
        qualified.root = path.resolve(config.logicalRoot, project.path);
      }
      return {
        project: summaryForProject(project),
        status,
        result: qualified,
        coverage,
      };
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      return {
        project: summaryForProject(project),
        status: "error" as const,
        error: errorText(error),
        coverage: failedProjectCoverage(),
      };
    }
  });
  const errors = projectResults.flatMap((result) =>
    result.status === "error" ? [{ project: result.project, error: result.error }] : [],
  );
  const completedProjects = projectResults.filter((result) => result.status === "ok").length;
  const complete =
    !errors.length && projectResults.every((result) => result.status === "ok" && result.coverage.state === "complete");
  return {
    schemaVersion: 1,
    tool: toolName,
    projects: projectResults,
    errors,
    coverage: {
      selectedProjects: projectResults.length,
      completedProjects,
      failedProjects: errors.length,
      complete,
    },
  };
}

class WorkspaceOwnerToolError extends Error {}

function isMcpProtocolError(error: unknown): boolean {
  return error instanceof ProtocolError || (isPlainRecord(error) && typeof error.code === "number");
}
function parseOwnerToolResult(result: CallToolResult): unknown {
  const text = result.content.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");
  if (result.isError) throw new WorkspaceOwnerToolError(text || "The project MCP owner returned a tool error.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("The project MCP owner returned a non-JSON tool result.");
  }
}

async function rebindDiscoveryRootOptions(
  ownerOptions: OwnerOptionsWithoutRoot,
  projectRoot: string,
  workspaceRoot: string,
  physicalWorkspaceRoot: string,
): Promise<OwnerOptionsWithoutRoot> {
  const buildOptions = ownerOptions.buildOptions;
  const discovery = buildOptions?.discovery;
  if (!buildOptions || !discovery) return ownerOptions;

  const isWorkspaceRoot = async (value: string | undefined): Promise<boolean> => {
    if (!value) return false;
    const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(workspaceRoot, value);
    const candidateKey = fileIdentityKey(candidate);
    if (candidateKey === fileIdentityKey(workspaceRoot) || candidateKey === fileIdentityKey(physicalWorkspaceRoot)) {
      return true;
    }
    try {
      return fileIdentityKey(await fs.realpath(candidate)) === fileIdentityKey(physicalWorkspaceRoot);
    } catch {
      return false;
    }
  };

  const globRootMatches = await isWorkspaceRoot(discovery.globRoot);
  const gitignoreRootMatches = await isWorkspaceRoot(discovery.gitignoreRoot);
  if (!globRootMatches && !gitignoreRootMatches) return ownerOptions;
  return {
    ...ownerOptions,
    buildOptions: {
      ...buildOptions,
      discovery: {
        ...discovery,
        ...(globRootMatches ? { globRoot: projectRoot } : {}),
        ...(gitignoreRootMatches ? { gitignoreRoot: projectRoot } : {}),
      },
    },
  };
}

export async function serveWorkspaceMcp(options: {
  root: string;
  configPath: string;
  ownerOptions: OwnerOptionsWithoutRoot;
  projectBuildOptions?: (root: string) => Promise<BuildOptions>;
  idleTimeoutMs?: number;
}): Promise<void> {
  const config = await loadWorkspaceMcpConfig(options.root, options.configPath);
  const workspaceRoot = path.resolve(options.root);
  const clients = new Map<string, WorkspaceOwnerConnection>();
  const allConnections = new Set<WorkspaceOwnerConnection>();
  const activeCalls = new Map<string | number, { operation: Promise<unknown>; controller: AbortController }>();
  let accepting = true;

  const closeConnection = (connection: WorkspaceOwnerConnection): Promise<void> => {
    connection.closePromise ??= connection.promise
      .then(async (owner) => {
        await owner.client.close().catch(() => undefined);
      })
      .catch(() => undefined)
      .finally(() => allConnections.delete(connection));
    return connection.closePromise;
  };

  const retireConnection = (projectId: string, connection: WorkspaceOwnerConnection): void => {
    if (clients.get(projectId) === connection) clients.delete(projectId);
    connection.retired = true;
    if (!connection.activeCalls) void closeConnection(connection);
  };

  const createConnection = (project: WorkspaceProject): WorkspaceOwnerConnection => {
    const deferred = Promise.withResolvers<WorkspaceOwnerClient>();
    const connection: WorkspaceOwnerConnection = {
      promise: deferred.promise,
      activeCalls: 0,
      retired: false,
    };
    clients.set(project.id, connection);
    allConnections.add(connection);
    const start = async (): Promise<WorkspaceOwnerClient> => {
      await assertWorkspaceProjectRoot(config, project);
      await assertMcpRootScope(project.root);
      let perProjectOptions = options.ownerOptions;
      if (options.projectBuildOptions) {
        const buildOptions = { ...(await options.projectBuildOptions(project.root)) };
        delete buildOptions.onProgress;
        perProjectOptions = { ...options.ownerOptions, buildOptions };
      } else {
        perProjectOptions = await rebindDiscoveryRootOptions(
          options.ownerOptions,
          project.root,
          workspaceRoot,
          config.root,
        );
      }
      const owner = await ensureSharedOwner({ ...perProjectOptions, root: project.root });
      const client = new Client(
        { name: "codegraph-workspace-router", version: getCodegraphVersion() },
        { versionNegotiation: { mode: "auto" } },
      );
      const transport = new StreamableHTTPClientTransport(new URL(owner.url));
      try {
        await client.connect(transport);
        return { client };
      } catch (error) {
        await client.close().catch(() => undefined);
        throw error;
      }
    };
    void start().then(deferred.resolve, deferred.reject);
    void deferred.promise.catch(() => {
      if (clients.get(project.id) === connection) clients.delete(project.id);
      allConnections.delete(connection);
    });
    return connection;
  };

  const getConnection = (project: WorkspaceProject): WorkspaceOwnerConnection =>
    clients.get(project.id) ?? createConnection(project);

  const callProjectTool: WorkspaceProjectCall = async (project, toolName, arguments_, signal) => {
    const connection = getConnection(project);
    connection.activeCalls += 1;
    try {
      let owner: WorkspaceOwnerClient;
      try {
        owner = await connection.promise;
      } catch (error) {
        retireConnection(project.id, connection);
        throw new Error(
          `Could not connect to the MCP owner for workspace project '${project.id}': ${errorText(error)}. Retry this project call; no tool call was sent.`,
        );
      }
      try {
        const result = await owner.client.callTool(
          { name: toolName, arguments: arguments_ },
          { ...(signal ? { signal } : {}), timeout: 2_147_483_647 },
        );
        return parseOwnerToolResult(result);
      } catch (error) {
        if (!signal?.aborted && !(error instanceof WorkspaceOwnerToolError) && !isMcpProtocolError(error)) {
          retireConnection(project.id, connection);
          throw new Error(
            `MCP owner request for workspace project '${project.id}' failed: ${errorText(error)}. The tool was not automatically replayed; retry explicitly only if safe.`,
          );
        }
        throw error;
      }
    } finally {
      connection.activeCalls -= 1;
      if (connection.retired && !connection.activeCalls) await closeConnection(connection);
    }
  };

  const createProtocolServer = (): Server => {
    const server = new Server(
      { name: "codegraph-workspace", version: getCodegraphVersion() },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", () => ({ tools: listWorkspaceTools() }));
    server.setNotificationHandler("notifications/cancelled", (notification) => {
      const requestId = notification.params.requestId;
      if (requestId !== undefined) {
        activeCalls.get(requestId)?.controller.abort(new Error("Workspace MCP call was cancelled."));
      }
    });
    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
      if (!accepting) throw new Error("Workspace MCP server is shutting down.");
      if (activeCalls.size >= DEFAULT_MCP_TOOL_CONCURRENCY) {
        throw new Error("MCP tool execution is busy; retry shortly.");
      }
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, context.mcpReq.signal]);
      const operation = dispatchWorkspaceTool(
        config,
        request.params.name,
        request.params.arguments ?? {},
        callProjectTool,
        signal,
      );
      activeCalls.set(context.mcpReq.id, { operation, controller });
      try {
        const result = await operation;
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } finally {
        activeCalls.delete(context.mcpReq.id);
      }
    });
    return server;
  };

  const transport = createCodegraphMcpStdioTransport(process.stdin, process.stdout);
  const handle = serveStdio(createProtocolServer, {
    transport,
    legacy: "serve",
    onerror: (error) => {
      console.error(`[codegraph] workspace MCP stdio error: ${error.message}`);
    },
  });
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_MCP_STDIO_IDLE_TIMEOUT_MS;
  try {
    await awaitStdioMcpLifecycle(handle, { idleTimeoutMs });
  } finally {
    accepting = false;
    for (const call of activeCalls.values()) call.controller.abort(new Error("Workspace MCP connection closed."));
    await Promise.allSettled([...activeCalls.values()].map((call) => call.operation));
    const connections = [...allConnections];
    for (const connection of connections) connection.retired = true;
    await Promise.allSettled(connections.map(closeConnection));
  }
}
