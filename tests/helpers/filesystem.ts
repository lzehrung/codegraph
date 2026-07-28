import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

const defaultFixtureCopyExcludes: Record<string, true> = {
  ".codegraph": true,
  ".codegraph-cache": true,
};

export type CopyFixtureSubsetOptions = {
  subset?: readonly string[];
  additionalExcludedNames?: readonly string[];
};

export type WithCopiedFixtureOptions = CopyFixtureSubsetOptions & {
  prefix?: string;
};

function normalizeFixtureSubsetPath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (path.isAbsolute(relativePath) || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Fixture subset path must stay inside the fixture root: ${relativePath}`);
  }
  return normalized;
}

export async function copyFixtureSubset(
  sourceRoot: string,
  destinationRoot: string,
  options: CopyFixtureSubsetOptions = {},
): Promise<void> {
  const resolvedSourceRoot = path.resolve(sourceRoot);
  const excludedNames = new Set(Object.keys(defaultFixtureCopyExcludes));
  for (const name of options.additionalExcludedNames ?? []) excludedNames.add(name);

  const shouldCopy = (sourcePath: string): boolean => {
    const relativePath = path.relative(resolvedSourceRoot, sourcePath);
    if (!relativePath) return true;
    return !relativePath.split(path.sep).some((segment) => excludedNames.has(segment));
  };

  const subset = options.subset ?? ["."];
  for (const relativePath of subset) {
    const normalized = normalizeFixtureSubsetPath(relativePath);
    const sourcePath = path.join(resolvedSourceRoot, normalized);
    const destinationPath = path.join(destinationRoot, normalized);
    await fsp.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsp.cp(sourcePath, destinationPath, {
      recursive: true,
      filter: shouldCopy,
    });
  }
}

export async function withCopiedFixture<T>(
  sourceRoot: string,
  action: (fixtureRoot: string) => T | Promise<T>,
  options: WithCopiedFixtureOptions = {},
): Promise<T> {
  const fixtureRoot = await mkTmpDir(options.prefix ?? "codegraph-fixture-");
  try {
    await copyFixtureSubset(sourceRoot, fixtureRoot, options);
    return await action(fixtureRoot);
  } finally {
    if (process.env.CODEGRAPH_KEEP_FIXTURE_TEMP === "1") {
      console.error(`Retained fixture copy: ${fixtureRoot}`);
    } else {
      await fsp.rm(fixtureRoot, { recursive: true, force: true });
    }
  }
}

export function readOnlySamplePath(...relativePath: string[]): string {
  return path.resolve(process.cwd(), "tests", "samples", ...relativePath);
}

export function isSymlinkUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")
  );
}

export type TempProjectFile = {
  path: string;
  contents: string;
};

export async function createTempProjectRoot(prefix: string, files?: readonly TempProjectFile[]): Promise<string> {
  const root = await mkTmpDir(prefix);
  if (!files) return root;
  for (const file of files) {
    const filePath = path.join(root, file.path);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, file.contents, "utf8");
  }
  return root;
}

export async function createTwoCommitCycleProject(
  prefix: string,
  runGitCommand: (root: string, args: string[]) => string,
): Promise<string> {
  const root = await createTempProjectRoot(prefix, [
    {
      path: path.join("src", "a.ts"),
      contents: "import { b } from './b'; export function a() { return b(); }\n",
    },
    {
      path: path.join("src", "b.ts"),
      contents: "export function b() { return 1; }\n",
    },
  ]);
  runGitCommand(root, ["init"]);
  runGitCommand(root, ["add", "."]);
  runGitCommand(root, ["commit", "-m", "base"]);
  await fsp.writeFile(
    path.join(root, "src", "b.ts"),
    "import { a } from './a'; export function b() { return a(); }\n",
    "utf8",
  );
  runGitCommand(root, ["add", "."]);
  runGitCommand(root, ["commit", "-m", "head"]);
  return root;
}

export type TempArtifactOutput = {
  root: string;
  outDir: string;
};

export async function createArtifactOutputWithStaleFile(options: {
  prefix: string;
  outDirName: string;
  staleFileName: string;
  staleContents: string;
}): Promise<TempArtifactOutput> {
  const root = await mkTmpDir(options.prefix);
  const outDir = path.join(root, options.outDirName);
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(path.join(root, "auth.ts"), "export const ok = 1;\n", "utf8");
  await fsp.writeFile(path.join(outDir, options.staleFileName), options.staleContents, "utf8");
  return { root, outDir };
}

export async function tryCreateDirectorySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fsp.symlink(target, linkPath, "junction");
    return true;
  } catch (error) {
    if (isSymlinkUnavailable(error)) return false;
    throw error;
  }
}

export type TempLinkedRoot = {
  realRoot: string;
  parent: string;
  linkedRoot: string;
};

export async function createLinkedTempRoot(options: {
  realRootPrefix: string;
  parentPrefix: string;
  linkName: string;
}): Promise<TempLinkedRoot | undefined> {
  const realRoot = await mkTmpDir(options.realRootPrefix);
  const parent = await mkTmpDir(options.parentPrefix);
  const linkedRoot = path.join(parent, options.linkName);
  const symlinkCreated = await tryCreateDirectorySymlink(realRoot, linkedRoot);
  if (!symlinkCreated) {
    await Promise.all([
      fsp.rm(realRoot, { recursive: true, force: true }),
      fsp.rm(parent, { recursive: true, force: true }),
    ]);
    return undefined;
  }
  return { realRoot, parent, linkedRoot };
}

export function normalizeTestPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
