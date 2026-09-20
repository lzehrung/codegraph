import { confineResolvedPath, readUtf8WithoutBom } from "../paths.js";
import { CSHARP_IDENTIFIER_SOURCE } from "../identifiers.js";
import { getImportableLanguageGlobs } from "../resolution-candidates.js";
import { maskTrivia } from "../trivia.js";
import { CSHARP_PACKAGE_MANIFEST_NAMES, resolveNearestManifestRoot } from "./files.js";
import {
  buildDeclaredContainerIndex,
  getOrCreateProjectSymbolIndex,
  type LanguageProjectSymbolIndex,
} from "./project-symbols.js";

// A namespace name may be qualified (`namespace A.B { }`) and either block-scoped (closing
// `{`) or file-scoped (closing `;`). Both forms declare the same namespace for a file, a file
// may declare several namespaces, and a block-scoped namespace may nest inside another, so
// every declaration is indexed under its composed name.
const CSHARP_NAMESPACE_DECLARATION_PATTERN = new RegExp(
  String.raw`(?<![\w@.])namespace\s+(${CSHARP_IDENTIFIER_SOURCE}(?:\s*\.\s*${CSHARP_IDENTIFIER_SOURCE})*)\s*[;{]`,
  "gu",
);

type CsharpNamespaceIndexEntry = {
  namespaces: string[];
};

type CsharpNamespaceScope = {
  /** Brace depth when the namespace's own `{` was opened, used to close it on the matching `}`. */
  openedDepth: number;
  /** Fully qualified name contributed by this block. */
  name: string;
};

const csharpNamespaceFileCache = new Map<string, CsharpNamespaceIndexEntry>();
const csharpProjectNamespaceIndexCache = new Map<string, Promise<LanguageProjectSymbolIndex>>();

/**
 * Blanks C# comments and string literals in place, preserving offsets and line breaks, so a
 * namespace scan cannot read `namespace` out of trivia. Over-masking only risks missing a real
 * declaration, never inventing one. Routed through the shared trivia scanner's C# row, which
 * handles verbatim `@""` doubling, raw `"""` quote runs, and ordinary escaped literals.
 */
function maskCsharpTrivia(source: string): string {
  return maskTrivia(source, "csharp");
}

/**
 * Every namespace a file declares, qualified by its enclosing block-scoped namespaces, so
 * `namespace Outer { namespace Inner { } }` yields both `Outer` and `Outer.Inner`. Brace depth
 * is tracked on the masked source, so braces inside comments and strings cannot compose a name,
 * and a namespace nested inside a non-namespace construct is not qualified by that construct.
 */
function collectCsharpNamespaceNames(source: string): string[] {
  const masked = maskCsharpTrivia(source);
  const names = new Set<string>();
  const scopes: CsharpNamespaceScope[] = [];
  let depth = 0;
  let cursor = 0;
  for (const match of masked.matchAll(CSHARP_NAMESPACE_DECLARATION_PATTERN)) {
    const matchIndex = match.index;
    for (; cursor < matchIndex; cursor += 1) {
      const ch = masked[cursor];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        while (scopes.length && scopes[scopes.length - 1]!.openedDepth >= depth) scopes.pop();
      }
    }
    const namespaceName = match[1];
    if (!namespaceName) continue;
    const normalized = namespaceName.replace(/\s+/gu, "");
    const terminator = masked[matchIndex + match[0].length - 1];
    cursor = matchIndex + match[0].length;
    if (terminator !== "{") {
      // A file-scoped namespace is always top level and does not open a scope.
      names.add(normalized);
      continue;
    }
    const enclosing = scopes.length ? scopes[scopes.length - 1]!.name : null;
    const qualified = enclosing ? `${enclosing}.${normalized}` : normalized;
    names.add(qualified);
    scopes.push({ openedDepth: depth, name: qualified });
    depth += 1;
  }
  return Array.from(names);
}

async function readCsharpNamespaceIndex(filePath: string): Promise<CsharpNamespaceIndexEntry> {
  const cached = csharpNamespaceFileCache.get(filePath);
  if (cached) return cached;

  const source = await readUtf8WithoutBom(filePath);
  const entry = { namespaces: collectCsharpNamespaceNames(source) };
  csharpNamespaceFileCache.set(filePath, entry);
  return entry;
}

async function getCsharpProjectNamespaceIndex(indexRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(csharpProjectNamespaceIndexCache, indexRoot, async () =>
    buildDeclaredContainerIndex(indexRoot, getImportableLanguageGlobs("csharp"), async (filePath) => {
      const entry = await readCsharpNamespaceIndex(filePath);
      return entry.namespaces.map((name) => ({ name }));
    }),
  );
}

/**
 * Every file under the nearest C# project manifest (or `projectRoot` when none
 * exists) that declares `spec` as a namespace, via either a block-scoped or a
 * file-scoped namespace declaration. Sorted by the shared project symbol index.
 */
export async function resolveCsharpNamespaceImportPaths(
  projectRoot: string,
  spec: string,
  fromFile: string,
): Promise<string[]> {
  const indexRoot = await resolveNearestManifestRoot(projectRoot, fromFile, CSHARP_PACKAGE_MANIFEST_NAMES);
  const projectIndex = await getCsharpProjectNamespaceIndex(indexRoot);
  const packageCandidates = projectIndex.filesByPackage.get(spec) ?? [];
  const confined: string[] = [];
  for (const candidate of packageCandidates) {
    const hit = await confineResolvedPath(projectRoot, candidate);
    if (hit) confined.push(hit);
  }
  return confined;
}

export function clearCsharpResolutionCaches(): void {
  csharpNamespaceFileCache.clear();
  csharpProjectNamespaceIndexCache.clear();
}
