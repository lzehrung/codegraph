import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assembleStandaloneArchive,
  assertStandaloneTarget,
  resolveStandaloneTarget,
  STANDALONE_TARGETS,
  validateArchiveEntries,
} from "../scripts/standalone/standalone-lib.mjs";
import {
  installStandaloneBundle,
  uninstallStandaloneBundle,
  verifyStandaloneBundle,
} from "../scripts/onboarding/standalone-install-lib.mjs";
import { mkTmpDir } from "./helpers/filesystem.js";

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fsp.readFile(filePath))
    .digest("hex");
}

type FakeBundleDetails = {
  bundle: string;
  version: string;
  target: string;
  nativeSuffix: string;
};

type FakeBundleOptions = {
  label?: string;
  cliContents?: string;
  cliFactory?: (details: FakeBundleDetails) => string;
  nodeContents?: string;
  nodeMode?: number;
  runtimeNode?: boolean;
  sourceRevision?: string | null;
};

async function createFakeBundle(root: string, version: string, options: FakeBundleOptions = {}): Promise<string> {
  const target = resolveStandaloneTarget();
  if (!target) throw new Error("Current host is not a supported standalone target.");
  const definition = assertStandaloneTarget(target);
  const bundleName = options.label
    ? `codegraph-${target}-${version}-${options.label}`
    : `codegraph-${target}-${version}`;
  const bundle = path.join(root, bundleName);
  let cliContents = `console.log(${JSON.stringify(version)});\n`;
  if (options.cliContents !== undefined) {
    cliContents = options.cliContents;
  } else if (options.cliFactory) {
    cliContents = options.cliFactory({ bundle, version, target, nativeSuffix: definition.nativeSuffix });
  }
  const sourceRevision = options.sourceRevision === undefined ? "test-revision" : options.sourceRevision;
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodePath = path.join(bundle, nodeName);
  await fsp.mkdir(path.join(bundle, "dist"), { recursive: true });
  await fsp.writeFile(path.join(bundle, "dist", "cli.js"), cliContents, "utf8");
  if (options.runtimeNode) {
    await fsp.copyFile(process.execPath, nodePath);
  } else {
    await fsp.writeFile(nodePath, options.nodeContents ?? "fake node", "utf8");
  }
  if (process.platform !== "win32" && (options.runtimeNode || options.nodeMode !== undefined)) {
    await fsp.chmod(nodePath, options.nodeMode ?? 0o755);
  }
  await fsp.writeFile(
    path.join(bundle, "package.json"),
    `${JSON.stringify({ name: "@lzehrung/codegraph", version })}\n`,
    "utf8",
  );
  const nativePackageRelative = `node_modules/@lzehrung/codegraph-native-${definition.nativeSuffix}/package.json`;
  const nativePackagePath = path.join(bundle, ...nativePackageRelative.split("/"));
  await fsp.mkdir(path.dirname(nativePackagePath), { recursive: true });
  await fsp.writeFile(
    nativePackagePath,
    `${JSON.stringify({
      name: `@lzehrung/codegraph-native-${definition.nativeSuffix}`,
      version,
    })}\n`,
    "utf8",
  );
  const files = [];
  for (const relative of ["dist/cli.js", nodeName, "package.json", nativePackageRelative]) {
    const absolute = path.join(bundle, ...relative.split("/"));
    files.push({ path: relative, size: (await fsp.stat(absolute)).size, sha256: await sha256(absolute) });
  }
  await fsp.writeFile(
    path.join(bundle, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        channel: "standalone-preview",
        version,
        target,
        nativeSuffix: definition.nativeSuffix,
        nodeVersion: process.version,
        sourceRevision,
        files,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return bundle;
}

async function createFakePackageRoot(root: string, target: string): Promise<{ packageRoot: string; node: string }> {
  const definition = STANDALONE_TARGETS[target as keyof typeof STANDALONE_TARGETS];
  const packageRoot = path.join(root, "package");
  await fsp.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fsp.mkdir(path.join(packageRoot, "codegraph-skill", "codegraph"), { recursive: true });
  await fsp.mkdir(path.join(packageRoot, "node_modules", "@lzehrung", "codegraph-native"), { recursive: true });
  await fsp.writeFile(path.join(packageRoot, "dist", "cli.js"), "console.log('fake');\n", "utf8");
  await fsp.writeFile(path.join(packageRoot, "codegraph-skill", "codegraph", "SKILL.md"), "# Skill\n", "utf8");
  await fsp.writeFile(path.join(packageRoot, "package.json"), '{"name":"@lzehrung/codegraph","version":"9.8.7"}\n');
  await fsp.writeFile(path.join(packageRoot, "LICENSE"), "MIT\n");
  await fsp.writeFile(path.join(packageRoot, "THIRD_PARTY_NOTICES"), "Notices\n");
  const nativeRoot = path.join(packageRoot, "node_modules", "@lzehrung", "codegraph-native");
  await fsp.writeFile(
    path.join(nativeRoot, "package.json"),
    '{"name":"@lzehrung/codegraph-native","version":"9.8.7"}\n',
  );
  await fsp.writeFile(path.join(nativeRoot, `index.${definition.nativeSuffix}.node`), "native");
  const runtimeRoot = path.join(root, "runtime");
  await fsp.mkdir(runtimeRoot, { recursive: true });
  const node = path.join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
  await fsp.writeFile(node, "node");
  await fsp.writeFile(path.join(runtimeRoot, "LICENSE"), "Node license\n");
  return { packageRoot, node };
}

type SmokeReportOptions = {
  nativeAvailable?: boolean;
  nativePackageName?: string;
  nativePackageVersion?: string;
  nativeTarget?: string;
  packageRoot?: string;
  version?: string;
};

function createSmokeCli(details: FakeBundleDetails, options: SmokeReportOptions = {}): string {
  let packageRootExpression = "process.cwd()";
  if (options.packageRoot !== undefined) packageRootExpression = JSON.stringify(options.packageRoot);
  const reportedVersion = options.version ?? details.version;
  const nativeAvailable = options.nativeAvailable ?? true;
  const nativePackageName = options.nativePackageName ?? `@lzehrung/codegraph-native-${details.nativeSuffix}`;
  const nativePackageVersion = options.nativePackageVersion ?? details.version;
  const nativeTarget = options.nativeTarget ?? details.nativeSuffix;
  return [
    "const args = process.argv.slice(2);",
    `const packageRoot = ${packageRootExpression};`,
    `const versionReport = { name: "@lzehrung/codegraph", version: ${JSON.stringify(reportedVersion)}, packageRoot };`,
    `const doctorReport = { package: { name: "@lzehrung/codegraph", version: ${JSON.stringify(reportedVersion)}, packageRoot }, native: { available: ${JSON.stringify(nativeAvailable)}, origin: { packageName: ${JSON.stringify(nativePackageName)}, packageVersion: ${JSON.stringify(nativePackageVersion)}, target: ${JSON.stringify(nativeTarget)} } } };`,
    'if (args[0] === "version" && args[1] === "--json") { process.stdout.write(`${JSON.stringify(versionReport)}\\n`); }',
    'else if (args[0] === "doctor" && args[1] === "--json") { process.stdout.write(`${JSON.stringify(doctorReport)}\\n`); }',
    "else { process.exitCode = 1; }",
  ].join("\n");
}

async function expectNoInstallTransientPaths(installBase: string): Promise<void> {
  const entries = await fsp.readdir(installBase);
  expect(entries.filter((entry) => entry.startsWith(".installing-") || entry.startsWith(".install-lock"))).toEqual([]);
}

type InstalledManifest = {
  currentVersion: string;
  launchers: string[];
  versionRoot: string;
};

type ChildInstallOptions = {
  binDir: string;
  bundleRoot: string;
  installBase: string;
};

async function installFromChild(options: ChildInstallOptions): Promise<void> {
  const installerUrl = pathToFileURL(path.resolve("scripts/onboarding/standalone-install-lib.mjs")).href;
  const program = [
    `import { installStandaloneBundle } from ${JSON.stringify(installerUrl)};`,
    `const options = ${JSON.stringify(options)};`,
    "await installStandaloneBundle({ ...options, smoke: async () => {} });",
  ].join("\n");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn(process.execPath, ["--input-type=module", "--eval", program], {
    cwd: path.resolve("."),
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", reject);
  child.once("close", (code) => {
    if (code !== 0) {
      reject(new Error(`Concurrent standalone installer exited with ${code}: ${stderr}`));
      return;
    }
    resolve();
  });
  await promise;
}

describe("standalone distribution", () => {
  it("maps supported hosts and rejects unsupported targets", () => {
    expect(resolveStandaloneTarget()).toBeTruthy();
    expect(assertStandaloneTarget(resolveStandaloneTarget()!)).toMatchObject({
      platform: process.platform,
      arch: process.arch,
    });
    expect(() => assertStandaloneTarget("plan9-mips")).toThrow(/Unsupported standalone target/u);
  });

  it.each([
    { path: "../outside" },
    { path: "/absolute" },
    { path: "C:/absolute" },
    { path: "safe/link", type: "symlink" },
    { path: "safe/device", type: "device" },
  ])("rejects unsafe archive entry $path", (entry) => {
    expect(() => validateArchiveEntries([entry])).toThrow(/Archive contains/u);
  });

  it("assembles a checksummed archive with Node, launchers, native packages, skill, notices, and manifest", async () => {
    const root = await mkTmpDir("cg-standalone-assemble-");
    const target = resolveStandaloneTarget()!;
    const fixture = await createFakePackageRoot(root, target);
    const outputDir = path.join(root, "output");
    const result = await assembleStandaloneArchive({
      target,
      packageRoot: fixture.packageRoot,
      outputDir,
      nodeExecutable: fixture.node,
      noticesPath: path.join(fixture.packageRoot, "THIRD_PARTY_NOTICES"),
      sourceRevision: "abc123",
    });

    expect(await sha256(result.archivePath)).toBe(result.archiveSha256);
    expect(await fsp.readFile(path.join(outputDir, "SHA256SUMS"), "utf8")).toContain(result.archiveSha256);
    const entries = execFileSync(
      process.platform === "win32" ? "unzip" : "tar",
      process.platform === "win32" ? ["-Z1", result.archivePath] : ["-tf", result.archivePath],
      { encoding: "utf8" },
    ).replaceAll("\\", "/");
    expect(entries).toContain(`codegraph-${target}/manifest.json`);
    expect(entries).toContain(`codegraph-${target}/dist/cli.js`);
    expect(entries).toContain(`codegraph-${target}/bin/codegraph`);
    expect(entries).toContain(`codegraph-${target}/bin/codegraph.cmd`);
    expect(entries).toContain(`codegraph-${target}/codegraph-skill/codegraph/SKILL.md`);
    expect(entries).toContain(`codegraph-${target}/THIRD_PARTY_NOTICES`);
    expect(entries).toContain(
      `codegraph-${target}/node_modules/@lzehrung/codegraph-native-${result.manifest.nativeSuffix}/`,
    );
  });

  it("verifies, installs, updates, and uninstalls only owned standalone state", async () => {
    const root = await mkTmpDir("cg-standalone-install-");
    const installBase = path.join(root, "install");
    const binDir = path.join(root, "bin");
    const unrelated = path.join(installBase, "keep.txt");
    await fsp.mkdir(installBase, { recursive: true });
    await fsp.writeFile(unrelated, "keep", "utf8");
    const firstBundle = await createFakeBundle(root, "1.0.0");
    const first = await installStandaloneBundle({
      bundleRoot: firstBundle,
      installBase,
      binDir,
      smoke: async () => {},
    });
    const held = await fsp.open(path.join(first.versionRoot, process.platform === "win32" ? "node.exe" : "node"), "r");
    const secondBundle = await createFakeBundle(root, "1.1.0");
    const second = await installStandaloneBundle({
      bundleRoot: secondBundle,
      installBase,
      binDir,
      smoke: async () => {},
    });
    await held.close();

    expect(first.currentVersion).toBe("1.0.0");
    expect(second).toMatchObject({ currentVersion: "1.1.0", previousVersion: "1.0.0" });
    expect(fs.existsSync(path.join(installBase, "1.0.0"))).toBe(true);
    const repeated = await installStandaloneBundle({
      bundleRoot: secondBundle,
      installBase,
      binDir,
      smoke: async () => {},
    });
    expect(repeated).toMatchObject({ currentVersion: "1.1.0", previousVersion: "1.1.0" });
    expect((await fsp.readdir(installBase)).filter((entry) => entry.startsWith(".installing-"))).toEqual([]);
    expect(fs.existsSync(path.join(installBase, "1.1.0"))).toBe(true);
    const removed = await uninstallStandaloneBundle({ installBase });
    expect(removed.uninstalled).toBe(true);
    expect(await fsp.readFile(unrelated, "utf8")).toBe("keep");
    expect(fs.existsSync(path.join(installBase, "1.0.0"))).toBe(true);
    expect(fs.existsSync(path.join(installBase, "1.1.0"))).toBe(false);
  });

  it("reuses only identical same-version provenance and preserves installer state on mismatch", async () => {
    const root = await mkTmpDir("cg-standalone-provenance-");
    const installBase = path.join(root, "install");
    const binDir = path.join(root, "bin");
    const version = "1.0.0";
    const original = await createFakeBundle(root, version, {
      label: "original",
      cliContents: "console.log('original');\n",
      sourceRevision: "source-a",
    });
    const first = await installStandaloneBundle({
      bundleRoot: original,
      installBase,
      binDir,
      smoke: async () => {},
    });
    const identical = await createFakeBundle(root, version, {
      label: "identical",
      cliContents: "console.log('original');\n",
      sourceRevision: "source-a",
    });
    const reused = await installStandaloneBundle({
      bundleRoot: identical,
      installBase,
      binDir,
      smoke: async () => {},
    });
    expect(reused).toMatchObject({ currentVersion: version, previousVersion: version });
    expect((await fsp.readdir(installBase)).filter((entry) => entry.startsWith(".installing-"))).toEqual([]);

    const launcherBefore = await fsp.readFile(first.launchers[0]);
    const installManifestPath = path.join(installBase, "install-manifest.json");
    const installManifestBefore = await fsp.readFile(installManifestPath);
    const mismatchedBundles = [
      await createFakeBundle(root, version, {
        label: "different-bytes",
        cliContents: "console.log('different');\n",
        sourceRevision: "source-a",
      }),
      await createFakeBundle(root, version, {
        label: "different-source",
        cliContents: "console.log('original');\n",
        sourceRevision: "source-b",
      }),
    ];
    for (const bundle of mismatchedBundles) {
      await expect(
        installStandaloneBundle({
          bundleRoot: bundle,
          installBase,
          binDir,
          smoke: async () => {},
        }),
      ).rejects.toThrow(/provenance mismatch/u);
      expect(await fsp.readFile(first.launchers[0])).toEqual(launcherBefore);
      expect(await fsp.readFile(installManifestPath)).toEqual(installManifestBefore);
    }
    expect((await fsp.readdir(installBase)).filter((entry) => entry.startsWith(".installing-"))).toEqual([]);
  });

  it("rejects successful bundled version output with a mismatched package identity", async () => {
    const root = await mkTmpDir("cg-standalone-smoke-version-");
    const installBase = path.join(root, "install");
    const bundle = await createFakeBundle(root, "1.0.0", {
      runtimeNode: true,
      cliFactory: (details) => createSmokeCli(details, { version: "1.0.1" }),
    });

    await expect(
      installStandaloneBundle({
        bundleRoot: bundle,
        installBase,
        binDir: path.join(root, "bin"),
      }),
    ).rejects.toThrow(/package identity does not match/u);
    expect(fs.existsSync(path.join(installBase, "1.0.0"))).toBe(false);
    await expectNoInstallTransientPaths(installBase);
  });

  it.each([
    {
      label: "an unavailable native runtime",
      reports: { nativeAvailable: false },
      pattern: /available native runtime/u,
    },
    {
      label: "a mismatched native target",
      reports: { nativeTarget: "wrong-native-target" },
      pattern: /native origin target/u,
    },
    {
      label: "a mismatched native package",
      reports: { nativePackageName: "@lzehrung/not-codegraph-native" },
      pattern: /native origin package/u,
    },
  ])("rejects successful bundled doctor output with $label", async ({ reports, pattern }) => {
    const root = await mkTmpDir("cg-standalone-smoke-doctor-");
    const installBase = path.join(root, "install");
    const bundle = await createFakeBundle(root, "1.0.0", {
      runtimeNode: true,
      cliFactory: (details) => createSmokeCli(details, reports),
    });

    await expect(
      installStandaloneBundle({
        bundleRoot: bundle,
        installBase,
        binDir: path.join(root, "bin"),
      }),
    ).rejects.toThrow(pattern);
    expect(fs.existsSync(path.join(installBase, "1.0.0"))).toBe(false);
    await expectNoInstallTransientPaths(installBase);
  });

  it.skipIf(process.platform === "win32")(
    "quotes arbitrary POSIX installation paths in generated launchers",
    async () => {
      const root = await mkTmpDir("cg-standalone-posix-'-$-`-\"-");
      const installBase = path.join(root, "install ' $ ` \"");
      const binDir = path.join(root, "bin ' $ ` \"");
      const output = path.join(root, "launcher-arguments");
      const bundle = await createFakeBundle(root, "1.0.0", {
        nodeContents: '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$CODEGRAPH_LAUNCHER_ARGS"\n',
        nodeMode: 0o755,
      });

      const installed = await installStandaloneBundle({
        bundleRoot: bundle,
        installBase,
        binDir,
        smoke: async () => {},
      });
      const result = spawnSync(installed.launchers[0], ["argument with spaces"], {
        encoding: "utf8",
        env: { ...process.env, CODEGRAPH_LAUNCHER_ARGS: output },
      });

      expect(result.status).toBe(0);
      expect(await fsp.readFile(output, "utf8")).toBe(
        `${path.join(installed.versionRoot, "dist", "cli.js")}\nargument with spaces\n`,
      );
    },
  );

  it.skipIf(process.platform !== "win32")("executes an installed Windows launcher beneath Unicode paths", async () => {
    const root = await mkTmpDir("cg-standalone-windows-unicode-");
    const installBase = path.join(root, "安装 根");
    const binDir = path.join(root, "启动 器");
    const bundle = await createFakeBundle(root, "1.0.0", {
      runtimeNode: true,
      cliFactory: (details) => createSmokeCli(details),
    });
    const installed = await installStandaloneBundle({ bundleRoot: bundle, installBase, binDir });
    const launcher = installed.launchers[0];
    if (!launcher) throw new Error("Expected the installed Windows launcher.");

    const result = spawnSync("cmd.exe", ["/d", "/s", "/c", "codegraph version --json"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: "1.0.0" });
  });

  it("serializes concurrent same- and different-version installs across processes", async () => {
    const root = await mkTmpDir("cg-standalone-concurrent-");
    const installBase = path.join(root, "install");
    const binDir = path.join(root, "bin");
    const firstBundle = await createFakeBundle(root, "1.0.0");
    const secondBundle = await createFakeBundle(root, "1.1.0");

    await Promise.all([
      installFromChild({ bundleRoot: firstBundle, installBase, binDir }),
      installFromChild({ bundleRoot: firstBundle, installBase, binDir }),
      installFromChild({ bundleRoot: secondBundle, installBase, binDir }),
    ]);

    expect(fs.existsSync(path.join(installBase, "1.0.0"))).toBe(true);
    expect(fs.existsSync(path.join(installBase, "1.1.0"))).toBe(true);
    const installedManifest: InstalledManifest = JSON.parse(
      await fsp.readFile(path.join(installBase, "install-manifest.json"), "utf8"),
    );
    expect(["1.0.0", "1.1.0"]).toContain(installedManifest.currentVersion);
    expect(installedManifest.versionRoot).toBe(path.join(installBase, installedManifest.currentVersion));
    if (process.platform === "win32") {
      expect(installedManifest.launchers).toHaveLength(2);
      expect(await fsp.readFile(installedManifest.launchers[0], "utf8")).toContain("codegraph-launcher.ps1");
      expect(await fsp.readFile(installedManifest.launchers[1], "utf8")).toContain(installedManifest.versionRoot);
    } else {
      expect(installedManifest.launchers).toHaveLength(1);
      expect(await fsp.readFile(installedManifest.launchers[0], "utf8")).toContain(installedManifest.versionRoot);
    }
    await expectNoInstallTransientPaths(installBase);
  });

  it("reclaims a stale unowned installation lock without leaking lock artifacts", async () => {
    const root = await mkTmpDir("cg-standalone-stale-lock-");
    const installBase = path.join(root, "install");
    const binDir = path.join(root, "bin");
    const staleLock = path.join(installBase, ".install-lock");
    await fsp.mkdir(staleLock, { recursive: true });
    await fsp.writeFile(path.join(staleLock, "owner.json"), "{not-json", "utf8");
    await fsp.utimes(staleLock, new Date(0), new Date(0));
    const bundle = await createFakeBundle(root, "1.0.0");

    await installStandaloneBundle({
      bundleRoot: bundle,
      installBase,
      binDir,
      smoke: async () => {},
    });

    await expectNoInstallTransientPaths(installBase);
  });

  it("restores launcher and manifest bytes and modes when manifest publication fails", async () => {
    const root = await mkTmpDir("cg-standalone-manifest-rollback-");
    const installBase = path.join(root, "install");
    const binDir = path.join(root, "bin");
    const firstBundle = await createFakeBundle(root, "1.0.0");
    const first = await installStandaloneBundle({
      bundleRoot: firstBundle,
      installBase,
      binDir,
      smoke: async () => {},
    });
    const launcher = first.launchers[0];
    if (process.platform !== "win32") await fsp.chmod(launcher, 0o741);
    const launcherBefore = await fsp.readFile(launcher);
    const launcherMode = (await fsp.stat(launcher)).mode & 0o7777;
    const manifestPath = path.join(installBase, "install-manifest.json");
    const manifestBefore = await fsp.readFile(manifestPath);
    const secondBundle = await createFakeBundle(root, "1.1.0");

    await expect(
      installStandaloneBundle({
        bundleRoot: secondBundle,
        installBase,
        binDir,
        releaseUrl: BigInt(1),
        smoke: async () => {},
      }),
    ).rejects.toThrow();

    expect(await fsp.readFile(launcher)).toEqual(launcherBefore);
    expect(await fsp.readFile(manifestPath)).toEqual(manifestBefore);
    if (process.platform !== "win32") {
      expect((await fsp.stat(launcher)).mode & 0o7777).toBe(launcherMode);
    }
    expect(fs.existsSync(path.join(installBase, "1.1.0"))).toBe(true);
    await expectNoInstallTransientPaths(installBase);
  });

  it("requires explicit consent for noninteractive bootstrap writes", () => {
    const root = path.resolve(".");
    let invocation = { command: "sh", args: [path.join(root, "install.sh"), "--latest"] };
    if (process.platform === "win32") {
      invocation = {
        command: "powershell.exe",
        args: ["-NoProfile", "-NonInteractive", "-File", path.join(root, "install.ps1"), "-Latest"],
      };
    }
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        CODEGRAPH_RELEASE_BASE_URL: "http://127.0.0.1:1",
        CODEGRAPH_INSTALL_BASE: path.join(root, "temp", "bootstrap-consent-test"),
        CODEGRAPH_BIN_DIR: path.join(root, "temp", "bootstrap-consent-bin"),
      },
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/noninteractive install requires (?:-Yes|--yes)/iu);
  });

  it("rejects modified bundle bytes before installation", async () => {
    const root = await mkTmpDir("cg-standalone-integrity-");
    const bundle = await createFakeBundle(root, "1.0.0");
    await verifyStandaloneBundle(bundle);
    await fsp.appendFile(path.join(bundle, "dist", "cli.js"), "tampered\n");
    await expect(verifyStandaloneBundle(bundle)).rejects.toThrow(/integrity check failed/u);
  });
});

describe("standalone bootstrap scripts", () => {
  type PosixBootstrapBundleOptions = {
    cliVersion?: string;
    manifestTarget?: string;
    manifestVersion?: string;
    nativeAvailable?: boolean;
    nativePackageName?: string;
    nativeTarget?: string;
    tamperCli?: boolean;
    version?: string;
  };

  type PosixBootstrapRelease = {
    archive: string;
    releaseDir: string;
    target: string;
    version: string;
  };

  const bootstrapRoot = path.resolve(".");

  function quoteForPosixShell(value: string): string {
    return `'${value.replaceAll("'", "'\"'\"'")}'`;
  }

  async function writePosixExecutable(filePath: string, contents: string): Promise<void> {
    await fsp.writeFile(filePath, contents, "utf8");
    await fsp.chmod(filePath, 0o755);
  }

  async function createPosixBootstrapRelease(
    root: string,
    options: PosixBootstrapBundleOptions = {},
  ): Promise<PosixBootstrapRelease> {
    const target = resolveStandaloneTarget();
    if (!target) throw new Error("Current host is not a supported standalone target.");
    const definition = assertStandaloneTarget(target);
    const version = options.version ?? "1.2.3";
    const manifestVersion = options.manifestVersion ?? version;
    const manifestTarget = options.manifestTarget ?? target;
    const cliVersion = options.cliVersion ?? version;
    const nativeAvailable = options.nativeAvailable ?? true;
    const nativeTarget = options.nativeTarget ?? definition.nativeSuffix;
    const nativePackageName = options.nativePackageName ?? `@lzehrung/codegraph-native-${definition.nativeSuffix}`;
    const nativePackageVersion = manifestVersion;
    const releaseDir = path.join(root, "release");
    const bundleName = `codegraph-${target}`;
    const bundle = path.join(releaseDir, bundleName);
    const node = path.join(bundle, "node");
    const cli = path.join(bundle, "dist", "cli.js");
    const archive = `codegraph-${target}.tar.gz`;
    const doctor = {
      native: {
        available: nativeAvailable,
        origin: {
          packageName: nativePackageName,
          packageVersion: nativePackageVersion,
          target: nativeTarget,
        },
      },
    };
    const cliSource = [
      "const args = process.argv.slice(2);",
      `if (args[0] === "version") console.log(${JSON.stringify(cliVersion)});`,
      `else if (args[0] === "doctor" && args[1] === "--json") console.log(${JSON.stringify(JSON.stringify(doctor))});`,
      "else process.exitCode = 1;",
    ].join("\n");

    await fsp.mkdir(path.dirname(cli), { recursive: true });
    await fsp.writeFile(cli, cliSource, "utf8");
    await writePosixExecutable(node, `#!/bin/sh\nexec ${quoteForPosixShell(process.execPath)} "$@"\n`);
    const nativePackagePath = path.join(
      bundle,
      "node_modules",
      ...`@lzehrung/codegraph-native-${definition.nativeSuffix}`.split("/"),
      "package.json",
    );
    await fsp.mkdir(path.dirname(nativePackagePath), { recursive: true });
    await fsp.writeFile(
      nativePackagePath,
      `${JSON.stringify(
        {
          name: `@lzehrung/codegraph-native-${definition.nativeSuffix}`,
          version: nativePackageVersion,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const files = [];
    for (const relative of [
      "node",
      "dist/cli.js",
      `node_modules/@lzehrung/codegraph-native-${definition.nativeSuffix}/package.json`,
    ]) {
      const absolute = path.join(bundle, ...relative.split("/"));
      files.push({ path: relative, size: (await fsp.stat(absolute)).size, sha256: await sha256(absolute) });
    }
    await fsp.writeFile(
      path.join(bundle, "manifest.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          channel: "standalone-preview",
          version: manifestVersion,
          target: manifestTarget,
          nativeSuffix: definition.nativeSuffix,
          nodeVersion: process.version,
          sourceRevision: "bootstrap-test",
          files,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    if (options.tamperCli) await fsp.appendFile(cli, "\n// tampered\n", "utf8");
    const archivePath = path.join(releaseDir, archive);
    execFileSync("tar", ["-czf", archivePath, "-C", releaseDir, bundleName]);
    await fsp.writeFile(path.join(releaseDir, "SHA256SUMS"), `${await sha256(archivePath)}  ${archive}\n`, "utf8");
    return { archive, releaseDir, target, version };
  }

  async function writeReleaseCurl(binDir: string): Promise<void> {
    await writePosixExecutable(path.join(binDir, "ldd"), "#!/bin/sh\necho ldd GNU libc\n");
    await writePosixExecutable(
      path.join(binDir, "curl"),
      [
        "#!/bin/sh",
        "output=",
        "url=",
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        "    -o) output=$2; shift 2 ;;",
        "    *) url=$1; shift ;;",
        "  esac",
        "done",
        'case "$url" in',
        '  */SHA256SUMS) cp "$CODEGRAPH_TEST_RELEASE/SHA256SUMS" "$output" ;;',
        '  *) cp "$CODEGRAPH_TEST_RELEASE/$CODEGRAPH_TEST_ARCHIVE" "$output" ;;',
        "esac",
      ].join("\n"),
    );
  }

  function bootstrapEnvironment(
    release: PosixBootstrapRelease,
    installBase: string,
    binDir: string,
    mockBin: string,
  ): NodeJS.ProcessEnv {
    return {
      ...process.env,
      CODEGRAPH_BIN_DIR: binDir,
      CODEGRAPH_INSTALL_BASE: installBase,
      CODEGRAPH_RELEASE_BASE_URL: "https://bootstrap.test/release",
      CODEGRAPH_TEST_ARCHIVE: release.archive,
      CODEGRAPH_TEST_RELEASE: release.releaseDir,
      PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`,
    };
  }

  function runPosixBootstrap(args: readonly string[], env: NodeJS.ProcessEnv) {
    return spawnSync("sh", [path.join(bootstrapRoot, "install.sh"), ...args], {
      cwd: bootstrapRoot,
      encoding: "utf8",
      env,
    });
  }

  function runPosixBootstrapAsync(
    args: readonly string[],
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number | null; stderr: string; stdout: string }> {
    const { promise, resolve, reject } = Promise.withResolvers<{
      code: number | null;
      stderr: string;
      stdout: string;
    }>();
    const child = spawn("sh", [path.join(bootstrapRoot, "install.sh"), ...args], {
      cwd: bootstrapRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({ code, stderr, stdout });
    });
    return promise;
  }

  it("uses verified identity and lock contracts plus a Unicode-safe Windows launcher", async () => {
    const [posix, powershell] = await Promise.all([
      fsp.readFile(path.join(bootstrapRoot, "install.sh"), "utf8"),
      fsp.readFile(path.join(bootstrapRoot, "install.ps1"), "utf8"),
    ]);
    expect(posix).toContain("verify_standalone_bundle");
    expect(posix).toContain("verify_native_doctor");
    expect(posix).toContain("target native package metadata is unreadable");
    expect(posix).toContain("acquire_install_lock");
    expect(posix).toContain("shell_single_quote");
    expect(powershell).toContain("Invoke-StandaloneBundleVerification");
    expect(powershell).toContain("Invoke-StandaloneDoctorVerification");
    expect(powershell).toContain("target native package metadata is unreadable");
    expect(powershell).toContain("[System.IO.FileShare]::None");
    expect(powershell).toContain("[System.Text.Encoding]::ASCII");
    expect(powershell).toContain("[System.Text.UTF8Encoding]::new($true)");
    expect(powershell).toContain(
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0codegraph-launcher.ps1" %*',
    );
    expect(powershell).toContain(`return "'" + $Value.Replace("'", "''") + "'"`);
  });

  it.skipIf(process.platform === "win32")("rejects musl Linux before it can download a bundle", async () => {
    const root = await mkTmpDir("cg-bootstrap-musl-");
    const mockBin = path.join(root, "mock-bin");
    const curlMarker = path.join(root, "curl-ran");
    await fsp.mkdir(mockBin, { recursive: true });
    await writePosixExecutable(
      path.join(mockBin, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac\n',
    );
    await writePosixExecutable(path.join(mockBin, "ldd"), "#!/bin/sh\necho musl libc\n");
    await writePosixExecutable(
      path.join(mockBin, "curl"),
      `#!/bin/sh\n: > ${quoteForPosixShell(curlMarker)}\nexit 1\n`,
    );

    const result = runPosixBootstrap(["--yes"], {
      ...process.env,
      CODEGRAPH_BIN_DIR: path.join(root, "bin"),
      CODEGRAPH_INSTALL_BASE: path.join(root, "install"),
      PATH: `${mockBin}${path.delimiter}${process.env.PATH ?? ""}`,
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/musl.*package or source installation path/iu);
    expect(fs.existsSync(curlMarker)).toBe(false);
  });

  for (const identityCase of [
    {
      args: ["--yes"],
      label: "manifest target",
      options: { manifestTarget: "darwin-x64" },
      pattern: /manifest target/u,
    },
    {
      args: ["--yes"],
      label: "manifest version",
      options: { manifestVersion: "1.2.4" },
      pattern: /manifest version/u,
    },
    {
      args: ["--yes"],
      label: "bundled CLI version",
      options: { cliVersion: "1.2.4" },
      pattern: /bundled CLI version/u,
    },
    {
      args: ["--yes", "--version", "1.2.4"],
      label: "explicit requested version",
      options: {},
      pattern: /requested version/u,
    },
  ]) {
    it.skipIf(process.platform === "win32")(
      `rejects an incoming bundle with a mismatched ${identityCase.label}`,
      async () => {
        const root = await mkTmpDir("cg-bootstrap-identity-");
        const mockBin = path.join(root, "mock-bin");
        const release = await createPosixBootstrapRelease(root, identityCase.options);
        await fsp.mkdir(mockBin, { recursive: true });
        await writeReleaseCurl(mockBin);
        const installBase = path.join(root, "install");
        const result = runPosixBootstrap(
          identityCase.args,
          bootstrapEnvironment(release, installBase, path.join(root, "bin"), mockBin),
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toMatch(identityCase.pattern);
        expect(fs.existsSync(path.join(installBase, release.version))).toBe(false);
      },
    );
  }

  it.skipIf(process.platform === "win32")(
    "rejects an incoming bundle whose manifest file record is tampered",
    async () => {
      const root = await mkTmpDir("cg-bootstrap-manifest-files-");
      const mockBin = path.join(root, "mock-bin");
      const release = await createPosixBootstrapRelease(root, { tamperCli: true });
      const installBase = path.join(root, "install");
      await fsp.mkdir(mockBin, { recursive: true });
      await writeReleaseCurl(mockBin);
      const result = runPosixBootstrap(
        ["--yes"],
        bootstrapEnvironment(release, installBase, path.join(root, "bin"), mockBin),
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/file mismatch/u);
      expect(fs.existsSync(path.join(installBase, release.version))).toBe(false);
    },
  );

  for (const doctorCase of [
    {
      label: "an unavailable native runtime",
      options: { nativeAvailable: false },
      pattern: /native runtime is unavailable/u,
    },
    {
      label: "a mismatched native target",
      options: { nativeTarget: "wrong-native-target" },
      pattern: /native origin target/u,
    },
    {
      label: "a mismatched native package",
      options: { nativePackageName: "@lzehrung/not-codegraph-native" },
      pattern: /native origin package/u,
    },
  ]) {
    it.skipIf(process.platform === "win32")(`rejects bundled doctor JSON with ${doctorCase.label}`, async () => {
      const root = await mkTmpDir("cg-bootstrap-doctor-");
      const mockBin = path.join(root, "mock-bin");
      const release = await createPosixBootstrapRelease(root, doctorCase.options);
      await fsp.mkdir(mockBin, { recursive: true });
      await writeReleaseCurl(mockBin);
      const result = runPosixBootstrap(
        ["--yes"],
        bootstrapEnvironment(release, path.join(root, "install"), path.join(root, "bin"), mockBin),
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(doctorCase.pattern);
    });
  }

  it.skipIf(process.platform === "win32")(
    "serializes concurrent bootstrap publication without nesting a staged root",
    async () => {
      const root = await mkTmpDir("cg-bootstrap-concurrent-");
      const mockBin = path.join(root, "mock-bin");
      const release = await createPosixBootstrapRelease(root);
      const installBase = path.join(root, "install");
      const binDir = path.join(root, "bin");
      await fsp.mkdir(mockBin, { recursive: true });
      await writeReleaseCurl(mockBin);
      const environment = bootstrapEnvironment(release, installBase, binDir, mockBin);

      const results = await Promise.all([
        runPosixBootstrapAsync(["--yes"], environment),
        runPosixBootstrapAsync(["--yes"], environment),
      ]);

      for (const result of results) {
        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      }
      const versionRoot = path.join(installBase, release.version);
      expect((await fsp.stat(path.join(versionRoot, "node"))).isFile()).toBe(true);
      expect((await fsp.readdir(versionRoot)).filter((entry) => entry.startsWith(".installing-"))).toEqual([]);
      expect(
        (await fsp.readdir(installBase)).filter(
          (entry) => entry.startsWith(".installing-") || entry === ".install.lock",
        ),
      ).toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")("reclaims a bounded stale POSIX bootstrap lock", async () => {
    const root = await mkTmpDir("cg-bootstrap-stale-lock-");
    const mockBin = path.join(root, "mock-bin");
    const release = await createPosixBootstrapRelease(root);
    const installBase = path.join(root, "install");
    await fsp.mkdir(path.join(installBase, ".install.lock"), { recursive: true });
    await fsp.writeFile(path.join(installBase, ".install.lock", "owner"), "99999999 0 stale\n", "utf8");
    await fsp.mkdir(mockBin, { recursive: true });
    await writeReleaseCurl(mockBin);
    const environment = {
      ...bootstrapEnvironment(release, installBase, path.join(root, "bin"), mockBin),
      CODEGRAPH_INSTALL_LOCK_STALE_SECONDS: "1",
      CODEGRAPH_INSTALL_LOCK_WAIT_SECONDS: "5",
    };

    const result = runPosixBootstrap(["--yes"], environment);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(fs.existsSync(path.join(installBase, ".install.lock"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "executes a POSIX launcher installed beneath special-character paths",
    async () => {
      const root = await mkTmpDir("cg-bootstrap-posix-");
      const mockBin = path.join(root, "mock-bin");
      const release = await createPosixBootstrapRelease(root);
      const installBase = path.join(root, "install ' $ & ; `");
      const binDir = path.join(root, "bin ' $ & ; `");
      await fsp.mkdir(mockBin, { recursive: true });
      await writeReleaseCurl(mockBin);
      const result = runPosixBootstrap(["--yes"], bootstrapEnvironment(release, installBase, binDir, mockBin));

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const launcher = path.join(binDir, "codegraph");
      const launcherText = await fsp.readFile(launcher, "utf8");
      expect(launcherText).toContain(`'"'"'`);
      const launch = spawnSync(launcher, ["version"], { encoding: "utf8" });
      expect(launch.status).toBe(0);
      expect(launch.stdout.trim()).toBe(release.version);
    },
  );
});
