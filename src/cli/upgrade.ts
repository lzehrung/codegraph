import { getCodegraphPackageIdentity, pathExists } from "./packageInfo.js";

export type UpgradeChannel = "source" | "npm" | "bundle" | "unknown";

export type UpgradeReport = {
  schemaVersion: 1;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  channel: UpgradeChannel;
  command?: string;
  error?: string;
};

type PackageIdentity = {
  name: string;
  version: string;
  packageRoot: string;
};

type ReleaseResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

type UpgradeDependencies = {
  getPackageIdentity: () => PackageIdentity;
  pathExists: (filePath: string) => boolean;
  fetch: (url: string, init: RequestInit) => Promise<ReleaseResponse>;
};

type UpgradeReportOptions = {
  targetVersion?: string;
  checkOnly?: boolean;
};

type ParsedCurrentVersion = {
  parts: readonly [bigint, bigint, bigint];
  prerelease: boolean;
};

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const DEFAULT_DEPENDENCIES: UpgradeDependencies = {
  getPackageIdentity: getCodegraphPackageIdentity,
  pathExists,
  fetch: (url, init) => fetch(url, init),
};

export async function createUpgradeReport(
  options: UpgradeReportOptions = {},
  dependencies: UpgradeDependencies = DEFAULT_DEPENDENCIES,
): Promise<UpgradeReport> {
  const identity = dependencies.getPackageIdentity();
  const channel = detectUpgradeChannel(identity.packageRoot, dependencies.pathExists);
  let targetVersion = options.targetVersion;
  if (targetVersion !== undefined && !isStableVersion(targetVersion)) {
    throw new Error(`Invalid target version "${targetVersion}": expected stable X.Y.Z.`);
  }
  const currentVersion = parseCurrentVersion(identity.version);
  if (currentVersion === undefined) {
    return {
      schemaVersion: 1,
      currentVersion: identity.version,
      updateAvailable: false,
      channel,
      error: `Invalid current package version "${identity.version}": expected SemVer.`,
    };
  }
  if (targetVersion === undefined) {
    try {
      targetVersion = await fetchLatestVersion(dependencies.fetch);
    } catch (error) {
      return {
        schemaVersion: 1,
        currentVersion: identity.version,
        updateAvailable: false,
        channel,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const command = createUpgradeCommand(channel, targetVersion);
  return {
    schemaVersion: 1,
    currentVersion: identity.version,
    latestVersion: targetVersion,
    updateAvailable: compareVersions(targetVersion, currentVersion) > 0,
    channel,
    ...(options.checkOnly || command === undefined ? {} : { command }),
  };
}

export async function handleUpgradeCommand(
  context: {
    positionals: string[];
    checkOnly: boolean;
    json: boolean;
    writeStdoutLine: (message: string) => void;
    writeJSONLine: (value: unknown) => void;
    writeStderrLine: (message: string) => void;
    exit: (code: number) => never;
  },
  dependencies: UpgradeDependencies = DEFAULT_DEPENDENCIES,
): Promise<void> {
  if (context.positionals.length > 1) {
    context.writeStderrLine("Expected at most one target version.");
    context.exit(2);
  }
  const targetVersion = context.positionals[0];
  if (context.checkOnly && targetVersion !== undefined) {
    context.writeStderrLine("--check cannot be combined with a target version.");
    context.exit(2);
  }
  if (targetVersion !== undefined && !isStableVersion(targetVersion)) {
    context.writeStderrLine(`Invalid target version "${targetVersion}": expected stable X.Y.Z.`);
    context.exit(2);
  }
  const report = await createUpgradeReport(
    {
      checkOnly: context.checkOnly,
      ...(targetVersion === undefined ? {} : { targetVersion }),
    },
    dependencies,
  );
  if (context.json) {
    context.writeJSONLine(report);
    return;
  }
  context.writeStdoutLine(`Current version: ${report.currentVersion}`);
  if (report.latestVersion !== undefined) {
    context.writeStdoutLine(`Latest version: ${report.latestVersion}`);
  }
  if (report.error !== undefined) {
    context.writeStdoutLine(`Install channel: ${report.channel}`);
    context.writeStdoutLine(report.error);
    return;
  }
  context.writeStdoutLine(`Update available: ${report.updateAvailable ? "yes" : "no"}`);
  context.writeStdoutLine(`Install channel: ${report.channel}`);
  if (context.checkOnly) return;
  if (report.command !== undefined) {
    context.writeStdoutLine("Upgrade instructions:");
    context.writeStdoutLine(report.command);
    return;
  }
  context.writeStdoutLine("Upgrade instructions unavailable: install channel could not be determined.");
}

async function fetchLatestVersion(fetchRelease: UpgradeDependencies["fetch"]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    let response: ReleaseResponse;
    try {
      response = await fetchRelease("https://api.github.com/repos/lzehrung/codegraph/releases/latest", {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "@lzehrung/codegraph",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("GitHub release lookup timed out after 3 seconds.");
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`GitHub release lookup failed: ${message}.`);
    }
    if (!response.ok) {
      throw new Error(`GitHub release lookup failed with HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (controller.signal.aborted) {
        throw new Error("GitHub release lookup timed out after 3 seconds.");
      }
      throw new Error("GitHub release response was not valid JSON.");
    }
    if (typeof body !== "object" || body === null || !("tag_name" in body) || typeof body.tag_name !== "string") {
      throw new Error("GitHub release response did not include a valid tag_name.");
    }
    let version = body.tag_name;
    if (version.startsWith("v")) version = version.slice(1);
    if (!isStableVersion(version)) {
      throw new Error(`Latest release tag is not a stable X.Y.Z version: ${body.tag_name}.`);
    }
    return version;
  } finally {
    clearTimeout(timeout);
  }
}

function detectUpgradeChannel(packageRoot: string, exists: (filePath: string) => boolean): UpgradeChannel {
  const normalizedRoot = packageRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (exists(`${normalizedRoot}/.git`)) return "source";
  if (/(?:^|\/)node_modules\/(?:.+\/)?@lzehrung\/codegraph$/.test(normalizedRoot)) return "npm";
  return "unknown";
}

function createUpgradeCommand(channel: UpgradeChannel, targetVersion: string): string | undefined {
  if (channel === "source") return "git pull\nnpm install\nnpm run build";
  if (channel === "npm") {
    return (
      'npm config set "@lzehrung:registry" "https://npm.pkg.github.com"\n' +
      `npm install -g @lzehrung/codegraph@${targetVersion}`
    );
  }
  return undefined;
}

function isStableVersion(version: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
}

function parseCurrentVersion(version: string): ParsedCurrentVersion | undefined {
  const match = SEMVER_PATTERN.exec(version);
  if (match === null) return undefined;
  return {
    parts: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease: match[4] !== undefined,
  };
}

function compareVersions(left: string, right: ParsedCurrentVersion): number {
  const leftParts = left.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    const leftPart = leftParts[index]!;
    const rightPart = right.parts[index]!;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return right.prerelease ? 1 : 0;
}
