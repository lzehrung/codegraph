import fsp from "node:fs/promises";
import path from "node:path";
import {
  addProjectSymbolFile,
  getOrCreateProjectSymbolIndex,
  listProjectLanguageFiles,
  sortProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./project-symbols.js";
import { mapLimitSemaphore } from "../concurrency.js";
import { CSHARP_IDENTIFIER_SOURCE } from "../identifiers.js";

// A namespace name may be qualified (`namespace A.B { }`) and either block-scoped (closing
// `{`) or file-scoped (closing `;`). Both forms declare the same namespace for a file, and a
// file may declare several namespaces, so every match is indexed.
const CSHARP_NAMESPACE_DECLARATION_PATTERN = new RegExp(
  String.raw`^\s*namespace\s+(${CSHARP_IDENTIFIER_SOURCE}(?:\s*\.\s*${CSHARP_IDENTIFIER_SOURCE})*)\s*[;{]`,
  "gmu",
);

type CsharpNamespaceIndexEntry = {
  namespaces: string[];
};

const csharpNamespaceFileCache = new Map<string, CsharpNamespaceIndexEntry>();
const csharpProjectNamespaceIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();

/**
 * Blanks C# comments and string literals in place, preserving offsets and line breaks, so a
 * namespace scan cannot read `namespace` out of trivia. Over-masking only risks missing a real
 * declaration, never inventing one.
 */
function maskCsharpTrivia(source: string): string {
  if (!source.includes("/") && !source.includes('"') && !source.includes("'")) return source;
  const masked = source.split("");
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to && index < masked.length; index += 1) {
      const ch = masked[index];
      if (ch !== "\n" && ch !== "\r") masked[index] = " ";
    }
  };
  for (let index = 0; index < source.length; ) {
    const ch = source[index];
    if (ch === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      const end = newline < 0 ? source.length : newline;
      blank(index, end);
      index = end;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      const end = close < 0 ? source.length : close + 2;
      blank(index, end);
      index = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      // A raw string opens with a run of three or more quotes and closes with the same run.
      let quoteRun = 0;
      while (source[index + quoteRun] === '"') quoteRun += 1;
      const end =
        quoteRun >= 3 ? scanCsharpRawLiteral(source, index, quoteRun) : scanCsharpQuotedLiteral(source, index, ch);
      blank(index, end);
      index = end;
      continue;
    }
    index += 1;
  }
  return masked.join("");
}

function scanCsharpQuotedLiteral(source: string, start: number, quote: '"' | "'"): number {
  const verbatim = quote === '"' && start > 0 && hasCsharpVerbatimPrefix(source, start);
  for (let index = start + 1; index < source.length; index += 1) {
    const ch = source[index];
    if (verbatim) {
      if (ch === '"') {
        if (source[index + 1] === '"') {
          index += 1;
          continue;
        }
        return index + 1;
      }
      continue;
    }
    if (ch === "\\") {
      index += 1;
      continue;
    }
    if (ch === quote) return index + 1;
  }
  return source.length;
}

/** True when the quote at `quoteIndex` closes the `@` (or `$@`/`@$`) prefix of a verbatim string. */
function hasCsharpVerbatimPrefix(source: string, quoteIndex: number): boolean {
  for (let index = quoteIndex - 1; index >= 0 && (source[index] === "$" || source[index] === "@"); index -= 1) {
    if (source[index] === "@") return true;
  }
  return false;
}

function scanCsharpRawLiteral(source: string, start: number, quoteRun: number): number {
  const close = source.indexOf('"'.repeat(quoteRun), start + quoteRun);
  return close < 0 ? source.length : close + quoteRun;
}

async function readCsharpNamespaceIndex(filePath: string): Promise<CsharpNamespaceIndexEntry> {
  const cached = csharpNamespaceFileCache.get(filePath);
  if (cached) return cached;

  const source = await fsp.readFile(filePath, "utf8");
  const namespaces = new Set<string>();
  for (const match of maskCsharpTrivia(source).matchAll(CSHARP_NAMESPACE_DECLARATION_PATTERN)) {
    const namespaceName = match[1];
    if (namespaceName) namespaces.add(namespaceName.replace(/\s+/gu, ""));
  }

  const entry = { namespaces: Array.from(namespaces) };
  csharpNamespaceFileCache.set(filePath, entry);
  return entry;
}

async function buildCsharpProjectNamespaceIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  const files = await listProjectLanguageFiles(projectRoot, ["**/*.cs", "**/*.csx"]);
  const index: LanguageProjectSymbolIndex = {
    files,
    filesByPackage: new Map<string, string[]>(),
    filesByPackageSymbol: new Map<string, Map<string, string[]>>(),
  };

  const entries = await mapLimitSemaphore(files, 8, async (filePath) => {
    try {
      return { filePath, entry: await readCsharpNamespaceIndex(filePath) };
    } catch {
      // Ignore unreadable files and keep indexing the project.
      return null;
    }
  });

  for (const item of entries) {
    if (!item) continue;
    for (const namespaceName of item.entry.namespaces) {
      addProjectSymbolFile(index, namespaceName, item.filePath, new Set<string>());
    }
  }

  sortProjectSymbolIndex(index);
  return index;
}

async function getCsharpProjectNamespaceIndex(projectRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(csharpProjectNamespaceIndexCache, projectRoot, () =>
    buildCsharpProjectNamespaceIndex(projectRoot),
  );
}

/**
 * Every file under `projectRoot` that declares `spec` as a namespace, via either a block-scoped
 * or a file-scoped namespace declaration. Sorted by the shared project symbol index.
 */
export async function resolveCsharpNamespaceImportPaths(projectRoot: string, spec: string): Promise<string[]> {
  const projectIndex = await getCsharpProjectNamespaceIndex(projectRoot);
  const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
  return packageCandidates.map((candidate) => path.resolve(candidate));
}

export function clearCsharpResolutionCaches(): void {
  csharpNamespaceFileCache.clear();
  csharpProjectNamespaceIndexCache.clear();
}
