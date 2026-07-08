import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSkillTargetDirForAgent, type SkillInstallAgent } from "../cli/skill.js";
import { getCodegraphPackageRoot, normalizePathForDisplay, pathExists } from "../cli/packageInfo.js";

export type InstallTargetId = SkillInstallAgent;

export type TargetDetection = {
  detected: boolean;
  reason: string;
  configPath?: string;
  skillTargetDir: string;
};

export type InstallOptions = {
  targetIds?: InstallTargetId[];
  yes?: boolean;
  dryRun?: boolean;
  homeDir?: string;
  env?: Record<string, string | undefined>;
};

export type PrintConfigOptions = {
  targetId: InstallTargetId;
  homeDir?: string;
  env?: Record<string, string | undefined>;
};

export type UninstallOptions = InstallOptions;

export type InstallChange = {
  target: InstallTargetId;
  action: "create" | "update" | "delete" | "unchanged";
  path: string;
  dryRun: boolean;
};

export type InstallResult = {
  installed: boolean;
  dryRun: boolean;
  targets: InstallTargetId[];
  changes: InstallChange[];
};

export type UninstallResult = {
  uninstalled: boolean;
  dryRun: boolean;
  targets: InstallTargetId[];
  changes: InstallChange[];
};

export type InstallTarget = {
  id: InstallTargetId;
  label: string;
  detect(options?: InstallOptions): Promise<TargetDetection>;
  printConfig(options?: PrintConfigOptions): string;
  install(options?: InstallOptions): Promise<InstallResult>;
  uninstall(options?: UninstallOptions): Promise<UninstallResult>;
};

type ConfigKind = "toml-block" | "json-mcp-servers" | "json-opencode-mcp" | "skill-only";

type TargetDefinition = {
  id: InstallTargetId;
  label: string;
  kind: ConfigKind;
  configPath?: (settings: InstallerSettings) => string;
};

type InstallerSettings = {
  homeDir: string;
  env: Record<string, string | undefined>;
};

type JsonRecord = Record<string, unknown>;

const TARGET_DEFINITIONS: TargetDefinition[] = [
  {
    id: "codex",
    label: "Codex CLI",
    kind: "toml-block",
    configPath: ({ homeDir }) => path.join(homeDir, ".codex", "config.toml"),
  },
  {
    id: "claude",
    label: "Claude Code",
    kind: "json-mcp-servers",
    configPath: ({ homeDir }) => path.join(homeDir, ".claude", "mcp.json"),
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "json-mcp-servers",
    configPath: ({ homeDir }) => path.join(homeDir, ".cursor", "mcp.json"),
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    kind: "json-mcp-servers",
    configPath: ({ homeDir }) => path.join(homeDir, ".gemini", "settings.json"),
  },
  {
    id: "opencode",
    label: "OpenCode",
    kind: "json-opencode-mcp",
    configPath: (settings) => path.join(opencodeConfigHome(settings), "opencode", "opencode.json"),
  },
  {
    id: "agents",
    label: "Agents skill directory",
    kind: "skill-only",
  },
];

const CODEGRAPH_TOML_MARKER_BEGIN = "# >>> codegraph mcp >>>";
const CODEGRAPH_TOML_MARKER_END = "# <<< codegraph mcp <<<";
const DEFAULT_TARGET_IDS = TARGET_DEFINITIONS.map((target) => target.id);

export function listInstallTargets(): InstallTarget[] {
  return TARGET_DEFINITIONS.map(createInstallTarget);
}

export function parseInstallTargetIds(rawValue: string | undefined): InstallTargetId[] | undefined {
  if (rawValue === undefined) return undefined;
  const ids: InstallTargetId[] = [];
  for (const part of rawValue.split(",")) {
    const value = part.trim();
    if (!value) continue;
    ids.push(parseInstallTargetId(value));
  }
  if (!ids.length) {
    throw new Error("--target must name at least one install target.");
  }
  return [...new Set(ids)];
}

export function parseInstallTargetId(value: string): InstallTargetId {
  if (isInstallTargetId(value)) return value;
  throw new Error(`Unknown install target "${value}". Expected ${DEFAULT_TARGET_IDS.join(", ")}.`);
}

export async function detectInstallTargets(options: InstallOptions = {}): Promise<TargetDetection[]> {
  return await Promise.all(listInstallTargets().map(async (target) => await target.detect(options)));
}

export function printInstallConfig(options: PrintConfigOptions): string {
  const target = createInstallTarget(definitionForTarget(options.targetId));
  return target.printConfig(options);
}

export async function installCodegraphTargets(options: InstallOptions = {}): Promise<InstallResult> {
  assertWriteAllowed(options);
  const targets = await resolveRequestedTargets(options);
  const changes: InstallChange[] = [];
  for (const target of targets) {
    const result = await target.install(options);
    changes.push(...result.changes);
  }
  return {
    installed: changes.some((change) => change.action === "create" || change.action === "update"),
    dryRun: options.dryRun ?? false,
    targets: targets.map((target) => target.id),
    changes,
  };
}

export async function uninstallCodegraphTargets(options: UninstallOptions = {}): Promise<UninstallResult> {
  assertWriteAllowed(options);
  const targets = await resolveRequestedTargets(options);
  const changes: InstallChange[] = [];
  for (const target of targets) {
    const result = await target.uninstall(options);
    changes.push(...result.changes);
  }
  return {
    uninstalled: changes.some((change) => change.action === "delete" || change.action === "update"),
    dryRun: options.dryRun ?? false,
    targets: targets.map((target) => target.id),
    changes,
  };
}

function createInstallTarget(definition: TargetDefinition): InstallTarget {
  return {
    id: definition.id,
    label: definition.label,
    detect: (options = {}) => Promise.resolve(detectTarget(definition, options)),
    printConfig: (options = { targetId: definition.id }) => printTargetConfig(definition, options),
    install: async (options = {}) => await installTarget(definition, options),
    uninstall: async (options = {}) => await uninstallTarget(definition, options),
  };
}

async function resolveRequestedTargets(options: InstallOptions): Promise<InstallTarget[]> {
  if (options.targetIds?.length) {
    return options.targetIds.map((id) => createInstallTarget(definitionForTarget(id)));
  }
  const targets = listInstallTargets();
  const detections = await Promise.all(targets.map(async (target) => await target.detect(options)));
  const detectedTargets: InstallTarget[] = [];
  for (const [index, target] of targets.entries()) {
    const detection = detections[index];
    if (detection?.detected) detectedTargets.push(target);
  }
  return detectedTargets;
}

function assertWriteAllowed(options: InstallOptions): void {
  if (options.dryRun) return;
  if (options.yes) return;
  throw new Error("Writes require --yes. Use --dry-run to inspect changes first.");
}

function detectTarget(definition: TargetDefinition, options: InstallOptions): TargetDetection {
  const settings = installerSettings(options);
  const configPath = definition.configPath?.(settings);
  const skillTargetDir = getSkillTargetDirForAgent(definition.id, settings.homeDir, settings.env);
  if (configPath !== undefined && pathExists(path.dirname(configPath))) {
    return {
      detected: true,
      reason: `${definition.label} config directory exists`,
      configPath: normalizePathForDisplay(configPath),
      skillTargetDir: normalizePathForDisplay(skillTargetDir),
    };
  }
  if (pathExists(path.dirname(skillTargetDir))) {
    return {
      detected: true,
      reason: `${definition.label} skill directory exists`,
      ...(configPath !== undefined ? { configPath: normalizePathForDisplay(configPath) } : {}),
      skillTargetDir: normalizePathForDisplay(skillTargetDir),
    };
  }
  return {
    detected: definition.kind === "skill-only" && pathExists(path.dirname(path.dirname(skillTargetDir))),
    reason: `${definition.label} was not detected`,
    ...(configPath !== undefined ? { configPath: normalizePathForDisplay(configPath) } : {}),
    skillTargetDir: normalizePathForDisplay(skillTargetDir),
  };
}

async function installTarget(definition: TargetDefinition, options: InstallOptions): Promise<InstallResult> {
  const settings = installerSettings(options);
  const dryRun = options.dryRun ?? false;
  const changes: InstallChange[] = [];
  const skillTargetDir = getSkillTargetDirForAgent(definition.id, settings.homeDir, settings.env);
  changes.push(await upsertSkillPayload(definition, skillTargetDir, dryRun));
  changes.push(await upsertSkillPointer(definition, skillTargetDir, dryRun));
  if (definition.kind !== "skill-only") {
    const configPath = requireConfigPath(definition, settings);
    changes.push(await upsertConfig(definition, configPath, dryRun));
  }
  return { installed: true, dryRun, targets: [definition.id], changes };
}

async function uninstallTarget(definition: TargetDefinition, options: UninstallOptions): Promise<UninstallResult> {
  const settings = installerSettings(options);
  const dryRun = options.dryRun ?? false;
  const changes: InstallChange[] = [];
  const skillTargetDir = getSkillTargetDirForAgent(definition.id, settings.homeDir, settings.env);
  changes.push(await removeSkillPayload(definition, skillTargetDir, dryRun));
  changes.push(await removeSkillPointer(definition, skillTargetDir, dryRun));
  if (definition.kind !== "skill-only") {
    const configPath = requireConfigPath(definition, settings);
    changes.push(await removeConfig(definition, configPath, dryRun));
  }
  return { uninstalled: true, dryRun, targets: [definition.id], changes };
}

async function upsertSkillPayload(
  definition: TargetDefinition,
  skillTargetDir: string,
  dryRun: boolean,
): Promise<InstallChange> {
  const bundledSkillPath = bundledSkillFilePath();
  const targetSkillPath = path.join(skillTargetDir, "SKILL.md");
  const bundledSkill = await fsp.readFile(bundledSkillPath, "utf8");
  const existing = await readOptionalFile(targetSkillPath);
  if (existing === bundledSkill) return change(definition.id, "unchanged", targetSkillPath, dryRun);
  if (!dryRun) {
    await fsp.mkdir(skillTargetDir, { recursive: true });
    await fsp.writeFile(targetSkillPath, bundledSkill, "utf8");
  }
  return change(definition.id, existing === null ? "create" : "update", targetSkillPath, dryRun);
}

async function upsertSkillPointer(
  definition: TargetDefinition,
  skillTargetDir: string,
  dryRun: boolean,
): Promise<InstallChange> {
  const markerPath = path.join(skillTargetDir, "CODEGRAPH_INSTALLED");
  const content = `Installed by codegraph install for ${definition.label}.\nRun codegraph skill install --agent ${definition.id} --force to refresh bundled skill files.\n`;
  const existing = await readOptionalFile(markerPath);
  if (existing === content) return change(definition.id, "unchanged", markerPath, dryRun);
  if (!dryRun) {
    await fsp.mkdir(skillTargetDir, { recursive: true });
    await fsp.writeFile(markerPath, content, "utf8");
  }
  return change(definition.id, existing === null ? "create" : "update", markerPath, dryRun);
}

async function removeSkillPayload(
  definition: TargetDefinition,
  skillTargetDir: string,
  dryRun: boolean,
): Promise<InstallChange> {
  const markerPath = path.join(skillTargetDir, "CODEGRAPH_INSTALLED");
  const targetSkillPath = path.join(skillTargetDir, "SKILL.md");
  const markerExists = await pathExistsUnlessMissing(markerPath);
  if (!markerExists) return change(definition.id, "unchanged", targetSkillPath, dryRun);
  const existing = await readOptionalFile(targetSkillPath);
  if (existing === null) return change(definition.id, "unchanged", targetSkillPath, dryRun);
  const bundledSkill = await fsp.readFile(bundledSkillFilePath(), "utf8");
  if (existing !== bundledSkill) return change(definition.id, "unchanged", targetSkillPath, dryRun);
  if (!dryRun) await fsp.rm(targetSkillPath, { force: true });
  return change(definition.id, "delete", targetSkillPath, dryRun);
}

async function removeSkillPointer(
  definition: TargetDefinition,
  skillTargetDir: string,
  dryRun: boolean,
): Promise<InstallChange> {
  const markerPath = path.join(skillTargetDir, "CODEGRAPH_INSTALLED");
  const markerExists = await pathExistsUnlessMissing(markerPath);
  if (!markerExists) return change(definition.id, "unchanged", markerPath, dryRun);
  if (!dryRun) await fsp.rm(markerPath, { force: true });
  return change(definition.id, "delete", markerPath, dryRun);
}

async function upsertConfig(definition: TargetDefinition, configPath: string, dryRun: boolean): Promise<InstallChange> {
  const existing = await readOptionalFile(configPath);
  const next = renderConfigWithCodegraph(definition, existing, configPath);
  if (existing === next) return change(definition.id, "unchanged", configPath, dryRun);
  if (!dryRun) {
    await fsp.mkdir(path.dirname(configPath), { recursive: true });
    await fsp.writeFile(configPath, next, "utf8");
  }
  return change(definition.id, existing === null ? "create" : "update", configPath, dryRun);
}

async function removeConfig(definition: TargetDefinition, configPath: string, dryRun: boolean): Promise<InstallChange> {
  const existing = await readOptionalFile(configPath);
  if (existing === null) return change(definition.id, "unchanged", configPath, dryRun);
  const next = removeCodegraphConfig(definition, existing, configPath);
  if (existing === next) return change(definition.id, "unchanged", configPath, dryRun);
  const action = next.trim() ? "update" : "delete";
  if (!dryRun) {
    if (action === "delete") {
      await fsp.rm(configPath, { force: true });
    } else {
      await fsp.writeFile(configPath, next, "utf8");
    }
  }
  return change(definition.id, action, configPath, dryRun);
}

function renderConfigWithCodegraph(definition: TargetDefinition, existing: string | null, configPath: string): string {
  if (definition.kind === "toml-block") {
    return upsertMarkedTomlBlock(existing ?? "", codexTomlSnippet());
  }
  const parsed = parseConfigJson(existing, configPath);
  if (definition.kind === "json-opencode-mcp") {
    const mcp = readRecordProperty(parsed, "mcp");
    const desiredServer = codegraphJsonServer(definition);
    if (shouldPreserveExistingServer(mcp, desiredServer)) return existing ?? renderJsonConfig(parsed);
    mcp.codegraph = desiredServer;
    parsed.mcp = mcp;
  } else {
    const mcpServers = readRecordProperty(parsed, "mcpServers");
    const desiredServer = codegraphJsonServer(definition);
    if (shouldPreserveExistingServer(mcpServers, desiredServer)) return existing ?? renderJsonConfig(parsed);
    mcpServers.codegraph = desiredServer;
    parsed.mcpServers = mcpServers;
  }
  return renderJsonConfig(parsed);
}

function removeCodegraphConfig(definition: TargetDefinition, existing: string, configPath: string): string {
  if (definition.kind === "toml-block") {
    return removeMarkedTomlBlock(existing);
  }
  const parsed = parseConfigJson(existing, configPath);
  const property = definition.kind === "json-opencode-mcp" ? "mcp" : "mcpServers";
  const servers = readRecordProperty(parsed, property);
  const server = servers.codegraph;
  if (!isInstallerOwnedJsonServer(definition, server)) return existing;
  delete servers.codegraph;
  if (Object.keys(servers).length) {
    parsed[property] = servers;
  } else {
    delete parsed[property];
  }
  return renderJsonConfig(parsed);
}

function printTargetConfig(definition: TargetDefinition, options: PrintConfigOptions): string {
  const settings = installerSettings(options);
  const skillTargetDir = getSkillTargetDirForAgent(definition.id, settings.homeDir, settings.env);
  if (definition.kind === "toml-block") return codexTomlSnippet();
  if (definition.kind === "json-opencode-mcp") {
    return renderJsonConfig({ mcp: { codegraph: codegraphJsonServer(definition) } });
  }
  if (definition.kind === "skill-only") {
    return `codegraph skill install --agent ${definition.id} --target ${normalizePathForDisplay(skillTargetDir)}\n`;
  }
  return renderJsonConfig({ mcpServers: { codegraph: codegraphJsonServer(definition) } });
}

function codexTomlSnippet(): string {
  return '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["mcp", "serve", "--root", ".", "--stdio"]\nstartup_timeout_ms = 20000\n';
}

function upsertMarkedTomlBlock(existing: string, snippet: string): string {
  const block = `${CODEGRAPH_TOML_MARKER_BEGIN}\n${snippet.trimEnd()}\n${CODEGRAPH_TOML_MARKER_END}`;
  const withoutBlock = removeMarkedTomlBlock(existing).trimEnd();
  if (!withoutBlock) return `${block}\n`;
  return `${withoutBlock}\n\n${block}\n`;
}

function removeMarkedTomlBlock(existing: string): string {
  const begin = escapeRegExp(CODEGRAPH_TOML_MARKER_BEGIN);
  const end = escapeRegExp(CODEGRAPH_TOML_MARKER_END);
  const pattern = new RegExp(`\\n?${begin}[\\s\\S]*?${end}\\n?`, "g");
  return existing.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
}

function parseConfigJson(existing: string | null, configPath: string): JsonRecord {
  if (existing === null || !existing.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(existing);
    if (isJsonRecord(parsed)) return parsed;
  } catch (error) {
    throw new Error(
      `Unable to parse ${normalizePathForDisplay(configPath)} as JSON. Fix the file before running the installer.`,
      {
        cause: error,
      },
    );
  }
  throw new Error(`${normalizePathForDisplay(configPath)} must contain a JSON object.`);
}

function readRecordProperty(record: JsonRecord, property: string): JsonRecord {
  const value = record[property];
  if (value === undefined) return {};
  if (isJsonRecord(value)) return value;
  throw new Error(`Existing ${property} config must be a JSON object before codegraph can update it.`);
}

function renderJsonConfig(record: JsonRecord): string {
  if (!Object.keys(record).length) return "";
  return `${JSON.stringify(record, null, 2)}\n`;
}

function opencodeConfigHome(settings: InstallerSettings): string {
  const configHome = settings.env.XDG_CONFIG_HOME?.trim();
  return configHome || path.join(settings.homeDir, ".config");
}

function codegraphJsonServer(definition: TargetDefinition): JsonRecord {
  if (definition.kind === "json-opencode-mcp") {
    return {
      type: "local",
      enabled: true,
      command: ["codegraph", "mcp", "serve", "--root", ".", "--stdio"],
    };
  }
  return {
    type: "stdio",
    command: "codegraph",
    args: ["mcp", "serve", "--root", ".", "--stdio"],
  };
}

function shouldPreserveExistingServer(servers: JsonRecord, desiredServer: JsonRecord): boolean {
  const existingServer = servers.codegraph;
  if (existingServer === undefined) return false;
  return !jsonValueEquals(existingServer, desiredServer);
}

function isInstallerOwnedJsonServer(definition: TargetDefinition, value: unknown): boolean {
  return jsonValueEquals(value, codegraphJsonServer(definition));
}

function jsonValueEquals(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => jsonValueEquals(value, right[index]));
  }
  if (isJsonRecord(left) || isJsonRecord(right)) {
    if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of rightKeys) {
      if (!Object.prototype.hasOwnProperty.call(left, key)) return false;
      if (!jsonValueEquals(left[key], right[key])) return false;
    }
    return true;
  }
  return left === right;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function installerSettings(options: { homeDir?: string; env?: Record<string, string | undefined> }): InstallerSettings {
  return {
    homeDir: options.homeDir ?? os.homedir(),
    env: options.env ?? process.env,
  };
}

function requireConfigPath(definition: TargetDefinition, settings: InstallerSettings): string {
  const configPath = definition.configPath?.(settings);
  if (configPath === undefined) {
    throw new Error(`${definition.label} does not have an MCP config file target.`);
  }
  return configPath;
}

function bundledSkillFilePath(): string {
  return path.join(getCodegraphPackageRoot(), "codegraph-skill", "codegraph", "SKILL.md");
}

async function pathExistsUnlessMissing(filePath: string): Promise<boolean> {
  try {
    await fsp.stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function definitionForTarget(id: InstallTargetId): TargetDefinition {
  const definition = TARGET_DEFINITIONS.find((target) => target.id === id);
  if (!definition) throw new Error(`Unknown install target "${id}".`);
  return definition;
}

function isInstallTargetId(value: string): value is InstallTargetId {
  return DEFAULT_TARGET_IDS.includes(value as InstallTargetId);
}

function change(
  target: InstallTargetId,
  action: InstallChange["action"],
  filePath: string,
  dryRun: boolean,
): InstallChange {
  return {
    target,
    action,
    path: normalizePathForDisplay(filePath),
    dryRun,
  };
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
