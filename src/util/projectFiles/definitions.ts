import {
  parseDotnetName,
  parseGemspecName,
  parseGoModuleName,
  parseGradleName,
  parseGradlePropertiesName,
  parseIniName,
  parseJsonName,
  parsePomName,
  parseSetupPyName,
  parseSwiftPackageName,
  parseTomlName,
} from "./parsers.js";

export type ProjectFileKind = "file" | "dir";
export type ProjectFileRole = "manifest" | "lockfile" | "config" | "solution" | "ide";
export type ProjectFileType =
  | "node"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "maven"
  | "gradle"
  | "dotnet"
  | "ruby"
  | "php"
  | "swift"
  | "native"
  | "ide";

export type ProjectFileInfo = {
  path: string;
  kind: ProjectFileKind;
  type: ProjectFileType;
  role: ProjectFileRole;
  projectRoot: string;
  name?: string;
};

export type ProjectFileDefinition = {
  type: ProjectFileType;
  role: ProjectFileRole;
  kind: ProjectFileKind;
  patterns: string[];
  parseName?: (contents: string, filePath: string) => string | null;
  nameFromPath?: "file" | "dir";
};

export const PROJECT_FILE_DEFINITIONS: ProjectFileDefinition[] = [
  {
    type: "node",
    role: "manifest",
    kind: "file",
    patterns: ["package.json"],
    parseName: parseJsonName,
    nameFromPath: "dir",
  },
  {
    type: "node",
    role: "lockfile",
    kind: "file",
    patterns: ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"],
  },
  {
    type: "node",
    role: "config",
    kind: "file",
    patterns: ["pnpm-workspace.yaml"],
    nameFromPath: "dir",
  },
  {
    type: "node",
    role: "config",
    kind: "file",
    patterns: ["lerna.json", "nx.json", "turbo.json"],
    parseName: parseJsonName,
    nameFromPath: "dir",
  },
  {
    type: "typescript",
    role: "config",
    kind: "file",
    patterns: ["tsconfig.json", "jsconfig.json"],
  },
  {
    type: "python",
    role: "manifest",
    kind: "file",
    patterns: ["pyproject.toml"],
    parseName: (raw) => parseTomlName(raw, ["project", "tool.poetry"]),
    nameFromPath: "dir",
  },
  {
    type: "python",
    role: "manifest",
    kind: "file",
    patterns: ["setup.cfg"],
    parseName: (raw) => parseIniName(raw, "metadata", "name"),
    nameFromPath: "dir",
  },
  {
    type: "python",
    role: "manifest",
    kind: "file",
    patterns: ["setup.py"],
    parseName: parseSetupPyName,
    nameFromPath: "dir",
  },
  {
    type: "python",
    role: "manifest",
    kind: "file",
    patterns: ["requirements.txt", "requirements.in", "Pipfile"],
    nameFromPath: "dir",
  },
  {
    type: "python",
    role: "lockfile",
    kind: "file",
    patterns: ["Pipfile.lock", "poetry.lock"],
  },
  {
    type: "rust",
    role: "manifest",
    kind: "file",
    patterns: ["Cargo.toml"],
    parseName: (raw) => parseTomlName(raw, ["package"]),
    nameFromPath: "dir",
  },
  {
    type: "rust",
    role: "lockfile",
    kind: "file",
    patterns: ["Cargo.lock"],
  },
  {
    type: "rust",
    role: "config",
    kind: "file",
    patterns: ["rust-toolchain", "rust-toolchain.toml"],
    nameFromPath: "dir",
  },
  {
    type: "go",
    role: "manifest",
    kind: "file",
    patterns: ["go.mod"],
    parseName: parseGoModuleName,
    nameFromPath: "dir",
  },
  {
    type: "go",
    role: "lockfile",
    kind: "file",
    patterns: ["go.sum"],
  },
  {
    type: "go",
    role: "config",
    kind: "file",
    patterns: ["go.work"],
    nameFromPath: "dir",
  },
  {
    type: "ruby",
    role: "manifest",
    kind: "file",
    patterns: ["Gemfile"],
    nameFromPath: "dir",
  },
  {
    type: "ruby",
    role: "lockfile",
    kind: "file",
    patterns: ["Gemfile.lock"],
  },
  {
    type: "ruby",
    role: "manifest",
    kind: "file",
    patterns: ["*.gemspec"],
    parseName: parseGemspecName,
    nameFromPath: "file",
  },
  {
    type: "maven",
    role: "manifest",
    kind: "file",
    patterns: ["pom.xml"],
    parseName: parsePomName,
    nameFromPath: "dir",
  },
  {
    type: "maven",
    role: "config",
    kind: "file",
    patterns: ["mvnw"],
    nameFromPath: "dir",
  },
  {
    type: "gradle",
    role: "manifest",
    kind: "file",
    patterns: ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
    parseName: parseGradleName,
    nameFromPath: "dir",
  },
  {
    type: "gradle",
    role: "config",
    kind: "file",
    patterns: ["gradle.properties"],
    parseName: parseGradlePropertiesName,
    nameFromPath: "dir",
  },
  {
    type: "gradle",
    role: "config",
    kind: "file",
    patterns: ["gradlew"],
    nameFromPath: "dir",
  },
  {
    type: "dotnet",
    role: "manifest",
    kind: "file",
    patterns: ["*.csproj", "*.fsproj", "*.vbproj"],
    parseName: parseDotnetName,
    nameFromPath: "file",
  },
  {
    type: "dotnet",
    role: "solution",
    kind: "file",
    patterns: ["*.sln"],
    nameFromPath: "file",
  },
  {
    type: "dotnet",
    role: "config",
    kind: "file",
    patterns: ["Directory.Build.props", "Directory.Build.targets", "global.json"],
    nameFromPath: "dir",
  },
  {
    type: "php",
    role: "manifest",
    kind: "file",
    patterns: ["composer.json"],
    parseName: parseJsonName,
    nameFromPath: "dir",
  },
  {
    type: "php",
    role: "lockfile",
    kind: "file",
    patterns: ["composer.lock"],
  },
  {
    type: "native",
    role: "manifest",
    kind: "file",
    patterns: [
      "CMakeLists.txt",
      "Makefile",
      "makefile",
      "GNUmakefile",
      "configure.ac",
      "configure.in",
      "meson.build",
      "conanfile.txt",
      "conanfile.py",
    ],
    nameFromPath: "dir",
  },
  {
    type: "native",
    role: "config",
    kind: "file",
    patterns: ["CMakePresets.json", "CMakeUserPresets.json", "meson_options.txt"],
    nameFromPath: "dir",
  },
  {
    type: "native",
    role: "manifest",
    kind: "file",
    patterns: ["vcpkg.json"],
    parseName: parseJsonName,
    nameFromPath: "dir",
  },
  {
    type: "swift",
    role: "manifest",
    kind: "file",
    patterns: ["Package.swift"],
    parseName: parseSwiftPackageName,
    nameFromPath: "dir",
  },
  {
    type: "swift",
    role: "lockfile",
    kind: "file",
    patterns: ["Package.resolved"],
  },
  {
    type: "swift",
    role: "config",
    kind: "dir",
    patterns: ["*.xcodeproj", "*.xcworkspace"],
    nameFromPath: "file",
  },
  {
    type: "ide",
    role: "ide",
    kind: "dir",
    patterns: [".idea"],
    nameFromPath: "dir",
  },
];
