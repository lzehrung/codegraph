import fsp from "node:fs/promises";
import path from "node:path";
import { stringifyUnknown } from "../ast.js";
import { normalizePath } from "../paths.js";
import { listProjectFiles } from "../projectFiles.js";
import { listResolutionCandidates } from "../resolutionCandidates.js";
import { mapLimitSemaphore } from "../semaphore.js";
import { fileExists } from "../workspace.js";
import { findNearestFile } from "./files.js";
import {
  addProjectSymbolFile,
  getOrCreateProjectSymbolIndex,
  listProjectLanguageFiles,
  sortProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./projectSymbols.js";

type FileId = string;

async function findFirstExistingResolutionCandidate(
  base: string,
  resolutionExtensions?: readonly string[],
): Promise<string | null> {
  for (const candidate of listResolutionCandidates(base, resolutionExtensions)) {
    if (await fileExists(candidate)) {
      return path.resolve(candidate);
    }
  }
  return null;
}

async function resolvePhpPathLikeSpecifier(
  projectRoot: string,
  fromFile: string,
  spec: string,
): Promise<string | null> {
  let base = path.resolve(path.dirname(fromFile), spec);
  if (/^[A-Za-z]:[\\/]/.test(spec)) {
    base = spec;
  } else if (spec.startsWith("/")) {
    base = path.join(projectRoot, spec);
  }
  return await findFirstExistingResolutionCandidate(base, [".php"]);
}

async function resolvePathLikePhpModule(projectRoot: string, spec: string): Promise<string | null> {
  const parts = spec.split(/[/.:]+/).filter(Boolean);
  for (let i = parts.length; i > 0; i--) {
    const sub = parts.slice(0, i);
    const basePath = path.join(projectRoot, ...sub);
    const fileHit = await findFirstExistingResolutionCandidate(basePath, [".php"]);
    if (fileHit) return fileHit;
  }
  return null;
}

type PhpSymbolKind = "class" | "function" | "const";

type PhpPackageSymbolIndexEntry = {
  packageName: string;
  symbols: Set<string>;
  kindsBySymbol: Map<string, Set<PhpSymbolKind>>;
};

type PhpSymbolIndexEntry = {
  packageName: string | null;
  symbols: Set<string>;
  kindsBySymbol: Map<string, Set<PhpSymbolKind>>;
  packageEntries: PhpPackageSymbolIndexEntry[];
};

type PhpComposerConfig = {
  psr4: Map<string, string[]>;
  psr0: Map<string, string[]>;
  classmap: string[];
  excludeFromClassmap: string[];
  files: string[];
};

const phpImportResolutionCache = new Map<string, string | null>();
const phpSymbolIndexCache = new Map<string, PhpSymbolIndexEntry>();
const phpProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();
const phpComposerConfigCache = new Map<string, Promise<PhpComposerConfig | null>>();
const phpComposerAutoloadFileCache = new Map<string, Promise<Set<string>>>();

async function getPhpProjectSymbolIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(phpProjectSymbolIndexCache, projectRoot, async () => {
    const files = await listProjectLanguageFiles(projectRoot, ["**/*.php"]);
    const index: LanguageProjectSymbolIndex = {
      files,
      filesByPackage: new Map<string, string[]>(),
      filesByPackageSymbol: new Map<string, Map<string, string[]>>(),
    };

    const indexEntries = await mapLimitSemaphore(files, 8, async (filePath) => {
      try {
        const entry = await readPhpSymbolIndex(filePath);
        return { filePath, entry };
      } catch {
        return null;
      }
    });

    for (const indexEntry of indexEntries) {
      if (!indexEntry) continue;
      for (const packageEntry of indexEntry.entry.packageEntries) {
        addProjectSymbolFile(index, packageEntry.packageName, indexEntry.filePath, packageEntry.symbols);
      }
    }

    sortProjectSymbolIndex(index);
    return index;
  });
}

async function readPhpSymbolIndex(filePath: string): Promise<PhpSymbolIndexEntry> {
  const cached = phpSymbolIndexCache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  const packageEntries = extractPhpTopLevelPackageEntries(source);
  const primaryEntry = packageEntries[0] ?? {
    packageName: "",
    symbols: new Set<string>(),
    kindsBySymbol: new Map<string, Set<PhpSymbolKind>>(),
  };
  const symbols = new Set<string>();
  const kindsBySymbol = new Map<string, Set<PhpSymbolKind>>();
  const addSymbol = (symbolName: string, symbolKind: PhpSymbolKind): void => {
    symbols.add(symbolName);
    const currentKinds = kindsBySymbol.get(symbolName) ?? new Set();
    currentKinds.add(symbolKind);
    kindsBySymbol.set(symbolName, currentKinds);
  };
  for (const packageEntry of packageEntries) {
    for (const symbolName of packageEntry.symbols) {
      const symbolKinds = packageEntry.kindsBySymbol.get(symbolName);
      if (!symbolKinds) continue;
      for (const symbolKind of symbolKinds) {
        addSymbol(symbolName, symbolKind);
      }
    }
  }

  const entry = {
    packageName: primaryEntry.packageName,
    symbols,
    kindsBySymbol,
    packageEntries,
  };
  phpSymbolIndexCache.set(filePath, entry);
  return entry;
}

type PhpScannerToken =
  | { type: "word"; value: string }
  | { type: "brace_open" | "brace_close" | "paren_open" | "paren_close" }
  | { type: "semicolon" | "comma" | "backslash" | "ampersand" | "equals" };

function extractPhpTopLevelPackageEntries(source: string): PhpPackageSymbolIndexEntry[] {
  const packageEntries = new Map<string, PhpPackageSymbolIndexEntry>();
  const getPackageEntry = (packageName: string): PhpPackageSymbolIndexEntry => {
    const existing = packageEntries.get(packageName);
    if (existing) return existing;
    const entry: PhpPackageSymbolIndexEntry = {
      packageName,
      symbols: new Set<string>(),
      kindsBySymbol: new Map<string, Set<PhpSymbolKind>>(),
    };
    packageEntries.set(packageName, entry);
    return entry;
  };
  const addSymbol = (packageName: string, symbolName: string, symbolKind: PhpSymbolKind): void => {
    const entry = getPackageEntry(packageName);
    entry.symbols.add(symbolName);
    const symbolKinds = entry.kindsBySymbol.get(symbolName) ?? new Set();
    symbolKinds.add(symbolKind);
    entry.kindsBySymbol.set(symbolName, symbolKinds);
  };
  const tokens = tokenizePhpSource(source);
  let braceDepth = 0;
  const namespaceBlockDepths: Array<{ packageName: string; depth: number }> = [];
  const classLikeDepths: number[] = [];
  const functionLikeDepths: number[] = [];
  let activeNamespace = "";
  let pendingBlock: { type: "class" | "function" } | null = null;

  const inDeclarationBody = (): boolean => !!(classLikeDepths.length || functionLikeDepths.length);
  const currentNamespace = (): string =>
    namespaceBlockDepths[namespaceBlockDepths.length - 1]?.packageName ?? activeNamespace;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;

    if (token.type === "brace_open") {
      braceDepth += 1;
      if (pendingBlock?.type === "class") {
        classLikeDepths.push(braceDepth);
      } else if (pendingBlock?.type === "function") {
        functionLikeDepths.push(braceDepth);
      }
      pendingBlock = null;
      continue;
    }

    if (token.type === "brace_close") {
      if (classLikeDepths[classLikeDepths.length - 1] === braceDepth) {
        classLikeDepths.pop();
      }
      if (functionLikeDepths[functionLikeDepths.length - 1] === braceDepth) {
        functionLikeDepths.pop();
      }
      if (namespaceBlockDepths[namespaceBlockDepths.length - 1]?.depth === braceDepth) {
        namespaceBlockDepths.pop();
      }
      braceDepth = Math.max(0, braceDepth - 1);
      pendingBlock = null;
      continue;
    }

    if (token.type === "semicolon") {
      pendingBlock = null;
      continue;
    }

    if (token.type !== "word") {
      continue;
    }

    if (token.value === "namespace" && !inDeclarationBody()) {
      let packageName = "";
      let lookahead = index + 1;
      while (lookahead < tokens.length) {
        const nextToken = tokens[lookahead];
        if (!nextToken) break;
        if (nextToken.type === "word") {
          packageName += nextToken.value;
          lookahead += 1;
          continue;
        }
        if (nextToken.type === "backslash") {
          packageName += "\\";
          lookahead += 1;
          continue;
        }
        if (nextToken.type === "brace_open") {
          braceDepth += 1;
          namespaceBlockDepths.push({ packageName, depth: braceDepth });
          index = lookahead;
          break;
        }
        if (nextToken.type === "semicolon") {
          activeNamespace = packageName;
          index = lookahead;
          break;
        }
        lookahead += 1;
      }
      continue;
    }

    if (
      (token.value === "class" || token.value === "interface" || token.value === "trait" || token.value === "enum") &&
      !inDeclarationBody()
    ) {
      let lookahead = index + 1;
      let symbolName: string | null = null;
      while (lookahead < tokens.length) {
        const nextToken = tokens[lookahead];
        if (!nextToken) break;
        if (nextToken.type === "word") {
          symbolName = nextToken.value;
          break;
        }
        if (nextToken.type === "brace_open" || nextToken.type === "semicolon") {
          break;
        }
        lookahead += 1;
      }
      if (symbolName) {
        addSymbol(currentNamespace(), symbolName, "class");
      }
      pendingBlock = { type: "class" };
      continue;
    }

    if (token.value === "function" && !inDeclarationBody()) {
      let lookahead = index + 1;
      if (tokens[lookahead]?.type === "ampersand") {
        lookahead += 1;
      }
      const nextToken = tokens[lookahead];
      if (nextToken?.type === "word") {
        addSymbol(currentNamespace(), nextToken.value, "function");
      }
      pendingBlock = { type: "function" };
      continue;
    }

    if (token.value === "const" && !inDeclarationBody()) {
      let lookahead = index + 1;
      let expectingName = true;
      while (lookahead < tokens.length) {
        const nextToken = tokens[lookahead];
        if (!nextToken || nextToken.type === "semicolon") {
          index = lookahead;
          break;
        }
        if (nextToken.type === "comma") {
          expectingName = true;
          lookahead += 1;
          continue;
        }
        if (nextToken.type === "equals") {
          expectingName = false;
          lookahead += 1;
          continue;
        }
        if (nextToken.type === "word" && expectingName) {
          addSymbol(currentNamespace(), nextToken.value, "const");
          expectingName = false;
          lookahead += 1;
          continue;
        }
        lookahead += 1;
      }
    }
  }

  if (packageEntries.size === 0) {
    packageEntries.set("", {
      packageName: "",
      symbols: new Set<string>(),
      kindsBySymbol: new Map<string, Set<PhpSymbolKind>>(),
    });
  }

  return Array.from(packageEntries.values()).sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function tokenizePhpSource(source: string): PhpScannerToken[] {
  const tokens: PhpScannerToken[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const ch = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (/\s/.test(ch)) continue;

    if (ch === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (index < source.length - 1 && !(source[index] === "*" && source[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }
    if (ch === "#" && next === "[") {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        const current = source[index] ?? "";
        const afterCurrent = source[index + 1] ?? "";
        if (current === "'" || current === '"') {
          const quote = current;
          index += 1;
          while (index < source.length) {
            if (source[index] === "\\") {
              index += 2;
              continue;
            }
            if (source[index] === quote) break;
            index += 1;
          }
          index += 1;
          continue;
        }
        if (current === "/" && afterCurrent === "*") {
          index += 2;
          while (index < source.length - 1 && !(source[index] === "*" && source[index + 1] === "/")) {
            index += 1;
          }
          index += 2;
          continue;
        }
        if (current === "[" || current === "(" || current === "{") {
          depth += 1;
          index += 1;
          continue;
        }
        if (current === "]" || current === ")" || current === "}") {
          depth -= 1;
          index += 1;
          continue;
        }
        index += 1;
      }
      index -= 1;
      continue;
    }
    if (ch === "#") {
      index += 1;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) break;
        index += 1;
      }
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let end = index + 1;
      while (end < source.length && /[A-Za-z0-9_]/.test(source[end] ?? "")) {
        end += 1;
      }
      tokens.push({ type: "word", value: source.slice(index, end) });
      index = end - 1;
      continue;
    }

    if (ch === "{") {
      tokens.push({ type: "brace_open" });
      continue;
    }
    if (ch === "}") {
      tokens.push({ type: "brace_close" });
      continue;
    }
    if (ch === "(") {
      tokens.push({ type: "paren_open" });
      continue;
    }
    if (ch === ")") {
      tokens.push({ type: "paren_close" });
      continue;
    }
    if (ch === ";") {
      tokens.push({ type: "semicolon" });
      continue;
    }
    if (ch === ",") {
      tokens.push({ type: "comma" });
      continue;
    }
    if (ch === "\\") {
      tokens.push({ type: "backslash" });
      continue;
    }
    if (ch === "&") {
      tokens.push({ type: "ampersand" });
      continue;
    }
    if (ch === "=") {
      tokens.push({ type: "equals" });
    }
  }

  return tokens;
}

function readComposerNamespaceDirs(value: unknown, composerDir: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!value || typeof value !== "object") {
    return result;
  }
  for (const [prefix, rawTarget] of Object.entries(value as Record<string, unknown>)) {
    const targets = Array.isArray(rawTarget) ? rawTarget : [rawTarget];
    const dirs = targets
      .filter((target): target is string => typeof target === "string")
      .map((target) => resolveComposerPath(target, composerDir));
    if (dirs.length) {
      result.set(prefix, dirs);
    }
  }
  return result;
}

function mergeComposerNamespaceDirMaps(...maps: Map<string, string[]>[]): Map<string, string[]> {
  const merged = new Map<string, string[]>();
  for (const map of maps) {
    for (const [prefix, dirs] of map) {
      const currentDirs = merged.get(prefix) ?? [];
      const dedupedDirs = Array.from(new Set([...currentDirs, ...dirs]));
      merged.set(prefix, dedupedDirs);
    }
  }
  return merged;
}

function resolveComposerPath(entry: string, composerDir: string): string {
  if (entry.startsWith("/") || entry.startsWith("\\")) {
    return path.resolve(composerDir, `.${entry}`);
  }
  if (/^[A-Za-z]:[\\/]/.test(entry) || path.isAbsolute(entry)) {
    return path.resolve(entry);
  }
  return path.resolve(composerDir, entry);
}

function readComposerStringList(value: unknown, composerDir: string): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => resolveComposerPath(entry, composerDir));
}

async function loadPhpComposerConfig(composerPath: string): Promise<PhpComposerConfig | null> {
  const cached = phpComposerConfigCache.get(composerPath);
  if (cached) return await cached;

  const pending = (async () => {
    try {
      const raw = await fsp.readFile(composerPath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const composerDir = path.dirname(composerPath);
      const autoload =
        parsed.autoload && typeof parsed.autoload === "object" ? (parsed.autoload as Record<string, unknown>) : {};
      const autoloadDev =
        parsed["autoload-dev"] && typeof parsed["autoload-dev"] === "object"
          ? (parsed["autoload-dev"] as Record<string, unknown>)
          : {};

      const psr4 = mergeComposerNamespaceDirMaps(
        readComposerNamespaceDirs(autoload["psr-4"], composerDir),
        readComposerNamespaceDirs(autoloadDev["psr-4"], composerDir),
      );
      const psr0 = mergeComposerNamespaceDirMaps(
        readComposerNamespaceDirs(autoload["psr-0"], composerDir),
        readComposerNamespaceDirs(autoloadDev["psr-0"], composerDir),
      );
      const classmap = [
        ...readComposerStringList(autoload["classmap"], composerDir),
        ...readComposerStringList(autoloadDev["classmap"], composerDir),
      ];
      const excludeFromClassmap = [
        ...readComposerStringList(autoload["exclude-from-classmap"], composerDir),
        ...readComposerStringList(autoloadDev["exclude-from-classmap"], composerDir),
      ];
      const files = [
        ...readComposerStringList(autoload["files"], composerDir),
        ...readComposerStringList(autoloadDev["files"], composerDir),
      ];

      return { psr4, psr0, classmap, excludeFromClassmap, files };
    } catch {
      return null;
    }
  })();

  phpComposerConfigCache.set(composerPath, pending);
  return await pending;
}

function sortPhpComposerMappings(mappings: Map<string, string[]>): Array<[string, string[]]> {
  return Array.from(mappings.entries()).sort((left, right) => right[0].length - left[0].length);
}

async function resolvePhpPsr4MappedPath(spec: string, mappings: Map<string, string[]>): Promise<string | null> {
  const normalizedSpec = spec.replace(/^\\+/, "");
  const mappingEntries = sortPhpComposerMappings(mappings);

  for (const [prefix, dirs] of mappingEntries) {
    if (!normalizedSpec.startsWith(prefix)) continue;
    const suffix = normalizedSpec.slice(prefix.length).replace(/\\/g, "/");
    for (const dir of dirs) {
      const basePath = suffix ? path.join(dir, suffix) : dir;
      const resolved = await findFirstExistingResolutionCandidate(basePath, [".php"]);
      if (resolved) return resolved;
    }
  }

  return null;
}

function buildPhpPsr0RelativePath(spec: string, prefix: string): string | null {
  if (!spec.startsWith(prefix)) return null;
  const suffix = spec.slice(prefix.length);
  const namespaceParts = suffix.split("\\");
  const classPart = namespaceParts.pop() ?? "";
  const namespacePath = namespaceParts.filter(Boolean).join("/");
  const classPath = classPart.replace(/_/g, "/");
  return [namespacePath, classPath].filter(Boolean).join("/");
}

async function resolvePhpPsr0MappedPath(spec: string, mappings: Map<string, string[]>): Promise<string | null> {
  const normalizedSpec = spec.replace(/^\\+/, "");
  const mappingEntries = sortPhpComposerMappings(mappings);

  for (const [prefix, dirs] of mappingEntries) {
    const relativePath = buildPhpPsr0RelativePath(normalizedSpec, prefix);
    if (relativePath === null) continue;
    for (const dir of dirs) {
      const basePath = relativePath ? path.join(dir, relativePath) : dir;
      const resolved = await findFirstExistingResolutionCandidate(basePath, [".php"]);
      if (resolved) return resolved;
    }
  }

  return null;
}

async function resolvePhpSymbolImportPath(
  projectRoot: string,
  spec: string,
  preferredKind?: "class" | "function" | "const",
  allowedFiles?: Set<string>,
): Promise<string | null> {
  const normalizedSpec = spec.replace(/^\\+/, "");
  const projectIndex = await getPhpProjectSymbolIndex(projectRoot);
  const pickCandidate = async (candidates: string[], symbolName?: string): Promise<string | null> => {
    for (const candidate of candidates) {
      const resolvedCandidate = path.resolve(candidate);
      if (allowedFiles && !allowedFiles.has(resolvedCandidate)) {
        continue;
      }
      if (!symbolName || !preferredKind) {
        return resolvedCandidate;
      }
      const entry = await readPhpSymbolIndex(resolvedCandidate);
      const symbolKinds = entry.kindsBySymbol.get(symbolName);
      if (symbolKinds?.has(preferredKind)) {
        return resolvedCandidate;
      }
    }
    return null;
  };

  const exactNamespaceFiles = projectIndex.filesByPackage.get(normalizedSpec) ?? [];
  const exactNamespaceHit = await pickCandidate(exactNamespaceFiles);
  if (exactNamespaceHit) {
    return exactNamespaceHit;
  }

  const parts = normalizedSpec.split("\\").filter(Boolean);
  if (parts.length === 1) {
    const globalFiles = projectIndex.filesByPackageSymbol.get("")?.get(parts[0]!) ?? [];
    return await pickCandidate(globalFiles, parts[0]);
  }

  if (parts.length < 2) {
    return null;
  }

  const importedName = parts[parts.length - 1]!;
  const packageName = parts.slice(0, -1).join("\\");
  const symbolFiles = projectIndex.filesByPackageSymbol.get(packageName)?.get(importedName) ?? [];
  const symbolHit = await pickCandidate(symbolFiles, importedName);
  if (symbolHit) {
    return symbolHit;
  }

  const packageFiles = projectIndex.filesByPackage.get(packageName) ?? [];
  return await pickCandidate(packageFiles, importedName);
}

async function findPhpComposerPath(projectRoot: string, fromFile: string): Promise<string | null> {
  return (
    (await findNearestFile(path.dirname(fromFile), projectRoot, "composer.json")) ??
    ((await fileExists(path.join(projectRoot, "composer.json"))) ? path.join(projectRoot, "composer.json") : null)
  );
}

export async function getPhpComposerImplicitFiles(projectRoot: string, fromFile: string): Promise<string[]> {
  const composerPath = await findPhpComposerPath(projectRoot, fromFile);
  if (!composerPath) {
    return [];
  }

  const composerConfig = await loadPhpComposerConfig(composerPath);
  if (!composerConfig) {
    return [];
  }

  const deduped = new Set<string>();
  for (const filePath of composerConfig.files) {
    if (!(await fileExists(filePath))) continue;
    deduped.add(path.resolve(filePath));
  }
  return Array.from(deduped);
}

async function getPhpComposerAutoloadFiles(
  composerPath: string,
  composerConfig: PhpComposerConfig,
): Promise<Set<string>> {
  const cached = phpComposerAutoloadFileCache.get(composerPath);
  if (cached) {
    return await cached;
  }

  const pending = (async () => {
    const candidates = new Set<string>();
    const roots = new Set<string>([
      ...composerConfig.classmap,
      ...composerConfig.files,
      ...Array.from(composerConfig.psr4.values()).flat(),
      ...Array.from(composerConfig.psr0.values()).flat(),
    ]);

    for (const root of roots) {
      try {
        const stat = await fsp.stat(root);
        if (stat.isDirectory()) {
          const files = await listProjectFiles(root, ["**/*.php"]);
          for (const filePath of files) {
            if (isPhpComposerClassmapExcluded(filePath, composerConfig)) {
              continue;
            }
            candidates.add(path.resolve(filePath));
          }
          continue;
        }
        if (stat.isFile() && root.toLowerCase().endsWith(".php")) {
          if (isPhpComposerClassmapExcluded(root, composerConfig)) continue;
          candidates.add(path.resolve(root));
        }
      } catch {
        // Ignore missing Composer autoload roots.
      }
    }

    return candidates;
  })();

  phpComposerAutoloadFileCache.set(composerPath, pending);
  return await pending;
}

function isPhpComposerClassmapExcluded(filePath: string, composerConfig: PhpComposerConfig): boolean {
  const normalizedFile = normalizePath(path.resolve(filePath));
  return composerConfig.excludeFromClassmap.some((entry) => {
    const normalizedEntry = normalizePath(path.resolve(entry)).replace(/\/+$/, "");
    return normalizedFile === normalizedEntry || normalizedFile.startsWith(`${normalizedEntry}/`);
  });
}

export async function resolvePhpImportPath(
  projectRoot: string,
  fromFile: string,
  spec: string,
  preferredKind?: "class" | "function" | "const",
): Promise<string | null> {
  const cacheKey = `${projectRoot}::${fromFile}::${spec}::${preferredKind ?? "any"}`;
  const cached = phpImportResolutionCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const normalizedSpec = spec.trim();
  const isPathLike =
    normalizedSpec.startsWith(".") || normalizedSpec.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalizedSpec);
  if (isPathLike) {
    const fileResolved = await resolvePhpPathLikeSpecifier(projectRoot, fromFile, normalizedSpec);
    phpImportResolutionCache.set(cacheKey, fileResolved);
    return fileResolved;
  }

  const composerPath = await findPhpComposerPath(projectRoot, fromFile);
  if (composerPath) {
    const composerConfig = await loadPhpComposerConfig(composerPath);
    if (composerConfig) {
      if (!preferredKind || preferredKind === "class") {
        const psr4Resolved = await resolvePhpPsr4MappedPath(normalizedSpec, composerConfig.psr4);
        if (psr4Resolved) {
          phpImportResolutionCache.set(cacheKey, psr4Resolved);
          return psr4Resolved;
        }
        const psr0Resolved = await resolvePhpPsr0MappedPath(normalizedSpec, composerConfig.psr0);
        if (psr0Resolved) {
          phpImportResolutionCache.set(cacheKey, psr0Resolved);
          return psr0Resolved;
        }
      }

      const autoloadFiles = await getPhpComposerAutoloadFiles(composerPath, composerConfig);
      const symbolResolved = await resolvePhpSymbolImportPath(
        projectRoot,
        normalizedSpec,
        preferredKind,
        autoloadFiles,
      );
      if (symbolResolved && !isPhpComposerClassmapExcluded(symbolResolved, composerConfig)) {
        phpImportResolutionCache.set(cacheKey, symbolResolved);
        return symbolResolved;
      }

      phpImportResolutionCache.set(cacheKey, null);
      return null;
    }
  }

  const symbolResolved = await resolvePhpSymbolImportPath(projectRoot, normalizedSpec, preferredKind);
  if (symbolResolved) {
    phpImportResolutionCache.set(cacheKey, symbolResolved);
    return symbolResolved;
  }

  const pathLikeResolved = await resolvePathLikePhpModule(projectRoot, normalizedSpec.replace(/\\/g, "/"));
  phpImportResolutionCache.set(cacheKey, pathLikeResolved);
  return pathLikeResolved;
}

export function clearPhpResolutionCaches(): void {
  phpImportResolutionCache.clear();
  phpSymbolIndexCache.clear();
  phpProjectSymbolIndexCache.clear();
  phpComposerConfigCache.clear();
  phpComposerAutoloadFileCache.clear();
}
