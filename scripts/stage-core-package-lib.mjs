import fs from "node:fs";
import path from "node:path";

export const CORE_PACKAGE_ENTRIES = Object.freeze([
  "index.js",
  "agent.js",
  "graphs.js",
  "impact/index.js",
  "indexer.js",
  "languages.js",
]);

export const CORE_PACKAGE_EXTRA_FILES = Object.freeze(["agent/query-index/queryIndexWorker.js"]);

const IMPORT_PATTERN =
  /(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?["'](\.[^"']+)["']|import\(["'](\.[^"']+)["']\)/g;

const FORBIDDEN_SEGMENT_PATTERN = /(^|\/)(cli|mcp|installer|bin)(\/|$)/;

export function isForbiddenCorePackagePath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return FORBIDDEN_SEGMENT_PATTERN.test(normalized);
}

function assertAllowedCorePackagePath(relativePath) {
  if (isForbiddenCorePackagePath(relativePath)) {
    throw new Error(`Core package staging refused forbidden path: ${relativePath}`);
  }
}

function normalizeRelativeSpecifier(fromFile, specifier) {
  const fromDir = path.posix.dirname(fromFile.replaceAll("\\", "/"));
  let resolved = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (resolved.startsWith("../") || resolved === "..") {
    throw new Error(`Core package staging escaped dist root via ${specifier} from ${fromFile}`);
  }
  if (resolved.endsWith(".js")) {
    return resolved;
  }
  return `${resolved}.js`;
}

function normalizeRelativeDeclarationSpecifier(fromFile, specifier) {
  const fromDir = path.posix.dirname(fromFile.replaceAll("\\", "/"));
  let resolved = path.posix.normalize(path.posix.join(fromDir, specifier));
  if (resolved.startsWith("../") || resolved === "..") {
    throw new Error(`Core package staging escaped dist root via ${specifier} from ${fromFile}`);
  }
  if (resolved.endsWith(".d.ts")) {
    return resolved;
  }
  if (resolved.endsWith(".js")) {
    return `${resolved.slice(0, -3)}.d.ts`;
  }
  return `${resolved}.d.ts`;
}

function relatedArtifacts(relativeJsPath) {
  const withoutExt = relativeJsPath.replace(/\.js$/u, "");
  return [relativeJsPath, `${withoutExt}.d.ts`, `${relativeJsPath}.map`, `${withoutExt}.d.ts.map`];
}

function collectRelativeSpecifiers(source) {
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1] ?? match[2];
    if (!specifier || !specifier.startsWith(".")) {
      continue;
    }
    specifiers.push(specifier);
  }
  return specifiers;
}

export function collectCorePackageFiles(distRoot, options = {}) {
  const entries = options.entries ?? CORE_PACKAGE_ENTRIES;
  const extraFiles = options.extraFiles ?? CORE_PACKAGE_EXTRA_FILES;
  const absoluteDistRoot = path.resolve(distRoot);
  const visitedJs = new Set();
  const visitedDts = new Set();
  const staged = new Set();
  const queue = [...entries];

  while (queue.length > 0) {
    const relativeJsPath = queue.shift().replaceAll("\\", "/");
    if (visitedJs.has(relativeJsPath)) {
      continue;
    }
    assertAllowedCorePackagePath(relativeJsPath);
    const absoluteJsPath = path.join(absoluteDistRoot, relativeJsPath);
    if (!fs.existsSync(absoluteJsPath)) {
      throw new Error(`Core package entry missing from dist: ${relativeJsPath}`);
    }
    visitedJs.add(relativeJsPath);

    for (const artifact of relatedArtifacts(relativeJsPath)) {
      assertAllowedCorePackagePath(artifact);
      if (fs.existsSync(path.join(absoluteDistRoot, artifact))) {
        staged.add(artifact);
      }
    }

    const source = fs.readFileSync(absoluteJsPath, "utf8");
    for (const specifier of collectRelativeSpecifiers(source)) {
      const resolved = normalizeRelativeSpecifier(relativeJsPath, specifier);
      if (!visitedJs.has(resolved)) {
        queue.push(resolved);
      }
    }
  }

  for (const extra of extraFiles) {
    const normalized = extra.replaceAll("\\", "/");
    assertAllowedCorePackagePath(normalized);
    const absoluteExtra = path.join(absoluteDistRoot, normalized);
    if (!fs.existsSync(absoluteExtra)) {
      continue;
    }
    for (const artifact of relatedArtifacts(normalized.endsWith(".js") ? normalized : `${normalized}.js`)) {
      if (fs.existsSync(path.join(absoluteDistRoot, artifact))) {
        staged.add(artifact);
      }
    }
  }

  // Type-only modules are erased from JS imports; walk the declaration closure so
  // TypeScript consumers do not hit missing .d.ts paths after packing.
  const declarationQueue = [...staged].filter((file) => file.endsWith(".d.ts"));
  while (declarationQueue.length > 0) {
    const relativeDtsPath = declarationQueue.shift().replaceAll("\\", "/");
    if (visitedDts.has(relativeDtsPath)) {
      continue;
    }
    assertAllowedCorePackagePath(relativeDtsPath);
    const absoluteDtsPath = path.join(absoluteDistRoot, relativeDtsPath);
    if (!fs.existsSync(absoluteDtsPath)) {
      throw new Error(`Core package declaration missing from dist: ${relativeDtsPath}`);
    }
    visitedDts.add(relativeDtsPath);
    staged.add(relativeDtsPath);
    const mapPath = `${relativeDtsPath}.map`;
    if (fs.existsSync(path.join(absoluteDistRoot, mapPath))) {
      staged.add(mapPath);
    }

    const source = fs.readFileSync(absoluteDtsPath, "utf8");
    for (const specifier of collectRelativeSpecifiers(source)) {
      const resolvedDts = normalizeRelativeDeclarationSpecifier(relativeDtsPath, specifier);
      if (!visitedDts.has(resolvedDts)) {
        declarationQueue.push(resolvedDts);
      }
      const resolvedJs = normalizeRelativeSpecifier(relativeDtsPath.replace(/\.d\.ts$/u, ".js"), specifier);
      if (fs.existsSync(path.join(absoluteDistRoot, resolvedJs)) && !visitedJs.has(resolvedJs)) {
        visitedJs.add(resolvedJs);
        for (const artifact of relatedArtifacts(resolvedJs)) {
          assertAllowedCorePackagePath(artifact);
          if (fs.existsSync(path.join(absoluteDistRoot, artifact))) {
            staged.add(artifact);
          }
        }
      }
    }
  }

  return [...staged].sort((left, right) => left.localeCompare(right));
}

export function stageCorePackage({ repoRoot = process.cwd() } = {}) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const distRoot = path.join(absoluteRepoRoot, "dist");
  const packageRoot = path.join(absoluteRepoRoot, "packages", "codegraph-core");
  const destinationDist = path.join(packageRoot, "dist");

  if (!fs.existsSync(distRoot)) {
    throw new Error(`Missing dist/ at ${distRoot}; run tsc before staging the core package.`);
  }
  if (!fs.existsSync(path.join(packageRoot, "package.json"))) {
    throw new Error(`Missing core package manifest at ${packageRoot}`);
  }

  const files = collectCorePackageFiles(distRoot);
  fs.rmSync(destinationDist, { recursive: true, force: true });

  for (const relativePath of files) {
    const fromPath = path.join(distRoot, relativePath);
    const toPath = path.join(destinationDist, relativePath);
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.copyFileSync(fromPath, toPath);
  }

  const noticesSource = path.join(absoluteRepoRoot, "THIRD_PARTY_NOTICES");
  const noticesDestination = path.join(packageRoot, "THIRD_PARTY_NOTICES");
  if (fs.existsSync(noticesSource)) {
    fs.copyFileSync(noticesSource, noticesDestination);
  } else if (fs.existsSync(noticesDestination)) {
    fs.rmSync(noticesDestination, { force: true });
  }

  return { packageRoot, destinationDist, files };
}
