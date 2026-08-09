import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleReleaseCandidates } from "../scripts/certification/assemble-release-candidates-lib.mjs";
import { nativeTargetMetadata } from "../scripts/native-targets-lib.mjs";

const temporaryDirectories: string[] = [];

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function safeTarballName(packageName: string, version: string): string {
  return `${packageName.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`;
}

function createAssemblyCheckout(): {
  root: string;
  output: string;
  originalRootManifest: string;
  originalCoreManifest: string;
  originalNativeManifest: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-candidate-assembly-"));
  temporaryDirectories.push(root);
  const output = path.join(root, "temp", "release-candidates");
  const nativeRoot = path.join(root, "packages", "codegraph-native");
  const rootManifest = {
    name: "@lzehrung/codegraph",
    version: "1.0.0",
    type: "module",
    main: "dist/index.js",
    files: ["dist"],
    scripts: { prepare: "do-not-run" },
    workspaces: ["packages/*"],
    devDependencies: { typescript: "1.0.0" },
    dependencies: { "@lzehrung/codegraph-core": "1.0.0" },
    optionalDependencies: { "@lzehrung/codegraph-native": "^1.0.0" },
  };
  const coreManifest = {
    name: "@lzehrung/codegraph-core",
    version: "1.0.0",
    type: "module",
    main: "dist/index.js",
    files: ["dist"],
    optionalDependencies: { "@lzehrung/codegraph-native": "^1.0.0" },
  };
  const nativeManifest = {
    name: "@lzehrung/codegraph-native",
    version: "1.0.0",
    type: "module",
    main: "index.js",
    files: ["index.js"],
    napi: {
      targets: nativeTargetMetadata.map((target) => target.rustTarget),
    },
  };
  const coreRoot = path.join(root, "packages", "codegraph-core");
  writeJson(path.join(root, "package.json"), rootManifest);
  writeJson(path.join(coreRoot, "package.json"), coreManifest);
  writeJson(path.join(nativeRoot, "package.json"), nativeManifest);
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(coreRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "index.js"), "export const ok = true;\n", "utf8");
  fs.writeFileSync(path.join(coreRoot, "dist", "index.js"), "export const ok = true;\n", "utf8");
  fs.writeFileSync(path.join(nativeRoot, "index.js"), "export const native = true;\n", "utf8");

  for (const target of nativeTargetMetadata) {
    const targetDirectory = path.join(nativeRoot, "npm", target.suffix);
    writeJson(path.join(targetDirectory, "package.json"), {
      name: `@lzehrung/codegraph-native-${target.suffix}`,
      version: "3.0.0",
      main: `index.${target.suffix}.node`,
      files: [`index.${target.suffix}.node`],
    });
    fs.writeFileSync(path.join(targetDirectory, `index.${target.suffix}.node`), target.suffix, "utf8");
  }
  return {
    root,
    output,
    originalRootManifest: fs.readFileSync(path.join(root, "package.json"), "utf8"),
    originalCoreManifest: fs.readFileSync(path.join(coreRoot, "package.json"), "utf8"),
    originalNativeManifest: fs.readFileSync(path.join(nativeRoot, "package.json"), "utf8"),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("release candidate assembly", () => {
  it("packs each target, native meta, core, and root exactly once and restores source manifests", async () => {
    const fixture = createAssemblyCheckout();
    const packedNames: string[] = [];
    const packedManifests = new Map<string, Record<string, unknown>>();

    const result = await assembleReleaseCandidates({
      rootDirectory: fixture.root,
      outputDirectory: fixture.output,
      sourceRevision: "a".repeat(40),
      rootVersion: "2.0.0",
      nativeVersion: "3.0.0",
      packPackage: (packageDirectory: string, outputDirectory: string) => {
        const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as Record<
          string,
          unknown
        >;
        const name = String(manifest.name);
        const version = String(manifest.version);
        const filename = safeTarballName(name, version);
        packedNames.push(name);
        packedManifests.set(name, manifest);
        fs.writeFileSync(path.join(outputDirectory, filename), `${name}@${version}\n`, "utf8");
        return { name, version, filename };
      },
    });

    expect(packedNames).toHaveLength(11);
    expect(new Set(packedNames).size).toBe(11);
    expect(result.manifest.files).toHaveLength(11);
    expect(fs.existsSync(result.manifestPath)).toBe(true);
    expect(fs.existsSync(result.checksumsPath)).toBe(true);
    expect(fs.readFileSync(path.join(fixture.root, "package.json"), "utf8")).toBe(fixture.originalRootManifest);
    expect(fs.readFileSync(path.join(fixture.root, "packages", "codegraph-core", "package.json"), "utf8")).toBe(
      fixture.originalCoreManifest,
    );
    expect(fs.readFileSync(path.join(fixture.root, "packages", "codegraph-native", "package.json"), "utf8")).toBe(
      fixture.originalNativeManifest,
    );

    const packedRoot = packedManifests.get("@lzehrung/codegraph");
    expect(packedRoot).toMatchObject({
      version: "2.0.0",
      dependencies: { "@lzehrung/codegraph-core": "2.0.0" },
      optionalDependencies: { "@lzehrung/codegraph-native": "^3.0.0" },
    });
    const packedCore = packedManifests.get("@lzehrung/codegraph-core");
    expect(packedCore).toMatchObject({ version: "2.0.0" });
    expect(packedRoot).not.toHaveProperty("scripts");
    expect(packedRoot).not.toHaveProperty("workspaces");
    expect(packedRoot).not.toHaveProperty("devDependencies");

    const packedNative = packedManifests.get("@lzehrung/codegraph-native");
    expect(packedNative).toMatchObject({ version: "3.0.0" });
    expect(Object.keys((packedNative?.optionalDependencies ?? {}) as Record<string, string>)).toHaveLength(8);
  });
});
