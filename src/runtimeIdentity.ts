import fs from "node:fs";
import path from "node:path";

import type { NativeBindingOrigin } from "./native/contracts.js";
import { getCodegraphPackageIdentity } from "./util/packageInfo.js";

const INSTALLED_VERSION_CHECK_INTERVAL_MS = 30_000;
const RUNNING_PACKAGE_IDENTITY = getCodegraphPackageIdentity();

export type CodegraphRuntimeIdentity = {
  startedAt: string;
  runningVersion: string;
  packageRoot: string;
  packageJsonPath: string;
  nativeOrigin?: NativeBindingOrigin;
};

export type CodegraphUpdateStatus = {
  restartRequired: boolean;
  runningVersion: string;
  installedVersion?: string;
  reason?: string;
};

export type InstalledVersionChecker = {
  check: (force?: boolean) => CodegraphUpdateStatus;
};

type InstalledVersionCheckerDependencies = {
  now?: (() => number) | undefined;
  readFile?: ((filePath: string) => string) | undefined;
  warn?: ((message: string) => void) | undefined;
  intervalMs?: number | undefined;
};

export function captureCodegraphRuntimeIdentity(nativeOrigin?: NativeBindingOrigin): CodegraphRuntimeIdentity {
  return {
    startedAt: new Date().toISOString(),
    runningVersion: RUNNING_PACKAGE_IDENTITY.version,
    packageRoot: RUNNING_PACKAGE_IDENTITY.packageRoot,
    packageJsonPath: path.join(RUNNING_PACKAGE_IDENTITY.packageRoot, "package.json"),
    ...(nativeOrigin ? { nativeOrigin } : {}),
  };
}

export function createInstalledVersionChecker(
  identity: CodegraphRuntimeIdentity,
  dependencies: InstalledVersionCheckerDependencies = {},
): InstalledVersionChecker {
  const now = dependencies.now ?? Date.now;
  const readFile = dependencies.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
  const warn = dependencies.warn ?? ((message: string) => console.error(message));
  const intervalMs = dependencies.intervalMs ?? INSTALLED_VERSION_CHECK_INTERVAL_MS;
  const warnedVersions = new Set<string>();
  let lastCheckedAt = Number.NEGATIVE_INFINITY;
  let lastStatus: CodegraphUpdateStatus = {
    restartRequired: false,
    runningVersion: identity.runningVersion,
    installedVersion: identity.runningVersion,
  };

  return {
    check(force = false): CodegraphUpdateStatus {
      const checkedAt = now();
      if (!force && checkedAt - lastCheckedAt < intervalMs) return lastStatus;
      lastCheckedAt = checkedAt;

      let installedVersion: string | undefined;
      try {
        const parsed = JSON.parse(readFile(identity.packageJsonPath)) as { version?: string };
        if (!parsed.version) throw new Error("package metadata has no version");
        installedVersion = parsed.version;
      } catch {
        lastStatus = {
          restartRequired: true,
          runningVersion: identity.runningVersion,
          reason: "Codegraph installation changed while this process was running",
        };
      }

      if (installedVersion) {
        if (installedVersion === identity.runningVersion) {
          lastStatus = {
            restartRequired: false,
            runningVersion: identity.runningVersion,
            installedVersion,
          };
        } else {
          lastStatus = {
            restartRequired: true,
            runningVersion: identity.runningVersion,
            installedVersion,
            reason: `installed Codegraph ${installedVersion} differs from running Codegraph ${identity.runningVersion}`,
          };
        }
      }

      if (lastStatus.restartRequired) {
        const warningKey = lastStatus.installedVersion ?? "installation-unavailable";
        if (!warnedVersions.has(warningKey)) {
          warnedVersions.add(warningKey);
          warn(`[codegraph] ${lastStatus.reason}; restart this Codegraph process to use the installed version.`);
        }
      }
      return lastStatus;
    },
  };
}
