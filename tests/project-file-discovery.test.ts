import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { buildProjectIndex, listProjectFiles, discoverProjectFiles } from "../src/index.js";
import { DEFAULT_PROJECT_MANIFESTS } from "../src/util.js";
import {
  createDiscoveredFileMatcher,
  DEFAULT_PROJECT_FILE_IGNORES,
  discoverProjectFilesWithGitCandidates,
  isRelativePathInside,
  listProjectFilesWithGitCandidates,
  translateGlobRootIgnoreGlobsForScanRoot,
  type GitCandidateSet,
} from "../src/util/projectFiles.js";
import { parseDotnetName, parseGoModuleName, parsePomName, parseTomlName } from "../src/util/projectFiles/parsers.js";
import { isSymlinkUnavailable } from "./helpers/filesystem.js";
import { runGit as git } from "./helpers/git.js";
import {
  clearGitDiscoveryCacheForTests,
  clearGitRepositoryCheckCacheForTests,
  listGitIgnoreFiles,
  listGitSubmoduleDirectories,
  setGitExecutableForTests,
} from "../src/util/git.js";

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

  it("excludes vendored dependency trees by default across ecosystems", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-default-ignores-"));
    const keptRuby = path.join(tempDir, "app", "main.rb");
    const keptPython = path.join(tempDir, "src", "main.py");
    const keptSwift = path.join(tempDir, "Sources", "App.swift");
    const excluded = [
      path.join(tempDir, "vendor", "bundle", "gems", "example", "lib", "example.rb"),
      path.join(tempDir, ".venv", "lib", "python3.12", "site-packages", "pkg", "mod.py"),
      path.join(tempDir, "venv", "lib", "python3.12", "site-packages", "pkg", "mod.py"),
      path.join(tempDir, "lib", "python3.12", "site-packages", "pkg", "mod.py"),
      path.join(tempDir, ".build", "debug", "App.swift"),
      path.join(tempDir, "Pods", "AFNetworking", "AFNetworking.h"),
      path.join(tempDir, "env", "config.py"),
      path.join(tempDir, "vendor", "first_party.go"),
      path.join(tempDir, "bin", "tools.ts"),
      path.join(tempDir, "obj", "Debug", "app.cs"),
    ];

    await createFile(keptRuby, "puts 1\n");
    await createFile(keptPython, "x = 1\n");
    await createFile(keptSwift, "struct App {}\n");
    await Promise.all(excluded.map(async (filePath) => createFile(filePath, "// excluded fixture\n")));

    const discovered = await listProjectFiles(tempDir, undefined, { useGitignore: false });
    const discoveredSet = new Set(discovered.map(normalize));

    expect(discoveredSet.has(normalize(keptRuby))).toBe(true);
    expect(discoveredSet.has(normalize(keptPython))).toBe(true);
    expect(discoveredSet.has(normalize(keptSwift))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(tempDir, "env", "config.py")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(tempDir, "vendor", "first_party.go")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(tempDir, "bin", "tools.ts")))).toBe(true);
    expect(discoveredSet.has(normalize(path.join(tempDir, "obj", "Debug", "app.cs")))).toBe(true);

    for (const filePath of [
      path.join(tempDir, "vendor", "bundle", "gems", "example", "lib", "example.rb"),
      path.join(tempDir, ".venv", "lib", "python3.12", "site-packages", "pkg", "mod.py"),
      path.join(tempDir, "venv", "lib", "python3.12", "site-packages", "pkg", "mod.py"),
      path.join(tempDir, "lib", "python3.12", "site-packages", "pkg", "mod.py"),
      path.join(tempDir, ".build", "debug", "App.swift"),
      path.join(tempDir, "Pods", "AFNetworking", "AFNetworking.h"),
    ]) {
      expect(discoveredSet.has(normalize(filePath))).toBe(false);
    }
  });

  it("lets includeGlobs re-include default-ignored vendored directories", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-ignore-override-"));
    const kept = path.join(tempDir, "src", "main.py");
    const vendored = path.join(tempDir, "vendor", "bundle", "gems", "example", "lib", "example.rb");
    const sitePackage = path.join(tempDir, ".venv", "lib", "python3.12", "site-packages", "pkg", "mod.py");
    await createFile(kept, "x = 1\n");
    await createFile(vendored, "puts 1\n");
    await createFile(sitePackage, "x = 1\n");

    const excludedByDefault = await listProjectFiles(tempDir, undefined, { useGitignore: false });
    const excludedSet = new Set(excludedByDefault.map(normalize));
    expect(excludedSet.has(normalize(vendored))).toBe(false);
    expect(excludedSet.has(normalize(sitePackage))).toBe(false);
    expect(excludedSet.has(normalize(kept))).toBe(true);

    const overridden = await listProjectFiles(tempDir, undefined, {
      includeGlobs: ["vendor/bundle/**", ".venv/**"],
      useGitignore: false,
    });
    const overriddenSet = new Set(overridden.map(normalize));
    expect(overriddenSet.has(normalize(vendored))).toBe(true);
    expect(overriddenSet.has(normalize(sitePackage))).toBe(true);
    expect(overriddenSet.has(normalize(kept))).toBe(false);
  });

  it("traverses a safe symlink rooted in an explicitly included ignored directory", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-project-link-include-override-"));
    const packageDir = path.join(tempDir, "packages", "core");
    const linkedPackage = path.join(tempDir, "node_modules");
    const linkedFile = path.join(linkedPackage, "src", "index.ts");
    await createFile(path.join(packageDir, "src", "index.ts"), "export const core = 1;\n");
    try {
      await fs.symlink(packageDir, linkedPackage, "junction");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const discovered = await listProjectFiles(tempDir, ["**/*.ts"], {
      includeGlobs: ["node_modules/**"],
      useGitignore: false,
    });

    expect(discovered.map(normalize)).toEqual([normalize(linkedFile)]);
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
    expect(discoveredCallback).toHaveBeenCalledWith([], "known");
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

    expect(discoveredCallback).toHaveBeenCalledWith([], "filesystem");
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

  it("lets includeGlobs override default ignores in createDiscoveredFileMatcher", () => {
    const root = normalize(path.resolve("/tmp/codegraph-matcher-root"));
    const isDiscovered = createDiscoveredFileMatcher(root, root, ["**/*.rb", "**/*.py"], {
      includeGlobs: ["vendor/bundle/**", ".venv/**"],
    });

    expect(isDiscovered(`${root}/vendor/bundle/gems/example.rb`)).toBe(true);
    expect(isDiscovered(`${root}/.venv/lib/site-packages/pkg.py`)).toBe(true);
    expect(isDiscovered(`${root}/node_modules/pkg/index.py`)).toBe(false);
    expect(isDiscovered(`${root}/src/main.py`)).toBe(false);
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

describe("git-native project file discovery", () => {
  const gitTempDirs: string[] = [];

  async function makeRepo(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    gitTempDirs.push(root);
    git(root, ["init"]);
    git(root, ["config", "user.email", "tests@example.com"]);
    git(root, ["config", "user.name", "Tests"]);
    return root;
  }

  afterEach(async () => {
    for (const root of gitTempDirs.splice(0)) {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    setGitExecutableForTests(null);
    clearGitDiscoveryCacheForTests();
    clearGitRepositoryCheckCacheForTests();
  });

  it("discovers sources tracked inside a submodule", async () => {
    // A submodule is a separate repository, so the superproject index records only a
    // gitlink and `git ls-files` reports nothing beneath it. Enumerating through Git
    // without recursion silently drops every submodule source from the index.
    const submodule = await makeRepo("codegraph-discovery-submodule-src-");
    await createFile(path.join(submodule, "plugin.ts"), "export const plugin = 1;\n");
    git(submodule, ["add", "."]);
    git(submodule, ["commit", "-m", "plugin"]);

    const root = await makeRepo("codegraph-discovery-submodule-super-");
    await createFile(path.join(root, "app.ts"), "export const app = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "app"]);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", normalize(submodule), "plugins/example"]);

    const files = (await listProjectFiles(root)).map(normalize);
    expect(files.some((file) => file.endsWith("/app.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/plugins/example/plugin.ts"))).toBe(true);
  });

  it("screens Git candidates for safe symlink directories without a second tree walk", async () => {
    const root = await makeRepo("codegraph-discovery-git-symlink-");
    const packageDir = path.join(root, "packages", "core");
    const linkedPackage = path.join(root, "linked-core");
    await createFile(path.join(packageDir, "index.ts"), "export const core = 1;\n");
    try {
      // A Windows junction is traversed directly by Git and reports as a directory to
      // lstat, so it does not exercise the candidate symlink verifier.
      await fs.symlink(packageDir, linkedPackage, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    const discoveredCallback = vi.fn();

    const files = await listProjectFiles(root, undefined, {
      onSymlinkDirectoriesDiscovered: discoveredCallback,
    });

    expect(files.map(normalize)).toContain(normalize(path.join(linkedPackage, "index.ts")));
    // The mode is the test seam for the performance contract. Deleting the
    // `candidatePaths` branch changes this to "filesystem" and fails the assertion.
    expect(discoveredCallback).toHaveBeenCalledWith([normalize(linkedPackage)], "git-candidates");
  });

  it("filters ignored Git symlink candidates before resolving or crawling them", async () => {
    const root = await makeRepo("codegraph-discovery-git-symlink-ignored-");
    const packageDir = path.join(root, "packages", "core");
    const linkedPackage = path.join(root, "node_modules");
    await createFile(path.join(packageDir, "index.ts"), "export const core = 1;\n");
    try {
      await fs.symlink(packageDir, linkedPackage, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    const discoveredCallback = vi.fn();

    const files = await listProjectFiles(root, undefined, {
      onSymlinkDirectoriesDiscovered: discoveredCallback,
    });

    expect(files.map(normalize)).not.toContain(normalize(path.join(linkedPackage, "index.ts")));
    expect(discoveredCallback).toHaveBeenCalledWith([], "git-candidates");
  });

  it("screens a Git symlink candidate reopened by includeGlobs", async () => {
    const root = await makeRepo("codegraph-discovery-git-symlink-reopened-");
    const packageDir = path.join(root, "packages", "core");
    const linkedPackage = path.join(root, "node_modules");
    await createFile(path.join(packageDir, "index.ts"), "export const core = 1;\n");
    try {
      await fs.symlink(packageDir, linkedPackage, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    const discoveredCallback = vi.fn();

    const files = await listProjectFiles(root, undefined, {
      includeGlobs: ["node_modules/**"],
      onSymlinkDirectoriesDiscovered: discoveredCallback,
    });

    expect(files.map(normalize)).toContain(normalize(path.join(linkedPackage, "index.ts")));
    expect(discoveredCallback).toHaveBeenCalledWith([normalize(linkedPackage)], "git-candidates");
  });

  it("excludes gitignored trees while keeping tracked sources", async () => {
    const root = await makeRepo("codegraph-discovery-ignored-tree-");
    await createFile(path.join(root, ".gitignore"), "generated/\n");
    await createFile(path.join(root, "src", "keep.ts"), "export const keep = 1;\n");
    await createFile(path.join(root, "generated", "drop.ts"), "export const drop = 1;\n");

    const files = (await listProjectFiles(root)).map(normalize);
    expect(files.some((file) => file.endsWith("/src/keep.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/generated/drop.ts"))).toBe(false);
  });

  it("honors a nested negation that re-includes an ignored source", async () => {
    // Rules are grouped per declaring directory and applied shallowest-first, so a
    // deeper negation must still win under "last match wins".
    //
    // Both sources are force-added and committed. Untracked fixtures would never reach
    // the matcher: `git ls-files --others --exclude-standard` would have resolved the
    // negation itself, so the assertions would hold even if the ancestor-chain matcher
    // were broken. Tracked files are listed by Git regardless of ignore rules, which
    // makes this index the only thing that can exclude `drop.ts`.
    const root = await makeRepo("codegraph-discovery-negation-");
    await createFile(path.join(root, ".gitignore"), "*.ts\n");
    await createFile(path.join(root, "sub", ".gitignore"), "!keep.ts\n");
    await createFile(path.join(root, "sub", "keep.ts"), "export const keep = 1;\n");
    await createFile(path.join(root, "sub", "drop.ts"), "export const drop = 1;\n");
    git(root, ["add", "-f", ".gitignore", "sub/.gitignore", "sub/keep.ts", "sub/drop.ts"]);
    git(root, ["commit", "-m", "fixtures"]);

    const files = (await listProjectFiles(root)).map(normalize);
    expect(files.some((file) => file.endsWith("/sub/keep.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/sub/drop.ts"))).toBe(false);
  });

  it("applies rules from a .gitignore that is itself ignored", async () => {
    // Git reads a `.gitignore` even when a rule ignores it, so filtering the candidate
    // listing for `.gitignore` files would drop these rules and index a tracked file
    // that must stay excluded.
    const root = await makeRepo("codegraph-discovery-self-ignored-rules-");
    await createFile(path.join(root, ".gitignore"), ".gitignore\ndrop.ts\n");
    await createFile(path.join(root, "keep.ts"), "export const keep = 1;\n");
    await createFile(path.join(root, "drop.ts"), "export const drop = 1;\n");
    git(root, ["add", "-f", "keep.ts", "drop.ts"]);
    git(root, ["commit", "-m", "fixtures"]);

    const files = (await listProjectFiles(root)).map(normalize);
    expect(files.some((file) => file.endsWith("/keep.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/drop.ts"))).toBe(false);
  });

  it("loads an ignored nested .gitignore through Git", async () => {
    const root = await makeRepo("codegraph-discovery-ignored-nested-gitignore-");
    const nestedIgnore = path.join(root, "rules", ".gitignore");
    const keptFile = path.join(root, "rules", "keep.ts");
    const ignoredFile = path.join(root, "rules", "drop.ts");
    await createFile(path.join(root, ".gitignore"), "rules/.gitignore\n");
    await createFile(nestedIgnore, "drop.ts\n");
    await createFile(keptFile, "export const keep = 1;\n");
    await createFile(ignoredFile, "export const drop = 1;\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["add", "-f", "rules/keep.ts", "rules/drop.ts"]);
    git(root, ["commit", "-m", "tracked sources"]);

    const files = new Set((await listProjectFiles(root)).map(normalize));
    expect(files.has(normalize(keptFile))).toBe(true);
    expect(files.has(normalize(ignoredFile))).toBe(false);
  });

  it("loads an untracked nested .gitignore through Git", async () => {
    const root = await makeRepo("codegraph-discovery-untracked-nested-gitignore-");
    const nestedIgnore = path.join(root, "rules", ".gitignore");
    const keptFile = path.join(root, "rules", "keep.ts");
    const ignoredFile = path.join(root, "rules", "drop.ts");
    await createFile(nestedIgnore, "drop.ts\n");
    await createFile(keptFile, "export const keep = 1;\n");
    await createFile(ignoredFile, "export const drop = 1;\n");
    git(root, ["add", "-f", "rules/keep.ts", "rules/drop.ts"]);
    git(root, ["commit", "-m", "tracked sources"]);

    const files = new Set((await listProjectFiles(root)).map(normalize));
    expect(files.has(normalize(keptFile))).toBe(true);
    expect(files.has(normalize(ignoredFile))).toBe(false);
  });

  it("does not stat candidate ancestors to locate Gitignore sources", async () => {
    const root = await makeRepo("codegraph-discovery-gitignore-stat-seam-");
    const keptFile = path.join(root, "deep", "nested", "keep.ts");
    const ignoredFile = path.join(root, "deep", "nested", "drop.ts");
    await createFile(path.join(root, ".gitignore"), "deep/nested/drop.ts\n");
    await createFile(keptFile, "export const keep = 1;\n");
    await createFile(ignoredFile, "export const drop = 1;\n");
    git(root, ["add", "-f", ".gitignore", "deep/nested/keep.ts", "deep/nested/drop.ts"]);
    git(root, ["commit", "-m", "tracked sources"]);

    const statSpy = vi.spyOn(fs, "stat");
    try {
      const files = new Set((await listProjectFiles(root)).map(normalize));
      const gitignoreStats = statSpy.mock.calls.filter(([file]) => normalize(String(file)).endsWith("/.gitignore"));
      expect(files.has(normalize(keptFile))).toBe(true);
      expect(files.has(normalize(ignoredFile))).toBe(false);
      expect(gitignoreStats).toHaveLength(0);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("does not resolve physical paths for Git candidates the project excludes", async () => {
    // Git enumerates untracked and force-added trees this project always drops, so
    // resolving each candidate's physical path first spent one realpath syscall per
    // excluded file. A Python project with a virtualenv pays that per virtualenv file
    // while discovery returns only its own sources.
    const root = await makeRepo("codegraph-discovery-excluded-candidate-realpath-");
    const keptFile = path.join(root, "src", "app.py");
    const vendoredFile = path.join(root, ".venv", "Lib", "site-packages", "dep", "mod.py");
    const gitignoredFile = path.join(root, "generated", "out.py");
    await createFile(path.join(root, ".gitignore"), "generated/\n");
    await createFile(keptFile, "value = 1\n");
    await createFile(vendoredFile, "value = 2\n");
    await createFile(gitignoredFile, "value = 3\n");
    git(root, ["add", "-f", ".gitignore", "src/app.py", "generated/out.py"]);
    git(root, ["commit", "-m", "tracked sources"]);

    const realpathSpy = vi.spyOn(fs, "realpath");
    try {
      const files = new Set((await listProjectFiles(root)).map(normalize));
      const probed = new Set(realpathSpy.mock.calls.map(([file]) => normalize(String(file))));

      expect(files.has(normalize(keptFile))).toBe(true);
      expect(files.has(normalize(vendoredFile))).toBe(false);
      expect(files.has(normalize(gitignoredFile))).toBe(false);
      expect(probed.has(normalize(keptFile))).toBe(true);
      expect(probed.has(normalize(vendoredFile))).toBe(false);
      expect(probed.has(normalize(gitignoredFile))).toBe(false);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("does not lstat Git-listed data files when screening symlink directories", async () => {
    const root = await makeRepo("codegraph-discovery-data-file-lstat-");
    const keptFile = path.join(root, "src", "app.py");
    const dataFile = path.join(root, "data", "batch", "row.json");
    await createFile(keptFile, "value = 1\n");
    await createFile(dataFile, "{}\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixtures"]);

    const lstatSpy = vi.spyOn(fs, "lstat");
    try {
      const files = new Set((await listProjectFiles(root)).map(normalize));
      const probed = new Set(lstatSpy.mock.calls.map(([file]) => normalize(String(file))));

      expect(files.has(normalize(keptFile))).toBe(true);
      expect(files.has(normalize(dataFile))).toBe(false);
      expect(probed.has(normalize(dataFile))).toBe(false);
      expect(probed.has(normalize(keptFile))).toBe(false);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  it("screens a tracked directory symlink whose name has an extension", async () => {
    const root = await makeRepo("codegraph-discovery-symlink-extension-");
    const packageDir = path.join(root, "packages", "core");
    const linkedPackage = path.join(root, "linked-core.v1");
    await createFile(path.join(packageDir, "index.ts"), "export const core = 1;\n");
    try {
      await fs.symlink(packageDir, linkedPackage, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    git(root, ["add", "packages/core/index.ts", "linked-core.v1"]);
    git(root, ["commit", "-m", "tracked symlink"]);
    const discoveredCallback = vi.fn();

    const files = await listProjectFiles(root, undefined, {
      onSymlinkDirectoriesDiscovered: discoveredCallback,
    });

    expect(files.map(normalize)).toContain(normalize(path.join(linkedPackage, "index.ts")));
    expect(discoveredCallback).toHaveBeenCalledWith([normalize(linkedPackage)], "git-candidates");
  });

  it("does not collect ignored .gitignore files under default-ignored trees", async () => {
    const root = await makeRepo("codegraph-discovery-venv-gitignore-");
    const rootIgnore = path.join(root, ".gitignore");
    const venvIgnore = path.join(root, ".venv", "Lib", "site-packages", "pkg", ".gitignore");
    await createFile(rootIgnore, ".venv/\n");
    await createFile(venvIgnore, "*\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-m", "ignore venv"]);

    const excludePathspecs = DEFAULT_PROJECT_FILE_IGNORES.map((globPattern) => `:(exclude,glob)${globPattern}`);
    const withExcludes = (await listGitIgnoreFiles(root, { excludePathspecs })).map(normalize);
    const withoutExcludes = (await listGitIgnoreFiles(root)).map(normalize);

    expect(withExcludes.some((file) => file.includes("/.venv/"))).toBe(false);
    expect(withExcludes.some((file) => file === normalize(rootIgnore))).toBe(true);
    expect(withoutExcludes.some((file) => file === normalize(venvIgnore))).toBe(true);
  });

  it("collects .gitignore files under a default-ignored tree reopened by includeGlobs", async () => {
    const root = await makeRepo("codegraph-discovery-reopened-gitignore-");
    const keepFile = path.join(root, "vendor", "bundle", "gems", "example", "keep.rb");
    const dropFile = path.join(root, "vendor", "bundle", "gems", "example", "drop.rb");
    const nestedIgnore = path.join(root, "vendor", "bundle", "gems", "example", ".gitignore");
    await createFile(keepFile, "puts 1\n");
    await createFile(dropFile, "puts 2\n");
    await createFile(nestedIgnore, "drop.rb\n");
    git(root, [
      "add",
      "-f",
      "vendor/bundle/gems/example/keep.rb",
      "vendor/bundle/gems/example/drop.rb",
      "vendor/bundle/gems/example/.gitignore",
    ]);
    git(root, ["commit", "-m", "tracked vendored sources"]);

    const files = new Set(
      (
        await listProjectFiles(root, undefined, {
          includeGlobs: ["vendor/bundle/**"],
        })
      ).map(normalize),
    );

    expect(files.has(normalize(keepFile))).toBe(true);
    expect(files.has(normalize(dropFile))).toBe(false);
  });

  it("does not resolve physical paths for Git candidates that cannot be metadata", async () => {
    const root = await makeRepo("codegraph-discovery-meta-candidate-realpath-");
    const manifest = path.join(root, "package.json");
    const sourceFile = path.join(root, "src", "app.ts");
    await createFile(manifest, JSON.stringify({ name: "meta-app" }, null, 2));
    await createFile(sourceFile, "export const app = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "fixtures"]);

    const realpathSpy = vi.spyOn(fs, "realpath");
    try {
      const paths = new Set((await discoverProjectFiles(root)).map((item) => normalize(item.path)));
      const probed = new Set(realpathSpy.mock.calls.map(([file]) => normalize(String(file))));

      expect(paths.has(normalize(manifest))).toBe(true);
      expect(probed.has(normalize(manifest))).toBe(true);
      expect(probed.has(normalize(sourceFile))).toBe(false);
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it("reports the failing Git ignore listing command", async () => {
    const root = await makeRepo("codegraph-discovery-gitignore-command-");
    setGitExecutableForTests(process.execPath);

    await expect(listGitIgnoreFiles(root)).rejects.toThrow(
      /^git ls-files (?:--cached|--others(?: --ignored)? --exclude-standard) -z -- \.gitignore :\(glob\)\*\*\/\.gitignore failed in /,
    );
  });

  it("applies rules from .git/info/exclude to tracked candidates", async () => {
    // The per-repository exclude file is a rule source Git consults but no `.gitignore`
    // walk would ever find, so paths Git never listed could otherwise bypass it.
    const root = await makeRepo("codegraph-discovery-info-exclude-");
    await createFile(path.join(root, ".git", "info", "exclude"), "drop.ts\n");
    await createFile(path.join(root, "keep.ts"), "export const keep = 1;\n");
    await createFile(path.join(root, "drop.ts"), "export const drop = 1;\n");
    git(root, ["add", "-f", "keep.ts", "drop.ts"]);
    git(root, ["commit", "-m", "fixtures"]);

    const files = (await listProjectFiles(root)).map(normalize);
    expect(files.some((file) => file.endsWith("/keep.ts"))).toBe(true);
    expect(files.some((file) => file.endsWith("/drop.ts"))).toBe(false);
  });

  it("scans the filesystem when Git ignores the requested root", async () => {
    // Enumerating through Git here would report only tracked files, so a directory the
    // caller named explicitly would look nearly empty.
    const root = await makeRepo("codegraph-discovery-ignored-root-");
    await createFile(path.join(root, ".gitignore"), "vendored/\n");
    await createFile(path.join(root, "vendored", "lib.ts"), "export const lib = 1;\n");

    const files = (await listProjectFiles(path.join(root, "vendored"))).map(normalize);
    expect(files.some((file) => file.endsWith("/vendored/lib.ts"))).toBe(true);
  });

  it("suppresses a child .gitignore whose directory name collates before a dot", async () => {
    // Ordering rule files lexically puts `-vendor/.gitignore` ahead of the root
    // `.gitignore`, because `-` sorts before `.`. The child's negation would then load
    // before the parent rule that ignores the whole directory could suppress it, and
    // `lib.ts` would be re-included. Depth-first ordering loads the parent first, so the
    // child rule file is correctly skipped and the tracked source stays excluded.
    const root = await makeRepo("codegraph-discovery-collation-");
    await createFile(path.join(root, ".gitignore"), "*.ts\n-vendor/\n");
    await createFile(path.join(root, "-vendor", ".gitignore"), "!lib.ts\n");
    await createFile(path.join(root, "-vendor", "lib.ts"), "export const lib = 1;\n");
    await createFile(path.join(root, "app.ts"), "export const app = 1;\n");
    // `--` is required: a pathspec starting with `-` is otherwise parsed as an option.
    git(root, ["add", "-f", "--", "-vendor/lib.ts", "app.ts"]);
    git(root, ["commit", "-m", "fixtures"]);

    const files = (await listProjectFiles(root)).map(normalize);
    expect(files.some((file) => file.endsWith("/-vendor/lib.ts"))).toBe(false);
  });

  it("loads a Gitignored .gitignore after info exclude marks only that file", async () => {
    const root = await makeRepo("codegraph-discovery-info-exclude-gitignore-");
    const packageJson = path.join(root, "package.json");
    await createFile(path.join(root, ".gitignore"), "package.json\n");
    await createFile(packageJson, JSON.stringify({ name: "ignored-pkg" }, null, 2));
    await fs.writeFile(path.join(root, ".git", "info", "exclude"), ".gitignore\n", "utf8");
    git(root, ["add", "-f", ".gitignore", "package.json"]);
    git(root, ["commit", "-m", "self ignored rules"]);

    const paths = new Set((await discoverProjectFiles(root)).map((entry) => normalize(entry.path)));
    expect(paths.has(normalize(packageJson))).toBe(false);
  });

  it("includes gitignored sources when useGitignore is disabled", async () => {
    const root = await makeRepo("codegraph-discovery-no-gitignore-");
    await createFile(path.join(root, ".gitignore"), "generated/\n");
    await createFile(path.join(root, "generated", "drop.ts"), "export const drop = 1;\n");

    const files = (await listProjectFiles(root, undefined, { useGitignore: false })).map(normalize);
    expect(files.some((file) => file.endsWith("/generated/drop.ts"))).toBe(true);
  });

  it("falls back to a filesystem scan outside a Git repository", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-discovery-no-git-"));
    gitTempDirs.push(root);
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");

    const files = (await listProjectFiles(root)).map(normalize);
    expect(files.some((file) => file.endsWith("/src/app.ts"))).toBe(true);
  });

  it("excludes a gitignored package.json from metadata discovery", async () => {
    const root = await makeRepo("codegraph-discovery-meta-ignored-");
    await createFile(path.join(root, ".gitignore"), "vendor/\n");
    await createFile(path.join(root, "vendor", "package.json"), JSON.stringify({ name: "ignored-pkg" }, null, 2));
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    git(root, ["add", ".gitignore", "src/app.ts"]);
    git(root, ["commit", "-m", "tracked"]);

    const discovered = await discoverProjectFiles(root);
    const paths = new Set(discovered.map((entry) => normalize(entry.path)));
    expect(paths.has(normalize(path.join(root, "vendor", "package.json")))).toBe(false);
  });

  it("excludes gitignored metadata reached through a safe symlink", async () => {
    const root = await makeRepo("codegraph-discovery-meta-symlink-ignored-");
    const packageDir = path.join(root, "packages", "core");
    const linkedPackage = path.join(root, "linked-core");
    await createFile(path.join(root, ".gitignore"), "packages/core/\n");
    await createFile(path.join(packageDir, "package.json"), JSON.stringify({ name: "ignored-pkg" }, null, 2));
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    try {
      await fs.symlink(packageDir, linkedPackage, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    git(root, ["add", ".gitignore", "src/app.ts"]);
    git(root, ["commit", "-m", "tracked"]);

    const paths = new Set((await discoverProjectFiles(root)).map((entry) => normalize(entry.path)));
    expect(paths.has(normalize(path.join(linkedPackage, "package.json")))).toBe(false);
  });

  it("keeps an unignored directory marker whose tracked descendants are ignored", async () => {
    const root = await makeRepo("codegraph-discovery-meta-ignored-descendants-");
    const ideaDirectory = path.join(root, ".idea");
    await createFile(path.join(root, ".gitignore"), ".idea/*\n");
    await createFile(path.join(ideaDirectory, "workspace.xml"), "<project />\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["add", "-f", ".idea/workspace.xml"]);
    git(root, ["commit", "-m", "ignored descendants"]);

    const entry = (await discoverProjectFiles(root)).find((item) => normalize(item.path) === normalize(ideaDirectory));
    expect(entry).toMatchObject({ kind: "dir" });
  });

  it("discovers a safe directory symlink that is itself a metadata marker", async () => {
    const root = await makeRepo("codegraph-discovery-meta-symlink-marker-");
    const target = path.join(root, "packages", "app");
    const marker = path.join(root, "App.xcodeproj");
    await createFile(path.join(target, "project.pbxproj"), "// project\n");
    try {
      await fs.symlink(target, marker, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    git(root, ["add", "App.xcodeproj"]);
    git(root, ["commit", "-m", "marker"]);

    const entry = (await discoverProjectFiles(root)).find((item) => normalize(item.path) === normalize(marker));
    expect(entry).toMatchObject({ kind: "dir" });
  });

  it("excludes an ignored directory metadata marker reached through a safe symlink", async () => {
    const root = await makeRepo("codegraph-discovery-meta-symlink-directory-ignore-");
    const target = path.join(root, "packages", "App.xcodeproj");
    const marker = path.join(root, "LinkedApp.xcodeproj");
    await createFile(path.join(root, ".gitignore"), "packages/App.xcodeproj/\n");
    await createFile(path.join(target, "project.pbxproj"), "// project\n");
    try {
      await fs.symlink(target, marker, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    git(root, ["add", ".gitignore", "LinkedApp.xcodeproj"]);
    git(root, ["commit", "-m", "ignored marker"]);

    const paths = new Set((await discoverProjectFiles(root)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(marker))).toBe(false);
  });

  it("honors gitignore when discovery starts through a repository symlink", async () => {
    const root = await makeRepo("codegraph-discovery-meta-root-alias-");
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-discovery-meta-root-alias-parent-"));
    gitTempDirs.push(parent);
    const alias = path.join(parent, "repo-link");
    await createFile(path.join(root, ".gitignore"), "vendor/\n");
    await createFile(path.join(root, "vendor", "package.json"), JSON.stringify({ name: "ignored-pkg" }, null, 2));
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    try {
      await fs.symlink(root, alias, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    git(root, ["add", ".gitignore", "src/app.ts"]);
    git(root, ["commit", "-m", "tracked"]);

    const paths = new Set((await discoverProjectFiles(alias)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(path.join(alias, "vendor", "package.json")))).toBe(false);
  });

  it("honors initialized submodule exclude sources for metadata", async () => {
    const submodule = await makeRepo("codegraph-discovery-meta-submodule-exclude-src-");
    const packageJson = path.join(submodule, "package.json");
    await createFile(packageJson, JSON.stringify({ name: "ignored-submodule-pkg" }, null, 2));
    git(submodule, ["add", "-f", "package.json"]);
    git(submodule, ["commit", "-m", "package"]);

    const root = await makeRepo("codegraph-discovery-meta-submodule-exclude-super-");
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "app"]);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", normalize(submodule), "plugins/example"]);
    const initializedSubmodule = path.join(root, "plugins", "example");
    const excludePath = git(initializedSubmodule, ["rev-parse", "--git-path", "info/exclude"]);
    await fs.writeFile(path.resolve(initializedSubmodule, excludePath), "package.json\n", "utf8");

    const paths = new Set((await discoverProjectFiles(root)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(path.join(root, "plugins", "example", "package.json")))).toBe(false);
  });

  it("honors physical submodule exclude sources through a repository symlink", async () => {
    const submodule = await makeRepo("codegraph-discovery-meta-aliased-submodule-src-");
    await createFile(
      path.join(submodule, "package.json"),
      JSON.stringify({ name: "ignored-aliased-submodule-pkg" }, null, 2),
    );
    git(submodule, ["add", "package.json"]);
    git(submodule, ["commit", "-m", "package"]);

    const root = await makeRepo("codegraph-discovery-meta-aliased-submodule-super-");
    git(root, ["commit", "--allow-empty", "-m", "app"]);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", normalize(submodule), "plugins/example"]);
    const initializedSubmodule = path.join(root, "plugins", "example");
    const excludePath = git(initializedSubmodule, ["rev-parse", "--git-path", "info/exclude"]);
    await fs.writeFile(path.resolve(initializedSubmodule, excludePath), "package.json\n", "utf8");
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-discovery-meta-aliased-submodule-parent-"));
    gitTempDirs.push(parent);
    const alias = path.join(parent, "repo-link");
    try {
      await fs.symlink(root, alias, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const paths = new Set((await discoverProjectFiles(alias)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(path.join(alias, "plugins", "example", "package.json")))).toBe(false);
  });

  it("does not apply superproject ignore rules inside initialized submodules", async () => {
    const submodule = await makeRepo("codegraph-discovery-meta-submodule-boundary-src-");
    await createFile(path.join(submodule, "package.json"), JSON.stringify({ name: "submodule-pkg" }, null, 2));
    git(submodule, ["add", "package.json"]);
    git(submodule, ["commit", "-m", "package"]);

    const root = await makeRepo("codegraph-discovery-meta-submodule-boundary-super-");
    await createFile(path.join(root, ".gitignore"), "package.json\n");
    await createFile(path.join(root, "src", "app.ts"), "export const app = 1;\n");
    git(root, ["add", ".gitignore", "src/app.ts"]);
    git(root, ["commit", "-m", "app"]);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", normalize(submodule), "plugins/example"]);

    const paths = new Set((await discoverProjectFiles(root)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(path.join(root, "plugins", "example", "package.json")))).toBe(true);
  });

  it("does not apply superproject ignore rules inside aliased initialized submodules", async () => {
    const submodule = await makeRepo("codegraph-discovery-meta-aliased-submodule-boundary-src-");
    await createFile(path.join(submodule, "package.json"), JSON.stringify({ name: "aliased-submodule-pkg" }, null, 2));
    git(submodule, ["add", "package.json"]);
    git(submodule, ["commit", "-m", "package"]);

    const root = await makeRepo("codegraph-discovery-meta-aliased-submodule-boundary-super-");
    await createFile(path.join(root, ".gitignore"), "package.json\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-m", "app"]);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", normalize(submodule), "plugins/example"]);
    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "codegraph-discovery-meta-aliased-submodule-boundary-parent-"),
    );

    gitTempDirs.push(parent);
    const alias = path.join(parent, "repo-link");
    try {
      await fs.symlink(root, alias, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    const paths = new Set((await discoverProjectFiles(alias)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(path.join(alias, "plugins", "example", "package.json")))).toBe(true);
  });

  it("keeps aliased submodule ignore ownership independent", async () => {
    const submodule = await makeRepo("codegraph-discovery-meta-aliased-submodule-ignore-src-");
    await createFile(path.join(submodule, "package.json"), JSON.stringify({ name: "ignored-submodule-pkg" }, null, 2));
    await createFile(
      path.join(submodule, "nested", "package.json"),
      JSON.stringify({ name: "kept-submodule-pkg" }, null, 2),
    );
    git(submodule, ["add", "package.json", "nested/package.json"]);
    git(submodule, ["commit", "-m", "packages"]);

    const root = await makeRepo("codegraph-discovery-meta-aliased-submodule-ignore-super-");
    await createFile(path.join(root, ".gitignore"), "package.json\n");
    git(root, ["add", ".gitignore"]);
    git(root, ["commit", "-m", "superproject rules"]);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", normalize(submodule), "plugins/example"]);
    const initializedSubmodule = path.join(root, "plugins", "example");
    await createFile(path.join(initializedSubmodule, ".gitignore"), "package.json\n!nested/package.json\n");

    const parent = await fs.mkdtemp(
      path.join(os.tmpdir(), "codegraph-discovery-meta-aliased-submodule-ignore-parent-"),
    );
    gitTempDirs.push(parent);
    const alias = path.join(parent, "repo-link");
    try {
      await fs.symlink(root, alias, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }

    const paths = new Set((await discoverProjectFiles(alias)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(path.join(alias, "plugins", "example", "package.json")))).toBe(false);
    expect(paths.has(normalize(path.join(alias, "plugins", "example", "nested", "package.json")))).toBe(true);
  });

  it("honors ancestor gitignore rules when discovery starts in a repository subdirectory", async () => {
    const root = await makeRepo("codegraph-discovery-meta-subdirectory-ignore-");
    const child = path.join(root, "child");
    const ignoredPackage = path.join(child, "vendor", "package.json");
    await createFile(path.join(root, ".gitignore"), "child/vendor/\n");
    await createFile(ignoredPackage, JSON.stringify({ name: "ignored-child-pkg" }, null, 2));
    git(root, ["add", ".gitignore"]);
    git(root, ["add", "-f", "child/vendor/package.json"]);
    git(root, ["commit", "-m", "ignored child"]);

    const paths = new Set((await discoverProjectFiles(child)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(ignoredPackage))).toBe(false);
  });

  it("lets a .gitignore negation override info exclude for metadata", async () => {
    const root = await makeRepo("codegraph-discovery-meta-ignore-precedence-");
    const packageJson = path.join(root, "package.json");
    await createFile(path.join(root, ".gitignore"), "!package.json\n");
    await createFile(packageJson, JSON.stringify({ name: "kept-pkg" }, null, 2));
    await fs.writeFile(path.join(root, ".git", "info", "exclude"), "package.json\n", "utf8");
    git(root, ["add", "-f", ".gitignore", "package.json"]);
    git(root, ["commit", "-m", "negation"]);

    const paths = new Set((await discoverProjectFiles(root)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(packageJson))).toBe(true);
  });

  it("honors descendant ignore rules through an aliased repository subdirectory", async () => {
    const root = await makeRepo("codegraph-discovery-meta-aliased-subdirectory-");
    const child = path.join(root, "child");
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-discovery-meta-aliased-subdirectory-parent-"));
    gitTempDirs.push(parent);
    const alias = path.join(parent, "child-link");
    const ignoredPackage = path.join(child, "vendor", "package.json");
    await createFile(path.join(child, ".gitignore"), "vendor/\n");
    await createFile(ignoredPackage, JSON.stringify({ name: "ignored-aliased-pkg" }, null, 2));
    try {
      await fs.symlink(child, alias, "dir");
    } catch (error) {
      if (isSymlinkUnavailable(error)) return;
      throw error;
    }
    git(root, ["add", "child/.gitignore"]);
    git(root, ["add", "-f", "child/vendor/package.json"]);
    git(root, ["commit", "-m", "aliased child"]);
    const paths = new Set((await discoverProjectFiles(alias)).map((item) => normalize(item.path)));
    expect(paths.has(normalize(path.join(alias, "vendor", "package.json")))).toBe(false);
  });

  it("discovers a tracked package.json with unchanged metadata fields", async () => {
    const root = await makeRepo("codegraph-discovery-meta-tracked-");
    const packageJson = path.join(root, "package.json");
    await createFile(packageJson, JSON.stringify({ name: "tracked-app" }, null, 2));
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "manifest"]);

    const discovered = await discoverProjectFiles(root);
    const entry = discovered.find((item) => normalize(item.path) === normalize(packageJson));
    expect(entry).toMatchObject({
      type: "node",
      role: "manifest",
      kind: "file",
      name: "tracked-app",
    });
  });

  it("discovers a manifest tracked inside an initialized submodule", async () => {
    const submodule = await makeRepo("codegraph-discovery-meta-sub-src-");
    const packageJson = path.join(submodule, "package.json");
    await createFile(packageJson, JSON.stringify({ name: "plugin-pkg" }, null, 2));
    git(submodule, ["add", "."]);
    git(submodule, ["commit", "-m", "plugin manifest"]);

    const root = await makeRepo("codegraph-discovery-meta-sub-super-");
    await createFile(path.join(root, "app.ts"), "export const app = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "app"]);
    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", normalize(submodule), "plugins/example"]);

    const discovered = await discoverProjectFiles(root);
    const entry = discovered.find((item) => normalize(item.path).endsWith("/plugins/example/package.json"));
    expect(entry).toMatchObject({
      type: "node",
      role: "manifest",
      kind: "file",
      name: "plugin-pkg",
    });
  });

  it("discovers a .idea directory that contains a tracked file", async () => {
    const root = await makeRepo("codegraph-discovery-meta-idea-");
    const ideaDir = path.join(root, "ide", ".idea");
    await createFile(path.join(ideaDir, "workspace.xml"), "<project />\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "idea"]);

    const discovered = await discoverProjectFiles(root);
    const entry = discovered.find((item) => normalize(item.path) === normalize(ideaDir));
    expect(entry).toMatchObject({
      type: "ide",
      role: "ide",
      kind: "dir",
    });
  });

  it("keeps filesystem fallback metadata discovery including empty xcodeproj dirs", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codegraph-discovery-meta-nongit-"));
    gitTempDirs.push(root);
    const packageJson = path.join(root, "package.json");
    const xcodeprojDir = path.join(root, "App.xcodeproj");
    await createFile(packageJson, JSON.stringify({ name: "fallback-app" }, null, 2));
    await fs.mkdir(xcodeprojDir, { recursive: true });

    const discovered = await discoverProjectFiles(root);
    const byPath = new Map(discovered.map((entry) => [normalize(entry.path), entry]));
    expect(byPath.get(normalize(packageJson))).toMatchObject({
      type: "node",
      role: "manifest",
      kind: "file",
      name: "fallback-app",
    });
    expect(byPath.get(normalize(xcodeprojDir))).toMatchObject({
      type: "swift",
      role: "config",
      kind: "dir",
      name: "App",
    });
  });

  it("reuses a supplied Git candidate set without spawning Git", async () => {
    const root = await makeRepo("codegraph-discovery-meta-known-");
    const packageJson = path.join(root, "package.json");
    const ignoredPackageJson = path.join(root, "vendor", "package.json");
    const ideaDir = path.join(root, "ide", ".idea");
    await createFile(path.join(root, ".gitignore"), "vendor/\n");
    await createFile(packageJson, JSON.stringify({ name: "known-app" }, null, 2));
    await createFile(ignoredPackageJson, JSON.stringify({ name: "ignored-pkg" }, null, 2));
    await createFile(path.join(ideaDir, "workspace.xml"), "<project />\n");
    git(root, ["add", ".gitignore", "package.json", "ide/.idea/workspace.xml"]);
    git(root, ["commit", "-m", "fixtures"]);

    let known: GitCandidateSet | null | undefined;
    await listProjectFilesWithGitCandidates(root, undefined, {
      onGitCandidatesDiscovered: (candidates) => {
        known = candidates;
      },
    });
    expect(known).toBeTruthy();
    expect(known!.files.some((file) => normalize(file) === normalize(packageJson))).toBe(true);

    const baseline = await discoverProjectFiles(root);
    // Point Git at a non-executable path so any spawn fails and discovery would fall back
    // to the filesystem scan (which includes the gitignored manifest). Equality with the
    // Git-aware baseline therefore proves the known-candidate path spawned no Git at all.
    setGitExecutableForTests(path.join(root, "not-a-git-executable"));
    clearGitDiscoveryCacheForTests();
    clearGitRepositoryCheckCacheForTests();
    try {
      const withKnown = await discoverProjectFilesWithGitCandidates(root, { knownGitCandidates: known! });
      expect(withKnown).toEqual(baseline);

      const byPath = new Map(withKnown.map((entry) => [normalize(entry.path), entry]));
      expect(byPath.get(normalize(packageJson))).toMatchObject({
        type: "node",
        role: "manifest",
        kind: "file",
        name: "known-app",
      });
      expect(byPath.has(normalize(ignoredPackageJson))).toBe(false);
      expect(byPath.get(normalize(ideaDir))).toMatchObject({
        type: "ide",
        role: "ide",
        kind: "dir",
      });

      const fallback = await discoverProjectFiles(root);
      expect(fallback.some((entry) => normalize(entry.path) === normalize(ignoredPackageJson))).toBe(true);
    } finally {
      setGitExecutableForTests(null);
      clearGitDiscoveryCacheForTests();
      clearGitRepositoryCheckCacheForTests();
    }
  });

  it("reports submodule directories from index gitlink entries", async () => {
    const submodule = await makeRepo("codegraph-discovery-gitlink-src-");
    await createFile(path.join(submodule, "plugin.ts"), "export const plugin = 1;\n");
    git(submodule, ["add", "."]);
    git(submodule, ["commit", "-m", "plugin"]);

    const root = await makeRepo("codegraph-discovery-gitlink-super-");
    await createFile(path.join(root, "app.ts"), "export const app = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "app"]);
    expect(await listGitSubmoduleDirectories(root)).toEqual([]);

    git(root, ["-c", "protocol.file.allow=always", "submodule", "add", normalize(submodule), "plugins/example"]);
    expect((await listGitSubmoduleDirectories(root)).map(normalize)).toEqual([
      normalize(path.join(root, "plugins/example")),
    ]);
  });
});
