import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
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

async function createFakeBundle(root: string, version: string): Promise<string> {
  const target = resolveStandaloneTarget();
  if (!target) throw new Error("Current host is not a supported standalone target.");
  const bundle = path.join(root, `codegraph-${target}-${version}`);
  await fsp.mkdir(path.join(bundle, "dist"), { recursive: true });
  await fsp.writeFile(path.join(bundle, "dist", "cli.js"), `console.log(${JSON.stringify(version)});\n`, "utf8");
  await fsp.writeFile(path.join(bundle, process.platform === "win32" ? "node.exe" : "node"), "fake node", "utf8");
  const files = [];
  for (const relative of ["dist/cli.js", process.platform === "win32" ? "node.exe" : "node"]) {
    const absolute = path.join(bundle, ...relative.split("/"));
    files.push({ path: relative, size: (await fsp.stat(absolute)).size, sha256: await sha256(absolute) });
  }
  await fsp.writeFile(
    path.join(bundle, "manifest.json"),
    `${JSON.stringify({ schemaVersion: 1, channel: "standalone-preview", version, target, files }, null, 2)}\n`,
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
