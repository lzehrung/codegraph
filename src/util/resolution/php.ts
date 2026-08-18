import fsp from "node:fs/promises";
import path from "node:path";
import { stringifyUnknown } from "../ast.js";
import { mapLimitSemaphore } from "../concurrency.js";
import { findFirstExistingResolutionCandidate } from "./findFirstExisting.js";
import {
  clearPhpComposerResolutionCaches,
  findPhpComposerPath,
  getPhpComposerAutoloadFiles,
  loadPhpComposerConfig,
  resolvePhpPsr0MappedPath,
  resolvePhpPsr4MappedPath,
} from "./phpComposer.js";
export { getPhpComposerImplicitFiles } from "./phpComposer.js";
import {
  addProjectSymbolFile,
  getOrCreateProjectSymbolIndex,
  listProjectLanguageFiles,
  sortProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./projectSymbols.js";
import { PHP_IDENTIFIER_SOURCE } from "../identifiers.js";

const PHP_IDENTIFIER_PATTERN = new RegExp(PHP_IDENTIFIER_SOURCE, "uy");

type FileId = string;

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

const phpImportResolutionCache = new Map<string, string | null>();
const phpSymbolIndexCache = new Map<string, PhpSymbolIndexEntry>();
const phpProjectSymbolIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();

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

    PHP_IDENTIFIER_PATTERN.lastIndex = index;
    const identifierMatch = PHP_IDENTIFIER_PATTERN.exec(source);
    if (identifierMatch) {
      const end = PHP_IDENTIFIER_PATTERN.lastIndex;
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
      if (symbolResolved) {
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
  clearPhpComposerResolutionCaches();
}
