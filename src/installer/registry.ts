import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { getSkillTargetDirForAgent, type SkillInstallAgent } from "../cli/skill.js";
import { getCodegraphPackageRoot, normalizePathForDisplay, pathExists } from "../util/packageInfo.js";
import { isFileSystemErrorCode } from "../util/errors.js";
import { waitForInstallerLockRetry, withInstallerLeaseLock, withInstallerTransactionLocks } from "./locks.js";

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
  force?: boolean;
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

export type InstallerCollisionKind = "user-owned-codegraph-entry" | "user-owned-codegraph-table" | "user-owned-skill";

export type InstallerCollision = {
  target: InstallTargetId;
  path: string;
  kind: InstallerCollisionKind;
};

export class InstallerCollisionError extends Error {
  readonly code = "installer-config-collision";
  readonly conflicts: readonly InstallerCollision[];

  constructor(conflicts: readonly InstallerCollision[]) {
    let message =
      `Codegraph installer found ${conflicts.length} user-owned configuration collisions. ` +
      "Resolve or rename the existing Codegraph entries before retrying.";
    const conflict = conflicts.length === 1 ? conflicts[0] : undefined;
    if (conflict) {
      if (conflict.kind === "user-owned-skill") {
        message =
          `User-owned skill already exists at ${conflict.path}. ` +
          "Re-run with --force to overwrite, or move that file aside before retrying.";
      } else {
        const entryType = conflict.kind === "user-owned-codegraph-table" ? "table" : "entry";
        message = `User-owned Codegraph MCP ${entryType} already exists. Remove or rename that entry before retrying.`;
      }
    } else {
      const skillPaths = conflicts
        .filter((candidate) => candidate.kind === "user-owned-skill")
        .map((candidate) => candidate.path);
      if (skillPaths.length) {
        message +=
          ` User-owned skill files exist at ${skillPaths.join(", ")}. ` +
          "Re-run with --force to overwrite them, or move those files aside before retrying.";
      }
    }
    super(message);
    this.name = "InstallerCollisionError";
    this.conflicts = conflicts;
  }
}

export type InstallResult = {
  installed: boolean;
  verified: boolean;
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

type ConfigKind =
  | "toml-block"
  | "json-mcp-servers"
  | "json-mcp-servers-no-type"
  | "json-opencode-mcp"
  | "json-kilo-mcp"
  | "skill-only";

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
type InstallerFileRole = "config" | "marker" | "skill";

type InstallFileSnapshot = {
  bytes: Buffer | null;
  mode: number | null;
};

type PlannedInstallFile = {
  target: InstallTargetId;
  role: InstallerFileRole;
  path: string;
  root: string;
  content: Buffer | null;
  snapshot: InstallFileSnapshot;
  change: InstallChange;
};

type InstallPlan = {
  files: readonly PlannedInstallFile[];
  changes: readonly InstallChange[];
};

type CodexTomlBlock = {
  beginIndex: number;
  endIndex: number;
};

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
    id: "omp",
    label: "Oh My Pi",
    kind: "json-mcp-servers-no-type",
    configPath: ({ homeDir }) => path.join(homeDir, ".omp", "agent", "mcp.json"),
  },
  {
    id: "kilo",
    label: "Kilo Code",
    kind: "json-kilo-mcp",
    configPath: (settings) => path.join(opencodeConfigHome(settings), "kilo", "kilo.jsonc"),
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
  return await installDefinitions(
    targets.map((target) => definitionForTarget(target.id)),
    options,
  );
}

export async function uninstallCodegraphTargets(options: UninstallOptions = {}): Promise<UninstallResult> {
  assertWriteAllowed(options);
  const targets = await resolveRequestedTargets(options);
  return await uninstallDefinitions(
    targets.map((target) => definitionForTarget(target.id)),
    options,
  );
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
  const baseSkillDirExists = definition.kind === "skill-only" && pathExists(path.dirname(path.dirname(skillTargetDir)));
  return {
    detected: baseSkillDirExists,
    reason: baseSkillDirExists ? `${definition.label} base directory exists` : `${definition.label} was not detected`,
    ...(configPath !== undefined ? { configPath: normalizePathForDisplay(configPath) } : {}),
    skillTargetDir: normalizePathForDisplay(skillTargetDir),
  };
}

async function installTarget(definition: TargetDefinition, options: InstallOptions): Promise<InstallResult> {
  assertWriteAllowed(options);
  return await installDefinitions([definition], options);
}

async function installDefinitions(
  definitions: readonly TargetDefinition[],
  options: InstallOptions,
): Promise<InstallResult> {
  const settings = installerSettings(options);
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const install = async (): Promise<InstallResult> => {
    const plan = await prepareInstallPlan(definitions, settings, dryRun, force);
    if (!dryRun) await applyInstallPlan(plan);
    return {
      installed: plan.changes.some((change) => change.action === "create" || change.action === "update"),
      verified: !dryRun,
      dryRun,
      targets: definitions.map((definition) => definition.id),
      changes: [...plan.changes],
    };
  };
  if (dryRun) return await install();
  return await withInstallerTransactionLocks(settings, install);
}

async function prepareInstallPlan(
  definitions: readonly TargetDefinition[],
  settings: InstallerSettings,
  dryRun: boolean,
  force: boolean,
): Promise<InstallPlan> {
  const bundledSkill = await fsp.readFile(bundledSkillFilePath());
  const files: PlannedInstallFile[] = [];
  const conflicts: InstallerCollision[] = [];
  for (const definition of definitions) {
    const skillTargetDir = getSkillTargetDirForAgent(definition.id, settings.homeDir, settings.env);
    const skillRoot = skillInstallRoot(definition, settings);
    const skillPath = path.join(skillTargetDir, "SKILL.md");
    const markerPath = path.join(skillTargetDir, "CODEGRAPH_INSTALLED");
    const skillSnapshot = await snapshotInstallFile(skillPath, skillRoot);
    const markerSnapshot = await snapshotInstallFile(markerPath, skillRoot);
    const skillCollision = findSkillCollision(
      definition,
      skillPath,
      skillSnapshot.bytes,
      markerSnapshot.bytes,
      bundledSkill,
    );
    if (skillCollision && !force) {
      conflicts.push(skillCollision);
      continue;
    }

    addPlannedInstallFile(
      files,
      createPlannedInstallFile(definition, "skill", skillPath, skillRoot, bundledSkill, skillSnapshot, dryRun),
    );

    const markerContent = Buffer.from(renderInstallMarker(definition, bundledSkill), "utf8");
    addPlannedInstallFile(
      files,
      createPlannedInstallFile(definition, "marker", markerPath, skillRoot, markerContent, markerSnapshot, dryRun),
    );

    if (definition.kind === "skill-only") continue;
    const configPath = requireConfigPath(definition, settings);
    const configRoot = configInstallRoot(definition, settings);
    const configSnapshot = await snapshotInstallFile(configPath, configRoot);
    const existingConfig = configSnapshot.bytes?.toString("utf8") ?? null;
    const collision = findConfigCollision(definition, configPath, existingConfig);
    if (collision) {
      conflicts.push(collision);
      continue;
    }
    const configContent = Buffer.from(renderConfigWithCodegraph(definition, existingConfig, configPath), "utf8");
    addPlannedInstallFile(
      files,
      createPlannedInstallFile(definition, "config", configPath, configRoot, configContent, configSnapshot, dryRun),
    );
  }
  if (conflicts.length) throw new InstallerCollisionError(conflicts);
  return {
    files,
    changes: files.map((file) => file.change),
  };
}

function skillInstallRoot(definition: TargetDefinition, settings: InstallerSettings): string {
  if (definition.id === "opencode") return opencodeConfigHome(settings);
  if (definition.id === "codex") return settings.env.CODEX_HOME?.trim() || settings.homeDir;
  return settings.homeDir;
}

function configInstallRoot(definition: TargetDefinition, settings: InstallerSettings): string {
  if (definition.id === "opencode" || definition.id === "kilo") return opencodeConfigHome(settings);
  return settings.homeDir;
}

function createPlannedInstallFile(
  definition: TargetDefinition,
  role: InstallerFileRole,
  filePath: string,
  root: string,
  content: Buffer | null,
  snapshot: InstallFileSnapshot,
  dryRun: boolean,
): PlannedInstallFile {
  const unchanged = content === null ? snapshot.bytes === null : (snapshot.bytes?.equals(content) ?? false);
  let action: InstallChange["action"];
  if (unchanged) action = "unchanged";
  else if (content === null) action = "delete";
  else if (snapshot.bytes === null) action = "create";
  else action = "update";
  return {
    target: definition.id,
    role,
    path: filePath,
    root,
    content,
    snapshot,
    change: change(definition.id, action, filePath, dryRun),
  };
}

function addPlannedInstallFile(files: PlannedInstallFile[], file: PlannedInstallFile): void {
  const duplicate = files.find((existing) => sameInstallPath(existing.path, file.path));
  if (duplicate) {
    throw new Error(
      `Install targets resolve to the same destination ${normalizePathForDisplay(file.path)} (${duplicate.target} and ${file.target}).`,
    );
  }
  files.push(file);
}

function sameInstallPath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function applyInstallPlan(plan: InstallPlan, verifyInstalledConfig = true): Promise<void> {
  try {
    for (const file of plan.files) {
      if (file.change.action === "unchanged") continue;
      if (file.content === null) {
        await removePlannedInstallFile(file.path, file.root);
      } else {
        await writeTextFileAtomic(file.path, file.content, {
          mode: file.snapshot.mode ?? 0o600,
          root: file.root,
        });
      }
    }
    await verifyInstallPlan(plan, verifyInstalledConfig);
  } catch (error) {
    const rollbackFailures = await rollbackInstallPlan(plan);
    if (rollbackFailures.length) {
      const details = rollbackFailures
        .map(
          ({ file, error: rollbackError }) =>
            `${normalizePathForDisplay(file.path)} (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`,
        )
        .join(", ");
      throw new Error(`Codegraph installer failed and rollback could not restore: ${details}`, { cause: error });
    }
    throw error;
  }
}

type InstallRollbackFailure = {
  file: PlannedInstallFile;
  error: unknown;
};

async function rollbackInstallPlan(plan: InstallPlan): Promise<InstallRollbackFailure[]> {
  const failures: InstallRollbackFailure[] = [];
  for (const file of [...plan.files].reverse()) {
    try {
      if (file.snapshot.bytes === null) {
        await removePlannedInstallFile(file.path, file.root);
        continue;
      }
      await writeTextFileAtomic(file.path, file.snapshot.bytes, {
        mode: file.snapshot.mode ?? 0o600,
        root: file.root,
      });
    } catch (error) {
      failures.push({ file, error });
    }
  }
  return failures;
}

async function removePlannedInstallFile(filePath: string, root: string): Promise<void> {
  await assertNoSymbolicLinksWithinRoot(filePath, root);
  await fsp.rm(filePath, { force: true });
}

async function verifyInstallPlan(plan: InstallPlan, verifyInstalledConfig: boolean): Promise<void> {
  for (const file of plan.files) {
    const actual = await snapshotInstallFile(file.path, file.root);
    if (file.content === null) {
      if (actual.bytes !== null) {
        throw new Error(
          `Codegraph installer ${file.role} verification failed for ${normalizePathForDisplay(file.path)}.`,
        );
      }
      continue;
    }
    if (actual.bytes === null || !actual.bytes.equals(file.content)) {
      throw new Error(
        `Codegraph installer ${file.role} verification failed for ${normalizePathForDisplay(file.path)}.`,
      );
    }
    if (!verifyInstalledConfig || file.role !== "config") continue;
    const definition = definitionForTarget(file.target);
    if (!configContainsInstallerServer(definition, actual.bytes.toString("utf8"), file.path)) {
      throw new Error(`Codegraph installer config verification failed for ${normalizePathForDisplay(file.path)}.`);
    }
  }
}

async function uninstallTarget(definition: TargetDefinition, options: UninstallOptions): Promise<UninstallResult> {
  assertWriteAllowed(options);
  return await uninstallDefinitions([definition], options);
}

async function uninstallDefinitions(
  definitions: readonly TargetDefinition[],
  options: UninstallOptions,
): Promise<UninstallResult> {
  const settings = installerSettings(options);
  const dryRun = options.dryRun ?? false;
  const uninstall = async (): Promise<UninstallResult> => {
    const plan = await prepareUninstallPlan(definitions, settings, dryRun);
    if (!dryRun) await applyInstallPlan(plan, false);
    return {
      uninstalled: plan.changes.some(
        (plannedChange) => plannedChange.action === "delete" || plannedChange.action === "update",
      ),
      dryRun,
      targets: definitions.map((definition) => definition.id),
      changes: [...plan.changes],
    };
  };
  if (dryRun) return await uninstall();
  return await withInstallerTransactionLocks(settings, uninstall);
}

async function prepareUninstallPlan(
  definitions: readonly TargetDefinition[],
  settings: InstallerSettings,
  dryRun: boolean,
): Promise<InstallPlan> {
  const files: PlannedInstallFile[] = [];
  for (const definition of definitions) {
    const skillTargetDir = getSkillTargetDirForAgent(definition.id, settings.homeDir, settings.env);
    const skillRoot = skillInstallRoot(definition, settings);
    const skillPath = path.join(skillTargetDir, "SKILL.md");
    const markerPath = path.join(skillTargetDir, "CODEGRAPH_INSTALLED");
    const skillSnapshot = await snapshotInstallFile(skillPath, skillRoot);
    const markerSnapshot = await snapshotInstallFile(markerPath, skillRoot);
    const removeOwnedSkill = isInstallerOwnedSkill(markerSnapshot.bytes, skillSnapshot.bytes);
    const removeOrphanMarker = skillSnapshot.bytes === null && markerSnapshot.bytes !== null;
    addPlannedInstallFile(
      files,
      createPlannedInstallFile(
        definition,
        "skill",
        skillPath,
        skillRoot,
        removeOwnedSkill ? null : skillSnapshot.bytes,
        skillSnapshot,
        dryRun,
      ),
    );
    addPlannedInstallFile(
      files,
      createPlannedInstallFile(
        definition,
        "marker",
        markerPath,
        skillRoot,
        removeOwnedSkill || removeOrphanMarker ? null : markerSnapshot.bytes,
        markerSnapshot,
        dryRun,
      ),
    );

    if (definition.kind === "skill-only") continue;
    const configPath = requireConfigPath(definition, settings);
    const configRoot = configInstallRoot(definition, settings);
    const configSnapshot = await snapshotInstallFile(configPath, configRoot);
    let configContent = configSnapshot.bytes;
    if (configSnapshot.bytes !== null) {
      const existing = configSnapshot.bytes.toString("utf8");
      const next = removeCodegraphConfig(definition, existing, configPath);
      if (next !== existing) configContent = next.trim() ? Buffer.from(next, "utf8") : null;
    }
    addPlannedInstallFile(
      files,
      createPlannedInstallFile(definition, "config", configPath, configRoot, configContent, configSnapshot, dryRun),
    );
  }
  return {
    files,
    changes: files.map((file) => file.change),
  };
}

function skillContentSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function renderInstallMarker(definition: TargetDefinition, bundledSkill: Buffer): string {
  return (
    `Installed by codegraph install for ${definition.label}.\n` +
    `skillSha256=${skillContentSha256(bundledSkill)}\n` +
    `Run codegraph install --target ${definition.id} --yes --force to refresh bundled skill files.\n`
  );
}

function isValidInstallMarker(markerBytes: Buffer): boolean {
  return markerBytes.toString("utf8").includes("Installed by codegraph install for ");
}

function readSkillShaFromMarker(markerBytes: Buffer): string | null {
  const match = /^skillSha256=([a-f0-9]{64})$/m.exec(markerBytes.toString("utf8"));
  return match?.[1] ?? null;
}

function isInstallerOwnedSkill(markerBytes: Buffer | null, skillBytes: Buffer | null): boolean {
  if (markerBytes === null || skillBytes === null) return false;
  if (!isValidInstallMarker(markerBytes)) return false;
  const recordedSha = readSkillShaFromMarker(markerBytes);
  if (recordedSha === null) return false;
  return recordedSha === skillContentSha256(skillBytes);
}

function findSkillCollision(
  definition: TargetDefinition,
  skillPath: string,
  skillBytes: Buffer | null,
  markerBytes: Buffer | null,
  bundledSkill: Buffer,
): InstallerCollision | undefined {
  if (skillBytes === null) return undefined;
  if (markerBytes === null && skillBytes.equals(bundledSkill)) return undefined;
  if (isInstallerOwnedSkill(markerBytes, skillBytes)) return undefined;
  return {
    target: definition.id,
    path: normalizePathForDisplay(skillPath),
    kind: "user-owned-skill",
  };
}

function findConfigCollision(
  definition: TargetDefinition,
  configPath: string,
  existing: string | null,
): InstallerCollision | undefined {
  if (definition.kind === "skill-only") return undefined;
  if (definition.kind === "toml-block") {
    inspectCodexTomlOwnership(existing ?? "", configPath);
    const hasUnmarkedTable = findCodegraphTomlTableIndexes(existing ?? "").length;
    if (!hasUnmarkedTable || isInstallCompatibleCodexTomlTable(existing ?? "")) return undefined;
    return {
      target: definition.id,
      path: normalizePathForDisplay(configPath),
      kind: "user-owned-codegraph-table",
    };
  }
  if (existing === null) return undefined;
  const parsed = parseTargetConfig(definition, existing, configPath);
  const property = mcpConfigProperty(definition);
  const existingServer = readRecordProperty(parsed, property).codegraph;
  if (existingServer === undefined || isInstallCompatibleJsonServer(definition, existingServer)) return undefined;
  return {
    target: definition.id,
    path: normalizePathForDisplay(configPath),
    kind: "user-owned-codegraph-entry",
  };
}

function configContainsInstallerServer(definition: TargetDefinition, config: string, configPath: string): boolean {
  if (definition.kind === "toml-block") {
    return hasExactlyOneCompleteCodexTomlBlock(config, configPath) || isInstallCompatibleCodexTomlTable(config);
  }
  if (definition.kind === "skill-only") return true;
  const parsed = parseTargetConfig(definition, config, configPath);
  const property = mcpConfigProperty(definition);
  return isInstallCompatibleJsonServer(definition, readRecordProperty(parsed, property).codegraph);
}

function renderConfigWithCodegraph(definition: TargetDefinition, existing: string | null, configPath: string): string {
  if (definition.kind === "toml-block") {
    if (existing !== null && isInstallCompatibleCodexTomlTable(existing)) return existing;
    return upsertMarkedTomlBlock(existing ?? "", codexTomlSnippet(), configPath);
  }
  const parsed = parseTargetConfig(definition, existing, configPath);
  const property = mcpConfigProperty(definition);
  const servers = readRecordProperty(parsed, property);
  if (isInstallCompatibleJsonServer(definition, servers.codegraph)) return existing ?? renderJsonConfig(parsed);
  if (definition.kind === "json-kilo-mcp") {
    return modifyJsoncConfig(existing, [property, "codegraph"], codegraphJsonServer(definition));
  }
  servers.codegraph = codegraphJsonServer(definition);
  parsed[property] = servers;
  return renderJsonConfig(parsed);
}

function removeCodegraphConfig(definition: TargetDefinition, existing: string, configPath: string): string {
  if (definition.kind === "toml-block") {
    return removeMarkedTomlBlock(existing, configPath);
  }
  const parsed = parseTargetConfig(definition, existing, configPath);
  const property = mcpConfigProperty(definition);
  const servers = readRecordProperty(parsed, property);
  const server = servers.codegraph;
  if (!isInstallerOwnedJsonServer(definition, server)) return existing;
  if (definition.kind === "json-kilo-mcp") {
    const targetPath = Object.keys(servers).length === 1 ? [property] : [property, "codegraph"];
    return modifyJsoncConfig(existing, targetPath, undefined);
  }
  delete servers.codegraph;
  if (Object.keys(servers).length) {
    parsed[property] = servers;
  } else {
    delete parsed[property];
  }
  return renderJsonConfig(parsed);
}

function printTargetConfig(definition: TargetDefinition, _options: PrintConfigOptions): string {
  if (definition.kind === "toml-block") return codexTomlSnippet();
  if (definition.kind === "skill-only") {
    return `codegraph skill install --agent ${definition.id}\n`;
  }
  return renderJsonConfig({ [mcpConfigProperty(definition)]: { codegraph: codegraphJsonServer(definition) } });
}

function mcpConfigProperty(definition: TargetDefinition): "mcp" | "mcpServers" {
  if (definition.kind === "json-opencode-mcp" || definition.kind === "json-kilo-mcp") return "mcp";
  return "mcpServers";
}

function codexTomlSnippet(): string {
  return '[mcp_servers.codegraph]\ncommand = "codegraph"\nargs = ["mcp", "serve", "--root", ".", "--stdio"]\nstartup_timeout_ms = 20000\n';
}

function upsertMarkedTomlBlock(existing: string, snippet: string, configPath: string): string {
  const ownership = inspectCodexTomlOwnership(existing, configPath);
  const block = `${CODEGRAPH_TOML_MARKER_BEGIN}\n${snippet.trimEnd()}\n${CODEGRAPH_TOML_MARKER_END}`;
  const withoutBlock = (ownership === null ? existing : removeMarkedTomlBlock(existing, configPath)).trimEnd();
  const updated = withoutBlock ? `${withoutBlock}\n\n${block}\n` : `${block}\n`;
  inspectCodexTomlOwnership(updated, configPath);
  return updated;
}

function removeMarkedTomlBlock(existing: string, configPath: string): string {
  if (inspectCodexTomlOwnership(existing, configPath) === null) return existing;
  const begin = escapeRegExp(CODEGRAPH_TOML_MARKER_BEGIN);
  const end = escapeRegExp(CODEGRAPH_TOML_MARKER_END);
  const pattern = new RegExp(`\\n?${begin}[\\s\\S]*?${end}\\n?`, "g");
  return existing.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
}

function hasExactlyOneCompleteCodexTomlBlock(config: string, configPath: string): boolean {
  try {
    return inspectCodexTomlOwnership(config, configPath) !== null;
  } catch {
    return false;
  }
}

function inspectCodexTomlOwnership(existing: string, configPath: string): CodexTomlBlock | null {
  const beginIndexes = findTokenIndexes(existing, CODEGRAPH_TOML_MARKER_BEGIN);
  const endIndexes = findTokenIndexes(existing, CODEGRAPH_TOML_MARKER_END);
  const tableIndexes = findCodegraphTomlTableIndexes(existing);
  if (!beginIndexes.length && !endIndexes.length) return null;
  if (
    beginIndexes.length !== 1 ||
    endIndexes.length !== 1 ||
    beginIndexes[0] === undefined ||
    endIndexes[0] === undefined
  ) {
    throw new Error(
      `Codex config contains an incomplete or malformed Codegraph installer marker block at ${normalizePathForDisplay(configPath)}.`,
    );
  }
  const beginIndex = beginIndexes[0];
  const endIndex = endIndexes[0];
  const hasSingleOwnedTable =
    tableIndexes.length === 1 &&
    tableIndexes[0] !== undefined &&
    tableIndexes[0] > beginIndex &&
    tableIndexes[0] < endIndex;
  if (beginIndex >= endIndex || !hasSingleOwnedTable) {
    throw new Error(
      `Codex config contains an incomplete or malformed Codegraph installer marker block at ${normalizePathForDisplay(configPath)}.`,
    );
  }
  return { beginIndex, endIndex };
}

function findTokenIndexes(content: string, token: string): number[] {
  const indexes: number[] = [];
  for (let index = content.indexOf(token); index !== -1; index = content.indexOf(token, index + token.length)) {
    indexes.push(index);
  }
  return indexes;
}

function findCodegraphTomlTableIndexes(content: string): number[] {
  const indexes: number[] = [];
  const tablePattern = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/gim;
  for (const match of content.matchAll(tablePattern)) {
    if (match.index === undefined) continue;
    const keyPath = parseTomlTableKey(match[1] ?? "");
    if (keyPath?.length === 2 && keyPath[0] === "mcp_servers" && keyPath[1] === "codegraph") {
      indexes.push(match.index);
    }
  }
  return indexes;
}

function parseTomlTableKey(raw: string): string[] | null {
  const segments: string[] = [];
  let index = 0;
  while (index < raw.length) {
    while (/\s/u.test(raw[index] ?? "")) index += 1;
    if (index >= raw.length) return segments;
    const quote = raw[index];
    if (quote === "'" || quote === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < raw.length) {
        const character = raw[index];
        if (quote === '"' && character === "\\" && !escaped) {
          escaped = true;
          index += 1;
          continue;
        }
        if (character === quote && !escaped) break;
        escaped = false;
        index += 1;
      }
      if (raw[index] !== quote) return null;
      const encoded = raw.slice(start, index + 1);
      try {
        segments.push(quote === '"' ? JSON.parse(encoded) : encoded.slice(1, -1));
      } catch {
        return null;
      }
      index += 1;
    } else {
      const start = index;
      while (index < raw.length && !/[\s.]/u.test(raw[index] ?? "")) index += 1;
      const bare = raw.slice(start, index);
      if (!/^[A-Za-z0-9_-]+$/u.test(bare)) return null;
      segments.push(bare);
    }
    while (/\s/u.test(raw[index] ?? "")) index += 1;
    if (index >= raw.length) return segments;
    if (raw[index] !== ".") return null;
    index += 1;
  }
  return segments;
}

function isInstallCompatibleCodexTomlTable(config: string): boolean {
  if (findCodegraphTomlTableIndexes(config).length !== 1) return false;
  try {
    const parsed = parseToml(config);
    if (!isJsonRecord(parsed)) return false;
    const mcpServers = readRecordProperty(parsed, "mcp_servers");
    if (mcpServers === undefined) return false;
    const codegraph = readRecordProperty(mcpServers, "codegraph");
    if (codegraph === undefined) return false;
    return jsonValueEquals(codegraph, {
      command: "codegraph",
      args: ["mcp", "serve", "--root", ".", "--stdio"],
      startup_timeout_ms: 20_000,
    });
  } catch {
    return false;
  }
}

function parseTargetConfig(definition: TargetDefinition, existing: string | null, configPath: string): JsonRecord {
  if (definition.kind === "json-kilo-mcp") return parseConfigJsonc(existing, configPath);
  return parseConfigJson(existing, configPath);
}

function parseConfigJsonc(existing: string | null, configPath: string): JsonRecord {
  if (existing === null || !existing.trim()) return {};
  const errors: ParseError[] = [];
  const parsed = parseJsonc(existing, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length) {
    throw new Error(
      `Unable to parse ${normalizePathForDisplay(configPath)} as JSONC. Fix the file before running the installer.`,
    );
  }
  if (isJsonRecord(parsed)) return parsed;
  throw new Error(`${normalizePathForDisplay(configPath)} must contain a JSON object.`);
}

function modifyJsoncConfig(existing: string | null, targetPath: string[], value: unknown): string {
  const source = existing?.trim() ? existing : "{}";
  const formattingOptions = jsoncFormattingOptions(source);
  const edits = modify(source, targetPath, value, { formattingOptions });
  const updated = applyEdits(source, edits);
  return updated.endsWith(formattingOptions.eol) ? updated : `${updated}${formattingOptions.eol}`;
}

function jsoncFormattingOptions(source: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const indentation = source.match(/\r?\n([ \t]+)\S/u)?.[1];
  let insertSpaces = true;
  let tabSize = 2;
  if (indentation?.startsWith("\t")) {
    insertSpaces = false;
    tabSize = 1;
  } else if (indentation) {
    tabSize = indentation.length;
  }
  return { insertSpaces, tabSize, eol };
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
  if (definition.kind === "json-kilo-mcp") {
    return {
      type: "local",
      command: ["codegraph", "mcp", "serve", "--root", ".", "--stdio"],
    };
  }
  if (definition.kind === "json-mcp-servers-no-type") {
    return {
      command: "codegraph",
      args: ["mcp", "serve", "--root", ".", "--stdio"],
    };
  }
  return {
    type: "stdio",
    command: "codegraph",
    args: ["mcp", "serve", "--root", ".", "--stdio"],
  };
}

function isInstallCompatibleJsonServer(definition: TargetDefinition, value: unknown): boolean {
  if (isInstallerOwnedJsonServer(definition, value)) return true;
  const usesMcpServers = definition.kind === "json-mcp-servers" || definition.kind === "json-mcp-servers-no-type";
  if (!usesMcpServers || !isJsonRecord(value)) return false;
  const withoutType = {
    command: "codegraph",
    args: ["mcp", "serve", "--root", ".", "--stdio"],
  };
  const withType = { type: "stdio", ...withoutType };
  return jsonValueEquals(value, withoutType) || jsonValueEquals(value, withType);
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
  let env = options.env;
  if (env === undefined) env = options.homeDir === undefined ? process.env : {};
  return {
    homeDir: options.homeDir ?? os.homedir(),
    env,
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

async function snapshotInstallFile(filePath: string, root: string): Promise<InstallFileSnapshot> {
  await assertNoSymbolicLinksWithinRoot(filePath, root);
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink()) throw unsafeSymbolicLinkError(filePath);
    if (!stats.isFile()) {
      throw new Error(`Expected a regular file at ${normalizePathForDisplay(filePath)} before running the installer.`);
    }
    return {
      bytes: await fsp.readFile(filePath),
      mode: stats.mode & 0o7777,
    };
  } catch (error) {
    if (isFileSystemErrorCode(error, "ENOENT")) {
      await confirmMissingPathHasDirectoryAncestors(filePath);
      return { bytes: null, mode: null };
    }
    throw error;
  }
}

async function assertNoSymbolicLinksWithinRoot(filePath: string, root: string): Promise<void> {
  const resolvedFilePath = path.resolve(filePath);
  const resolvedRoot = path.resolve(root);
  const relativePath = path.relative(resolvedRoot, resolvedFilePath);
  if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error(
      `Installer destination ${normalizePathForDisplay(filePath)} escapes its configured root ${normalizePathForDisplay(root)}.`,
    );
  }
  for (let current = resolvedFilePath; current !== resolvedRoot; current = path.dirname(current)) {
    try {
      const stats = await fsp.lstat(current);
      if (stats.isSymbolicLink()) throw unsafeSymbolicLinkError(current);
    } catch (error) {
      if (!isFileSystemErrorCode(error, "ENOENT")) throw error;
    }
    if (path.dirname(current) === current) break;
  }
}

async function confirmMissingPathHasDirectoryAncestors(filePath: string): Promise<false> {
  let current = path.dirname(filePath);
  while (true) {
    try {
      const stats = await fsp.lstat(current);
      if (stats.isSymbolicLink()) throw unsafeSymbolicLinkError(current);
      if (!stats.isDirectory()) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, stat '${filePath}'`), { code: "ENOTDIR" });
      }
      return false;
    } catch (error) {
      if (!isFileSystemErrorCode(error, "ENOENT")) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
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

async function writeTextFileAtomic(
  filePath: string,
  content: string | Uint8Array,
  options: { mode?: number; root?: string } = {},
): Promise<void> {
  if (options.root === undefined) await assertNoSymbolicLinkAtPath(filePath);
  else await assertNoSymbolicLinksWithinRoot(filePath, options.root);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await withInstallerLeaseLock(`${filePath}.codegraph-lock`, normalizePathForDisplay(filePath), async () => {
    if (options.root === undefined) await assertNoSymbolicLinkAtPath(filePath);
    else await assertNoSymbolicLinksWithinRoot(filePath, options.root);
    const nonce = `${process.pid}-${randomUUID()}`;
    const temporaryPath = `${filePath}.codegraph-tmp-${nonce}`;
    try {
      let mode = options.mode ?? 0o600;
      if (options.mode === undefined) {
        try {
          const existing = await fsp.lstat(filePath);
          if (existing.isSymbolicLink()) throw unsafeSymbolicLinkError(filePath);
          mode = existing.mode & 0o7777;
        } catch (error) {
          if (!isFileSystemErrorCode(error, "ENOENT")) throw error;
        }
      }
      await fsp.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode });
      await fsp.chmod(temporaryPath, mode);
      await renameTemporaryFile(temporaryPath, filePath);
    } catch (error) {
      if (isFileSystemErrorCode(error, "EACCES") || isFileSystemErrorCode(error, "EPERM")) {
        throw new Error(
          `Permission denied while updating user-owned path ${normalizePathForDisplay(filePath)}. Check its ownership and permissions, then retry without administrator mode.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  });
}

async function assertNoSymbolicLinkAtPath(filePath: string): Promise<void> {
  try {
    const stats = await fsp.lstat(filePath);
    if (stats.isSymbolicLink()) throw unsafeSymbolicLinkError(filePath);
  } catch (error) {
    if (isFileSystemErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

function unsafeSymbolicLinkError(filePath: string): Error {
  return new Error(
    `Refusing to replace symbolic link at ${normalizePathForDisplay(filePath)}. Use a regular file or directory instead.`,
  );
}

async function renameTemporaryFile(temporaryPath: string, filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(temporaryPath, filePath);
      return;
    } catch (error) {
      if (!isFileSystemErrorCode(error, "EPERM") || attempt === 4) throw error;
      await waitForInstallerLockRetry();
    }
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
