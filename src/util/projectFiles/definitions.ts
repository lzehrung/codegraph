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

type ProjectFileDefinitionMetadata = Pick<ProjectFileDefinition, "parseName" | "nameFromPath">;

const nameFromDir = { nameFromPath: "dir" } satisfies ProjectFileDefinitionMetadata;
const nameFromFile = { nameFromPath: "file" } satisfies ProjectFileDefinitionMetadata;

function fileDefinition(
  type: ProjectFileType,
  role: ProjectFileRole,
  patterns: string[],
  metadata: ProjectFileDefinitionMetadata = {},
): ProjectFileDefinition {
  return {
    type,
    role,
    kind: "file",
    patterns,
    ...metadata,
  };
}

function dirDefinition(
  type: ProjectFileType,
  role: ProjectFileRole,
  patterns: string[],
  metadata: ProjectFileDefinitionMetadata = {},
): ProjectFileDefinition {
  return {
    type,
    role,
    kind: "dir",
    patterns,
    ...metadata,
  };
}

export const PROJECT_FILE_DEFINITIONS: ProjectFileDefinition[] = [
  fileDefinition("node", "manifest", ["package.json"], { parseName: parseJsonName, ...nameFromDir }),
  fileDefinition("node", "lockfile", ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]),
  fileDefinition("node", "config", ["pnpm-workspace.yaml"], nameFromDir),
  fileDefinition("node", "config", ["lerna.json", "nx.json", "turbo.json"], {
    parseName: parseJsonName,
    ...nameFromDir,
  }),
  fileDefinition("typescript", "config", ["tsconfig.json", "jsconfig.json"]),
  fileDefinition("python", "manifest", ["pyproject.toml"], {
    parseName: (raw) => parseTomlName(raw, ["project", "tool.poetry"]),
    ...nameFromDir,
  }),
  fileDefinition("python", "manifest", ["setup.cfg"], {
    parseName: (raw) => parseIniName(raw, "metadata", "name"),
    ...nameFromDir,
  }),
  fileDefinition("python", "manifest", ["setup.py"], {
    parseName: parseSetupPyName,
    ...nameFromDir,
  }),
  fileDefinition("python", "manifest", ["requirements.txt", "requirements.in", "Pipfile"], nameFromDir),
  fileDefinition("python", "lockfile", ["Pipfile.lock", "poetry.lock"]),
  fileDefinition("rust", "manifest", ["Cargo.toml"], {
    parseName: (raw) => parseTomlName(raw, ["package"]),
    ...nameFromDir,
  }),
  fileDefinition("rust", "lockfile", ["Cargo.lock"]),
  fileDefinition("rust", "config", ["rust-toolchain", "rust-toolchain.toml"], nameFromDir),
  fileDefinition("go", "manifest", ["go.mod"], {
    parseName: parseGoModuleName,
    ...nameFromDir,
  }),
  fileDefinition("go", "lockfile", ["go.sum"]),
  fileDefinition("go", "config", ["go.work"], nameFromDir),
  fileDefinition("ruby", "manifest", ["Gemfile"], nameFromDir),
  fileDefinition("ruby", "lockfile", ["Gemfile.lock"]),
  fileDefinition("ruby", "manifest", ["*.gemspec"], {
    parseName: parseGemspecName,
    ...nameFromFile,
  }),
  fileDefinition("maven", "manifest", ["pom.xml"], {
    parseName: parsePomName,
    ...nameFromDir,
  }),
  fileDefinition("maven", "config", ["mvnw"], nameFromDir),
  fileDefinition("gradle", "manifest", ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"], {
    parseName: parseGradleName,
    ...nameFromDir,
  }),
  fileDefinition("gradle", "config", ["gradle.properties"], {
    parseName: parseGradlePropertiesName,
    ...nameFromDir,
  }),
  fileDefinition("gradle", "config", ["gradlew"], nameFromDir),
  fileDefinition("dotnet", "manifest", ["*.csproj", "*.fsproj", "*.vbproj"], {
    parseName: parseDotnetName,
    ...nameFromFile,
  }),
  fileDefinition("dotnet", "solution", ["*.sln"], nameFromFile),
  fileDefinition("dotnet", "config", ["Directory.Build.props", "Directory.Build.targets", "global.json"], nameFromDir),
  fileDefinition("php", "manifest", ["composer.json"], {
    parseName: parseJsonName,
    ...nameFromDir,
  }),
  fileDefinition("php", "lockfile", ["composer.lock"]),
  fileDefinition(
    "native",
    "manifest",
    [
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
    nameFromDir,
  ),
  fileDefinition("native", "config", ["CMakePresets.json", "CMakeUserPresets.json", "meson_options.txt"], nameFromDir),
  fileDefinition("native", "manifest", ["vcpkg.json"], {
    parseName: parseJsonName,
    ...nameFromDir,
  }),
  fileDefinition("swift", "manifest", ["Package.swift"], {
    parseName: parseSwiftPackageName,
    ...nameFromDir,
  }),
  fileDefinition("swift", "lockfile", ["Package.resolved"]),
  dirDefinition("swift", "config", ["*.xcodeproj", "*.xcworkspace"], nameFromFile),
  dirDefinition("ide", "ide", [".idea"], nameFromDir),
];
