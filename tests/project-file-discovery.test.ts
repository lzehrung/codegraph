import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildProjectIndex, listProjectFiles, discoverProjectFiles } from "../src/index.js";
import { DEFAULT_PROJECT_MANIFESTS } from "../src/util.js";
import {
  createDiscoveredFileMatcher,
  isRelativePathInside,
  translateGlobRootIgnoreGlobsForScanRoot,
} from "../src/util/projectFiles.js";
import { parseDotnetName, parseGoModuleName, parsePomName, parseTomlName } from "../src/util/projectFiles/parsers.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";

const normalize = (value: string) => value.replace(/\\/g, "/");

function toManifestFilename(manifest: string): string {
  if (manifest.includes("*")) {
    return manifest.replace("*", "Sample");
  }
  return manifest;
}

async function createFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

describe("project file discovery", () => {
  it("parses manifest names without full project traversal", () => {
    expect(parseTomlName('[project]\nname = "py-app" # comment\n', ["project"])).toBe("py-app");
    expect(parseTomlName("[package]\nname = 'rust-app'\n", ["package"])).toBe("rust-app");
    expect(parseGoModuleName('module example.com/app # "commented"\n')).toBe("example.com/app");
    expect(parsePomName("<project><parent><name>Parent</name></parent><artifactId>child</artifactId></project>")).toBe(
      "child",
    );
    expect(parseDotnetName("<Project><PropertyGroup><PackageId>DotNet.App</PackageId></PropertyGroup></Project>")).toBe(
      "DotNet.App",
    );
    expect(parseTomlName('[project]\nname = "py#app" # comment\n', ["project"])).toBe("py#app");
    expect(parseGoModuleName("module example.com/app # keep comment out\n")).toBe("example.com/app");
  });

  it("fails explicitly when the project root is invalid", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-missing-"));
    const missingRoot = path.join(tempDir, "missing-root");

    await expect(listProjectFiles(missingRoot)).rejects.toThrow(/Project root does not exist or is not readable:/);
    await expect(discoverProjectFiles(missingRoot)).rejects.toThrow(/Project root does not exist or is not readable:/);
    await expect(buildProjectIndex(missingRoot)).rejects.toThrow(/Project root does not exist or is not readable:/);
  });

  it("treats an empty readable directory as an empty project", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-empty-"));

    await expect(listProjectFiles(tempDir)).resolves.toEqual([]);
    await expect(discoverProjectFiles(tempDir)).resolves.toEqual([]);

    const index = await buildProjectIndex(tempDir);
    expect(index.modules.size).toBe(0);
    expect(index.graph.nodes.size).toBe(0);
    expect(index.graph.edges).toEqual([]);
  });

  it("includes common manifests and lockfiles in default discovery", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-"));
    const manifestDir = path.join(tempDir, "manifests");
    const sourceFile = path.join(tempDir, "src", "main.ts");
    const manifestFiles = DEFAULT_PROJECT_MANIFESTS.map(toManifestFilename);
    const isCaseInsensitive = os.platform() === "win32" || os.platform() === "darwin";

    const uniqueManifestFiles = isCaseInsensitive
      ? Array.from(new Map(manifestFiles.map((m) => [m.toLowerCase(), m])).values())
      : manifestFiles;

    await createFile(sourceFile, "export const value = 1;\n");
    await Promise.all(
      uniqueManifestFiles.map(async (manifest) => {
        const filePath = path.join(manifestDir, manifest);
        await createFile(filePath, `# ${manifest}\n`);
        return filePath;
      }),
    );

    const discovered = await listProjectFiles(tempDir);
    const discoveredSet = new Set(discovered.map(normalize));

    const expected = [sourceFile, ...uniqueManifestFiles.map((manifest) => path.join(manifestDir, manifest))].map(
      normalize,
    );

    for (const filePath of expected) {
      expect(discoveredSet.has(filePath)).toBe(true);
    }
  });

  it("includes supported source extensions in default discovery", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-sources-"));
    const files = [
      path.join(tempDir, "kotlin", "Main.kt"),
      path.join(tempDir, "kotlin", "script.kts"),
      path.join(tempDir, "docs", "guide.md"),
      path.join(tempDir, "docs", "page.mdx"),
      path.join(tempDir, "docs", "page.astro"),
      path.join(tempDir, "docs", "template.hbs"),
      path.join(tempDir, "docs", "template.handlebars"),
      path.join(tempDir, "docs", "index.rst"),
      path.join(tempDir, "docs", "index.adoc"),
      path.join(tempDir, "docs", "index.asciidoc"),
      path.join(tempDir, "php", "index.php"),
      path.join(tempDir, "swift", "App.swift"),
      path.join(tempDir, "zig", "main.zig"),
      path.join(tempDir, "c", "main.c"),
      path.join(tempDir, "c", "utils.h"),
      path.join(tempDir, "cpp", "main.cpp"),
      path.join(tempDir, "cpp", "types.hpp"),
      path.join(tempDir, "db", "schema.sql"),
    ];

    await Promise.all(
      files.map(async (filePath) => {
        await createFile(filePath, "// test fixture\n");
      }),
    );

    const discovered = await listProjectFiles(tempDir);
    const discoveredSet = new Set(discovered.map(normalize));

    for (const filePath of files.map(normalize)) {
      expect(discoveredSet.has(filePath)).toBe(true);
    }
  });

  it.skipIf(os.platform() === "win32")("keeps ordinary ignore globs case-sensitive on POSIX", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-ignore-case-"));
    const keptFile = path.join(tempDir, "Tests", "kept.ts");
    await createFile(keptFile, "export const kept = 1;\n");

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: ["tests/**"],
      useGitignore: false,
    });

    expect(discovered.map(normalize)).toContain(normalize(keptFile));
  });

  it("filters discovered files whose realpath escapes the project root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-root-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-outside-"));
    const outsideFile = path.join(outsideDir, "secret.ts");
    const linkedFile = path.join(tempDir, "linked-secret.ts");
    await createFile(path.join(tempDir, "src", "main.ts"), "export const main = 1;\n");
    await createFile(outsideFile, "export const secret = 1;\n");

    try {
      await fs.symlink(outsideFile, linkedFile, "file");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], { ignoreGlobs: [] });
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(path.join(tempDir, "src", "main.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(linkedFile))).toBe(false);
    expect(discoveredSet.has(normalize(outsideFile))).toBe(false);
  });

  it("traverses symlinked directories only when their realpath stays inside the project root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-dir-root-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const linkedPackage = path.join(tempDir, "linked-core");
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-dir-outside-"));
    const linkedOutside = path.join(tempDir, "linked-outside");
    await createFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n");
    await createFile(path.join(outsideDir, "secret.ts"), "export const secret = 1;\n");

    try {
      await fs.symlink(packageDir, linkedPackage, "junction");
      await fs.symlink(outsideDir, linkedOutside, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], { ignoreGlobs: [] });
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(path.join(packageDir, "src", "index.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(linkedPackage, "src", "index.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(linkedOutside, "secret.ts")))).toBe(false);
  });

  it("applies root-relative ignore globs to safe symlink directory crawls", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-ignore-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const linkedPackage = path.join(tempDir, "linked-core");
    await createFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n");

    try {
      await fs.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: ["linked-core/src/**"],
      useGitignore: false,
    });
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(path.join(packageDir, "src", "index.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(linkedPackage, "src", "index.ts")))).toBe(false);
  });

  it.skipIf(os.platform() === "win32")(
    "keeps ordinary ignore globs case-sensitive while crawling safe symlink directories on POSIX",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-ignore-case-"));
      const packageDir = path.join(tempDir, "packages", "core");
      const linkedPackage = path.join(tempDir, "Tests");
      const linkedFile = path.join(linkedPackage, "kept.ts");
      await createFile(path.join(packageDir, "kept.ts"), "export const kept = 1;\n");

      try {
        await fs.symlink(packageDir, linkedPackage, "junction");
      } catch (error) {
        if (isSymlinkUnavailable(error)) return;
        throw error;
      }

      const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
        ignoreGlobs: ["tests/**"],
        useGitignore: false,
      });

      expect(discovered.map(normalize)).toContain(normalize(linkedFile));
    },
  );

  it("does not apply project-root ignore globs relative to safe symlink directory targets", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-root-ignore-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const linkedPackage = path.join(tempDir, "linked-core");
    await createFile(path.join(tempDir, "src", "ignored.ts"), "export const ignored = 1;\n");
    await createFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n");

    try {
      await fs.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: ["src/**"],
      useGitignore: false,
    });
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(path.join(tempDir, "src", "ignored.ts")))).toBe(false);
    expect(discoveredSet.has(normalize(path.join(packageDir, "src", "index.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(linkedPackage, "src", "index.ts")))).toBe(true);
  });

  it("applies gitignore rules to safe symlink directory targets by real path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-gitignore-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const linkedPackage = path.join(tempDir, "linked-core");
    await createFile(path.join(tempDir, ".gitignore"), "packages/core/ignored.ts\n");
    await createFile(path.join(packageDir, "kept.ts"), "export const kept = 1;\n");
    await createFile(path.join(packageDir, "ignored.ts"), "export const ignored = 1;\n");

    try {
      await fs.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"]);
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(path.join(packageDir, "kept.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(linkedPackage, "kept.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(packageDir, "ignored.ts")))).toBe(false);
    expect(discoveredSet.has(normalize(path.join(linkedPackage, "ignored.ts")))).toBe(false);
  });

  it("applies gitignore rules to safe symlink targets when the project root is a symlink", async () => {
    const realRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-real-root-gitignore-"));
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-root-link-parent-"));
    const rootLink = path.join(parent, "repo-link");
    const packageDir = path.join(realRoot, "packages", "core");
    const linkedPackage = path.join(realRoot, "linked-core");
    await createFile(path.join(realRoot, ".gitignore"), "packages/core/ignored.ts\n");
    await createFile(path.join(packageDir, "kept.ts"), "export const kept = 1;\n");
    await createFile(path.join(packageDir, "ignored.ts"), "export const ignored = 1;\n");

    try {
      await fs.symlink(realRoot, rootLink, "junction");
      await fs.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discovered = await listProjectFiles(rootLink, ["**/*.ts"]);
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(path.join(rootLink, "linked-core", "kept.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(rootLink, "linked-core", "ignored.ts")))).toBe(false);
  });

  it("discovers project metadata through safe symlink directories", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-manifest-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const linkedPackage = path.join(tempDir, "linked-core");
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-manifest-outside-"));
    const linkedOutside = path.join(tempDir, "linked-outside");
    await createFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "core" }, null, 2));
    await createFile(path.join(outsideDir, "package.json"), JSON.stringify({ name: "outside" }, null, 2));

    try {
      await fs.symlink(packageDir, linkedPackage, "junction");
      await fs.symlink(outsideDir, linkedOutside, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discovered = await discoverProjectFiles(tempDir);
    const discoveredPaths = new Set(discovered.map((entry) => normalize(entry.path)));

    expect(discoveredPaths.has(normalize(path.join(packageDir, "package.json")))).toBe(true);
    expect(discoveredPaths.has(normalize(path.join(linkedPackage, "package.json")))).toBe(true);
    expect(discoveredPaths.has(normalize(path.join(linkedOutside, "package.json")))).toBe(false);
  });

  it("extracts project names from common manifests", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-meta-"));
    const nodeDir = path.join(tempDir, "node");
    const pythonDir = path.join(tempDir, "python");
    const rustDir = path.join(tempDir, "rust");
    const goDir = path.join(tempDir, "go");
    const javaDir = path.join(tempDir, "java");
    const gradleDir = path.join(tempDir, "gradle");
    const kotlinDir = path.join(tempDir, "kotlin");
    const dotnetDir = path.join(tempDir, "dotnet");
    const ideDir = path.join(tempDir, "ide");
    const swiftDir = path.join(tempDir, "swift");
    const swiftIdeDir = path.join(tempDir, "swift-ide");
    const gemDir = path.join(tempDir, "gem");
    const nativeDir = path.join(tempDir, "native");

    const packageJson = path.join(nodeDir, "package.json");
    const pyproject = path.join(pythonDir, "pyproject.toml");
    const cargo = path.join(rustDir, "Cargo.toml");
    const goMod = path.join(goDir, "go.mod");
    const pom = path.join(javaDir, "pom.xml");
    const settingsGradle = path.join(gradleDir, "settings.gradle");
    const settingsGradleKts = path.join(kotlinDir, "settings.gradle.kts");
    const csproj = path.join(dotnetDir, "App.csproj");
    const fsproj = path.join(dotnetDir, "Library.fsproj");
    const vbproj = path.join(dotnetDir, "Widget.vbproj");
    const sln = path.join(dotnetDir, "Solution.sln");
    const swiftPackage = path.join(swiftDir, "Package.swift");
    const xcodeprojDir = path.join(swiftIdeDir, "App.xcodeproj");
    const xcworkspaceDir = path.join(swiftIdeDir, "App.xcworkspace");
    const gemspec = path.join(gemDir, "ruby-gem.gemspec");
    const cmakeLists = path.join(nativeDir, "CMakeLists.txt");
    const vcpkg = path.join(nativeDir, "vcpkg.json");
    const ideaDir = path.join(ideDir, ".idea");

    await createFile(packageJson, JSON.stringify({ name: "node-app" }, null, 2));
    await createFile(pyproject, '[project]\nname = "py-app"\n');
    await createFile(cargo, '[package]\nname = "rust-app"\n');
    await createFile(goMod, "module example.com/go-app\n");
    await createFile(pom, "<project><artifactId>mvn-app</artifactId></project>");
    await createFile(settingsGradle, 'rootProject.name = "gradle-app"\n');
    await createFile(settingsGradleKts, 'rootProject.name = "kotlin-app"\n');
    await createFile(
      csproj,
      "<Project><PropertyGroup><AssemblyName>DotNetApp</AssemblyName></PropertyGroup></Project>",
    );
    await createFile(
      fsproj,
      "<Project><PropertyGroup><AssemblyName>FSharpLib</AssemblyName></PropertyGroup></Project>",
    );
    await createFile(vbproj, "<Project><PropertyGroup><PackageId>VisualBasicLib</PackageId></PropertyGroup></Project>");
    await createFile(sln, "Microsoft Visual Studio Solution File, Format Version 12.00\n");
    await createFile(swiftPackage, 'import PackageDescription\n\nlet package = Package(name: "swift-app")\n');
    await fs.mkdir(xcodeprojDir, { recursive: true });
    await fs.mkdir(xcworkspaceDir, { recursive: true });
    await createFile(gemspec, 'Gem::Specification.new do |spec|\n  spec.name = "ruby-gem"\nend\n');
    await createFile(cmakeLists, "cmake_minimum_required(VERSION 3.20)\n");
    await createFile(vcpkg, JSON.stringify({ name: "native-app" }, null, 2));
    await fs.mkdir(ideaDir, { recursive: true });

    const discovered = await discoverProjectFiles(tempDir);
    const byPath = new Map(discovered.map((entry) => [normalize(entry.path), entry]));

    expect(byPath.get(normalize(packageJson))?.name).toBe("node-app");
    expect(byPath.get(normalize(packageJson))?.type).toBe("node");
    expect(byPath.get(normalize(pyproject))?.name).toBe("py-app");
    expect(byPath.get(normalize(pyproject))?.type).toBe("python");
    expect(byPath.get(normalize(cargo))?.name).toBe("rust-app");
    expect(byPath.get(normalize(cargo))?.type).toBe("rust");
    expect(byPath.get(normalize(goMod))?.name).toBe("example.com/go-app");
    expect(byPath.get(normalize(goMod))?.type).toBe("go");
    expect(byPath.get(normalize(pom))?.name).toBe("mvn-app");
    expect(byPath.get(normalize(pom))?.type).toBe("maven");
    expect(byPath.get(normalize(settingsGradle))?.name).toBe("gradle-app");
    expect(byPath.get(normalize(settingsGradle))?.type).toBe("gradle");
    expect(byPath.get(normalize(settingsGradleKts))?.name).toBe("kotlin-app");
    expect(byPath.get(normalize(settingsGradleKts))?.type).toBe("gradle");
    expect(byPath.get(normalize(csproj))?.name).toBe("DotNetApp");
    expect(byPath.get(normalize(csproj))?.role).toBe("manifest");
    expect(byPath.get(normalize(fsproj))?.name).toBe("FSharpLib");
    expect(byPath.get(normalize(fsproj))?.type).toBe("dotnet");
    expect(byPath.get(normalize(vbproj))?.name).toBe("VisualBasicLib");
    expect(byPath.get(normalize(vbproj))?.type).toBe("dotnet");
    expect(byPath.get(normalize(sln))?.name).toBe("Solution");
    expect(byPath.get(normalize(sln))?.role).toBe("solution");
    expect(byPath.get(normalize(swiftPackage))?.name).toBe("swift-app");
    expect(byPath.get(normalize(swiftPackage))?.type).toBe("swift");
    expect(byPath.get(normalize(xcodeprojDir))?.kind).toBe("dir");
    expect(byPath.get(normalize(xcodeprojDir))?.type).toBe("swift");
    expect(byPath.get(normalize(xcodeprojDir))?.name).toBe("App");
    expect(byPath.get(normalize(xcworkspaceDir))?.kind).toBe("dir");
    expect(byPath.get(normalize(xcworkspaceDir))?.type).toBe("swift");
    expect(byPath.get(normalize(gemspec))?.name).toBe("ruby-gem");
    expect(byPath.get(normalize(gemspec))?.type).toBe("ruby");
    expect(byPath.get(normalize(cmakeLists))?.type).toBe("native");
    expect(byPath.get(normalize(cmakeLists))?.name).toBe("native");
    expect(byPath.get(normalize(vcpkg))?.type).toBe("native");
    expect(byPath.get(normalize(vcpkg))?.name).toBe("native-app");
    expect(byPath.get(normalize(ideaDir))?.projectRoot).toBe(normalize(ideDir));
    expect(byPath.get(normalize(ideaDir))?.kind).toBe("dir");
    expect(byPath.get(normalize(ideaDir))?.role).toBe("ide");
  });

  it("handles fallback naming and ignores excluded directories", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-edge-"));
    const badJsonDir = path.join(tempDir, "bad-json");
    const poetryDir = path.join(tempDir, "poetry");
    const cargoDir = path.join(tempDir, "cargo");
    const pomDir = path.join(tempDir, "pom");
    const gradleDir = path.join(tempDir, "gradle");
    const dotnetDir = path.join(tempDir, "dotnet");
    const composerDir = path.join(tempDir, "composer");
    const workspaceDir = path.join(tempDir, "workspace");
    const goWorkDir = path.join(tempDir, "go-workspace");
    const toolchainDir = path.join(tempDir, "toolchain");
    const wrapperDir = path.join(tempDir, "wrappers");
    const dotnetConfigDir = path.join(tempDir, "dotnet-config");
    const nativeConfigDir = path.join(tempDir, "native-config");
    const swiftLockDir = path.join(tempDir, "swift-lock");
    const ignoredDir = path.join(tempDir, "node_modules", "ignored");

    const badPackage = path.join(badJsonDir, "package.json");
    const pyproject = path.join(poetryDir, "pyproject.toml");
    const cargo = path.join(cargoDir, "Cargo.toml");
    const pom = path.join(pomDir, "pom.xml");
    const gradle = path.join(gradleDir, "build.gradle");
    const csproj = path.join(dotnetDir, "Library.csproj");
    const composer = path.join(composerDir, "composer.json");
    const pnpmWorkspace = path.join(workspaceDir, "pnpm-workspace.yaml");
    const lerna = path.join(workspaceDir, "lerna.json");
    const nx = path.join(workspaceDir, "nx.json");
    const turbo = path.join(workspaceDir, "turbo.json");
    const goWork = path.join(goWorkDir, "go.work");
    const rustToolchain = path.join(toolchainDir, "rust-toolchain");
    const rustToolchainToml = path.join(toolchainDir, "rust-toolchain.toml");
    const mvnw = path.join(wrapperDir, "mvnw");
    const gradlew = path.join(wrapperDir, "gradlew");
    const dirBuildProps = path.join(dotnetConfigDir, "Directory.Build.props");
    const dirBuildTargets = path.join(dotnetConfigDir, "Directory.Build.targets");
    const globalJson = path.join(dotnetConfigDir, "global.json");
    const cmakePresets = path.join(nativeConfigDir, "CMakePresets.json");
    const mesonOptions = path.join(nativeConfigDir, "meson_options.txt");
    const conanfile = path.join(nativeConfigDir, "conanfile.txt");
    const packageResolved = path.join(swiftLockDir, "Package.resolved");
    const ignoredPackage = path.join(ignoredDir, "package.json");

    await createFile(badPackage, "{ invalid json");
    await createFile(pyproject, "[tool.poetry]\nname = 'poetry-app' # comment\n");
    await createFile(cargo, '[package]\nname = "cargo-app" # comment\n');
    await createFile(pom, "<project><parent><name>Parent</name></parent><name>PomApp</name></project>");
    await createFile(gradle, 'plugins { id "java" }\n');
    await createFile(csproj, "<Project></Project>");
    await createFile(composer, JSON.stringify({ name: "vendor/app" }, null, 2));
    await createFile(pnpmWorkspace, 'packages:\n  - "packages/*"\n');
    await createFile(lerna, JSON.stringify({ name: "lerna-space" }, null, 2));
    await createFile(nx, JSON.stringify({ name: "nx-space" }, null, 2));
    await createFile(turbo, JSON.stringify({ name: "turbo-space" }, null, 2));
    await createFile(goWork, "go 1.20\nuse ./module\n");
    await createFile(rustToolchain, "stable\n");
    await createFile(rustToolchainToml, '[toolchain]\nchannel = "stable"\n');
    await createFile(mvnw, "#!/bin/sh\n");
    await createFile(gradlew, "#!/bin/sh\n");
    await createFile(dirBuildProps, "<Project></Project>\n");
    await createFile(dirBuildTargets, "<Project></Project>\n");
    await createFile(globalJson, JSON.stringify({ sdk: { version: "8.0.100" } }, null, 2));
    await createFile(cmakePresets, JSON.stringify({ version: 3 }, null, 2));
    await createFile(mesonOptions, 'option("feature", type : "boolean", value : true)\n');
    await createFile(conanfile, "[requires]\nfmt/10.1.1\n");
    await createFile(packageResolved, JSON.stringify({ version: 2, pins: [] }, null, 2));
    await createFile(ignoredPackage, JSON.stringify({ name: "ignored" }, null, 2));

    const discovered = await discoverProjectFiles(tempDir);
    const byPath = new Map(discovered.map((entry) => [normalize(entry.path), entry]));

    const badEntry = byPath.get(normalize(badPackage));
    expect(badEntry?.name).toBe("bad-json");
    expect(badEntry?.type).toBe("node");
    expect(badEntry?.role).toBe("manifest");
    expect(byPath.get(normalize(pyproject))?.name).toBe("poetry-app");
    expect(byPath.get(normalize(cargo))?.name).toBe("cargo-app");
    expect(byPath.get(normalize(pom))?.name).toBe("PomApp");
    expect(byPath.get(normalize(gradle))?.name).toBe("gradle");
    expect(byPath.get(normalize(csproj))?.name).toBe("Library");
    expect(byPath.get(normalize(composer))?.name).toBe("vendor/app");
    expect(byPath.get(normalize(pnpmWorkspace))?.type).toBe("node");
    expect(byPath.get(normalize(pnpmWorkspace))?.role).toBe("config");
    expect(byPath.get(normalize(pnpmWorkspace))?.name).toBe("workspace");
    expect(byPath.get(normalize(lerna))?.name).toBe("lerna-space");
    expect(byPath.get(normalize(lerna))?.type).toBe("node");
    expect(byPath.get(normalize(nx))?.name).toBe("nx-space");
    expect(byPath.get(normalize(nx))?.type).toBe("node");
    expect(byPath.get(normalize(turbo))?.name).toBe("turbo-space");
    expect(byPath.get(normalize(turbo))?.type).toBe("node");
    expect(byPath.get(normalize(goWork))?.type).toBe("go");
    expect(byPath.get(normalize(goWork))?.role).toBe("config");
    expect(byPath.get(normalize(goWork))?.name).toBe("go-workspace");
    expect(byPath.get(normalize(rustToolchain))?.type).toBe("rust");
    expect(byPath.get(normalize(rustToolchain))?.role).toBe("config");
    expect(byPath.get(normalize(rustToolchain))?.name).toBe("toolchain");
    expect(byPath.get(normalize(rustToolchainToml))?.type).toBe("rust");
    expect(byPath.get(normalize(rustToolchainToml))?.role).toBe("config");
    expect(byPath.get(normalize(mvnw))?.type).toBe("maven");
    expect(byPath.get(normalize(mvnw))?.role).toBe("config");
    expect(byPath.get(normalize(mvnw))?.name).toBe("wrappers");
    expect(byPath.get(normalize(gradlew))?.type).toBe("gradle");
    expect(byPath.get(normalize(gradlew))?.role).toBe("config");
    expect(byPath.get(normalize(gradlew))?.name).toBe("wrappers");
    expect(byPath.get(normalize(dirBuildProps))?.type).toBe("dotnet");
    expect(byPath.get(normalize(dirBuildProps))?.role).toBe("config");
    expect(byPath.get(normalize(dirBuildProps))?.name).toBe("dotnet-config");
    expect(byPath.get(normalize(dirBuildTargets))?.type).toBe("dotnet");
    expect(byPath.get(normalize(dirBuildTargets))?.role).toBe("config");
    expect(byPath.get(normalize(globalJson))?.type).toBe("dotnet");
    expect(byPath.get(normalize(globalJson))?.role).toBe("config");
    expect(byPath.get(normalize(cmakePresets))?.type).toBe("native");
    expect(byPath.get(normalize(cmakePresets))?.role).toBe("config");
    expect(byPath.get(normalize(cmakePresets))?.name).toBe("native-config");
    expect(byPath.get(normalize(mesonOptions))?.type).toBe("native");
    expect(byPath.get(normalize(mesonOptions))?.role).toBe("config");
    expect(byPath.get(normalize(conanfile))?.type).toBe("native");
    expect(byPath.get(normalize(conanfile))?.role).toBe("manifest");
    expect(byPath.get(normalize(packageResolved))?.type).toBe("swift");
    expect(byPath.get(normalize(packageResolved))?.role).toBe("lockfile");
    expect(byPath.has(normalize(ignoredPackage))).toBe(false);
  });

  it("honors root and nested .gitignore files by default", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-gitignore-"));
    const keptRootFile = path.join(tempDir, "src", "keep.ts");
    const ignoredRootFile = path.join(tempDir, "src", "drop.generated.ts");
    const keptNestedFile = path.join(tempDir, "nested", "keep.ts");
    const ignoredNestedFile = path.join(tempDir, "nested", "tmp", "drop.ts");

    await createFile(path.join(tempDir, ".gitignore"), "*.generated.ts\n");
    await createFile(path.join(tempDir, "nested", ".gitignore"), "tmp/\n");
    await createFile(keptRootFile, "export const keepRoot = 1;\n");
    await createFile(ignoredRootFile, "export const dropRoot = 1;\n");
    await createFile(keptNestedFile, "export const keepNested = 1;\n");
    await createFile(ignoredNestedFile, "export const dropNested = 1;\n");

    const discovered = new Set((await listProjectFiles(tempDir)).map(normalize));

    expect(discovered.has(normalize(keptRootFile))).toBe(true);
    expect(discovered.has(normalize(keptNestedFile))).toBe(true);
    expect(discovered.has(normalize(ignoredRootFile))).toBe(false);
    expect(discovered.has(normalize(ignoredNestedFile))).toBe(false);
  });

  it("does not load nested .gitignore files from directories ignored by a parent .gitignore", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-gitignore-shadow-"));
    const ignoredFile = path.join(tempDir, "tmp", "keep.ts");
    const keptFile = path.join(tempDir, "src", "keep.ts");

    await createFile(path.join(tempDir, ".gitignore"), "tmp/\n");
    await createFile(path.join(tempDir, "tmp", ".gitignore"), "!keep.ts\n");
    await createFile(ignoredFile, "export const shouldStayIgnored = 1;\n");
    await createFile(keptFile, "export const keep = 1;\n");

    const discovered = new Set((await listProjectFiles(tempDir)).map(normalize));

    expect(discovered.has(normalize(keptFile))).toBe(true);
    expect(discovered.has(normalize(ignoredFile))).toBe(false);
  });

  it("treats non-slash directory patterns as directory subtree ignores", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-gitignore-dir-"));
    const ignoredFile = path.join(tempDir, "tmp", "generated.ts");
    const keptFile = path.join(tempDir, "src", "keep.ts");

    await createFile(path.join(tempDir, ".gitignore"), "tmp\n");
    await createFile(path.join(tempDir, "tmp", ".gitignore"), "!generated.ts\n");
    await createFile(ignoredFile, "export const generated = 1;\n");
    await createFile(keptFile, "export const keep = 1;\n");

    const discovered = new Set((await listProjectFiles(tempDir)).map(normalize));

    expect(discovered.has(normalize(keptFile))).toBe(true);
    expect(discovered.has(normalize(ignoredFile))).toBe(false);
  });

  it("supports disabling .gitignore filtering and applying additive include/ignore globs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-discovery-"));
    const appFile = path.join(tempDir, "src", "app.ts");
    const specFile = path.join(tempDir, "src", "app.spec.ts");
    const ignoredFile = path.join(tempDir, "src", "generated.ts");
    const jsFile = path.join(tempDir, "src", "legacy.js");

    await createFile(path.join(tempDir, ".gitignore"), "src/generated.ts\n");
    await createFile(appFile, "export const app = 1;\n");
    await createFile(specFile, "export const testApp = 1;\n");
    await createFile(ignoredFile, "export const generated = 1;\n");
    await createFile(jsFile, "module.exports = 1;\n");

    const discovered = new Set(
      (
        await listProjectFiles(tempDir, undefined, {
          includeGlobs: ["src/**/*.ts"],
          ignoreGlobs: ["src/**/*.spec.ts"],
          useGitignore: false,
        })
      ).map(normalize),
    );

    expect(discovered.has(normalize(appFile))).toBe(true);
    expect(discovered.has(normalize(ignoredFile))).toBe(true);
    expect(discovered.has(normalize(specFile))).toBe(false);
    expect(discovered.has(normalize(jsFile))).toBe(false);
  });

  it("evaluates include and ignore globs against globRoot when scanning a child root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-discovery-glob-root-"));
    const testsDir = path.join(tempDir, "tests");
    const keptFile = path.join(testsDir, "unit", "app.test.ts");
    const ignoredFile = path.join(testsDir, "samples", "fixture.ts");

    await createFile(keptFile, "export const appTest = 1;\n");
    await createFile(ignoredFile, "export const fixture = 1;\n");

    const discovered = new Set(
      (
        await listProjectFiles(testsDir, undefined, {
          globRoot: tempDir,
          includeGlobs: ["tests/**/*.ts"],
          ignoreGlobs: ["tests/samples/**"],
          useGitignore: false,
        })
      ).map(normalize),
    );

    expect(discovered.has(normalize(keptFile))).toBe(true);
    expect(discovered.has(normalize(ignoredFile))).toBe(false);
  });

  it("translates project-root ignore globs for child-root fast-glob pruning", () => {
    const projectRoot = path.resolve("repo");
    const testsRoot = path.join(projectRoot, "tests");

    expect(
      translateGlobRootIgnoreGlobsForScanRoot(testsRoot, projectRoot, [
        "tests/samples/**",
        "tests\\fixtures\\**",
        "**/node_modules/**",
        "src/generated/**",
      ]),
    ).toEqual(["samples/**", "fixtures/**", "**/node_modules/**"]);
  });

  it("does not prune child-root files with out-of-scope project-root ignore globs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-discovery-out-of-scope-ignore-"));
    const testsDir = path.join(tempDir, "tests");
    const keptFile = path.join(testsDir, "src", "generated", "fixture.ts");
    const testFile = path.join(testsDir, "unit", "app.test.ts");

    await createFile(keptFile, "export const fixture = 1;\n");
    await createFile(testFile, "export const appTest = 1;\n");

    const discovered = new Set(
      (
        await listProjectFiles(testsDir, undefined, {
          globRoot: tempDir,
          ignoreGlobs: ["src/generated/**"],
          useGitignore: false,
        })
      ).map(normalize),
    );

    expect(discovered.has(normalize(keptFile))).toBe(true);
    expect(discovered.has(normalize(testFile))).toBe(true);
  });

  it("treats cross-drive relative paths as outside a glob root", () => {
    expect([
      isRelativePathInside("src/app.ts"),
      isRelativePathInside("../outside.ts"),
      isRelativePathInside("D:\\other\\fixture.ts"),
      isRelativePathInside("D:/other/fixture.ts"),
    ]).toEqual([true, false, false, false]);
  });

  it("does not validate gitignoreRoot when gitignore filtering is disabled", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-discovery-no-gitignore-root-"));
    const appFile = path.join(tempDir, "src", "app.ts");

    await createFile(appFile, "export const app = 1;\n");

    const discovered = await listProjectFiles(tempDir, undefined, {
      useGitignore: false,
      gitignoreRoot: path.join(tempDir, "missing-gitignore-root"),
    });

    expect(discovered.map(normalize)).toContain(normalize(appFile));
  });

  it("skips the full-tree symlink probe when knownSymlinkDirectories is provided and re-verifies each entry", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-known-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const linkedPackage = path.join(tempDir, "linked-core");
    await createFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n");

    try {
      await fs.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discoveredCallback = vi.fn();
    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: [],
      knownSymlinkDirectories: [linkedPackage],
      onSymlinkDirectoriesDiscovered: discoveredCallback,
    });
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(path.join(linkedPackage, "src", "index.ts")))).toBe(true);
    // The fast path re-verifies known entries directly and reports the verified list
    // back so callers can refresh stale manifest hints without probing.
    expect(discoveredCallback).toHaveBeenCalledTimes(1);
    const reported = (discoveredCallback.mock.calls[0]?.[0] as string[]).map(normalize);
    expect(reported).toEqual([normalize(linkedPackage)]);
  });

  it("drops a known symlink directory that no longer resolves to a directory inside the root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-stale-known-"));
    const staleLinkPath = path.join(tempDir, "removed-link");

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: [],
      knownSymlinkDirectories: [staleLinkPath],
    });

    // The recorded symlink path no longer exists on disk; the fast path must silently
    // drop it instead of throwing or returning phantom files.
    expect(discovered).toEqual([]);
  });

  it("drops known symlink-directory hints that are real directories rather than symlinks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-real-dir-known-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const sourceFile = path.join(packageDir, "src", "index.ts");
    await createFile(sourceFile, "export const core = 1;\n");

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: [],
      knownSymlinkDirectories: [packageDir],
    });
    const matching = discovered.map(normalize).filter((file) => file === normalize(sourceFile));

    expect(matching).toHaveLength(1);
  });

  it("drops known symlink-directory hints whose link path is outside the project root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-outside-known-root-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-outside-known-link-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const outsideLink = path.join(outsideDir, "outside-linked-core");
    await createFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n");

    try {
      await fs.symlink(packageDir, outsideLink, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discoveredCallback = vi.fn();
    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: [],
      knownSymlinkDirectories: [outsideLink],
      onSymlinkDirectoriesDiscovered: discoveredCallback,
    });
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(path.join(packageDir, "src", "index.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(outsideLink, "src", "index.ts")))).toBe(false);
    expect(discoveredCallback).toHaveBeenCalledWith([]);
  });

  it("reports the discovered symlink directories through onSymlinkDirectoriesDiscovered on a probing run", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-report-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const linkedPackage = path.join(tempDir, "linked-core");
    await createFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n");

    try {
      await fs.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discoveredCallback = vi.fn();
    await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: [],
      onSymlinkDirectoriesDiscovered: discoveredCallback,
    });

    expect(discoveredCallback).toHaveBeenCalledTimes(1);
    const reported = (discoveredCallback.mock.calls[0]?.[0] as string[]).map(normalize);
    expect(reported).toContain(normalize(linkedPackage));
  });

  it("reports an empty array through onSymlinkDirectoriesDiscovered when a project has no symlinks", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-none-"));
    await createFile(path.join(tempDir, "src", "index.ts"), "export const value = 1;\n");

    const discoveredCallback = vi.fn();
    await listProjectFiles(tempDir, ["**/*.ts"], {
      ignoreGlobs: [],
      onSymlinkDirectoriesDiscovered: discoveredCallback,
    });

    expect(discoveredCallback).toHaveBeenCalledWith([]);
  });
});

describe("createDiscoveredFileMatcher", () => {
  it("accepts files matching project patterns and rejects everything else", () => {
    const root = normalize(path.resolve("/tmp/codegraph-matcher-root"));
    const isDiscovered = createDiscoveredFileMatcher(root, root, ["**/*.ts"], undefined);

    expect(isDiscovered(`${root}/src/index.ts`)).toBe(true);
    expect(isDiscovered(`${root}/notes.txt`)).toBe(false);
    expect(isDiscovered(`${root}/node_modules/pkg/index.ts`)).toBe(false);
    expect(isDiscovered(`${root}/.codegraph/manifest.json`)).toBe(false);
    expect(isDiscovered(`${root}/.codegraph-cache/index-v1/manifest.json`)).toBe(false);
    expect(isDiscovered(`${root}/.codegraph-cache/index-v1/notes.md`)).toBe(false);
    expect(isDiscovered(`/outside/index.ts`)).toBe(false);
  });

  it("applies user include and ignore globs relative to globRoot", () => {
    const root = normalize(path.resolve("/tmp/codegraph-matcher-root"));
    const isDiscovered = createDiscoveredFileMatcher(root, root, ["**/*.ts"], {
      includeGlobs: ["src/**"],
      ignoreGlobs: ["src/generated/**"],
    });

    expect(isDiscovered(`${root}/src/index.ts`)).toBe(true);
    expect(isDiscovered(`${root}/src/generated/output.ts`)).toBe(false);
    expect(isDiscovered(`${root}/other/index.ts`)).toBe(false);
  });
});
