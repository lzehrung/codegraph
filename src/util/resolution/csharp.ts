import { confineResolvedPath, fileIdentityKey, readUtf8WithoutBom } from "../paths.js";
import { CSHARP_IDENTIFIER_SOURCE, normalizeCsharpIdentifier, normalizeCsharpQualifiedName } from "../identifiers.js";
import { getImportableLanguageGlobs } from "../resolution-candidates.js";
import { maskTrivia } from "../trivia.js";
import { selectUniqueCsharpNamespaceTypeFile } from "../../indexer/shared-owner-identity.js";
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
// Namespace-direct types only. A nested `class Point` inside another type is not `N.Point`.
// `delegate` is omitted: its return type sits where a type name would, so a naive match
// would index `void` from `delegate void Point()`.
const CSHARP_TYPE_DECLARATION_PATTERN = new RegExp(
  String.raw`(?<![\w@.])(?:class|struct|interface|enum|record)\s+(?:(?:class|struct)\s+)?(${CSHARP_IDENTIFIER_SOURCE})`,
  "gu",
);

type CsharpNamespaceIndexEntry = {
  namespaces: string[];
  symbolsByNamespace: ReadonlyMap<string, ReadonlySet<string>>;
};

/**
 * A namespace-qualified type name found in more than one declaring file.
 * `found` is the one declaration, or the partial-type representative when every
 * part shares one owner. `ambiguous` and `partial` never name a file: ambiguity
 * is proven, and `partial` means a candidate could not be read so uniqueness is
 * not proven. Callers must not fall through to the first path match.
 */
export type CsharpNamespaceTypeResolution =
  | { status: "found"; file: string }
  | { status: "not_found" }
  | { status: "ambiguous" }
  | { status: "partial" };

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
 * Namespaces a file declares, plus the types declared directly in each one.
 * `@P` and `P` are one namespace, and `namespace Outer { namespace Inner {} }` is
 * `Outer.Inner`, matching compilation-unit identity. Brace depth is tracked on the
 * masked source, so braces inside comments and strings cannot compose a name, and a
 * type nested inside another type is not recorded under the enclosing namespace.
 */
function collectCsharpNamespaceIndex(source: string): {
  namespaces: string[];
  symbolsByNamespace: Map<string, Set<string>>;
} {
  const masked = maskCsharpTrivia(source);
  const namespaces = new Set<string>();
  const symbolsByNamespace = new Map<string, Set<string>>();
  const scopes: CsharpNamespaceScope[] = [];
  let fileScoped: string | null = null;
  let depth = 0;
  let cursor = 0;

  type ScanEvent = { index: number; kind: "namespace" | "type"; match: RegExpMatchArray };
  const events: ScanEvent[] = [];
  for (const match of masked.matchAll(CSHARP_NAMESPACE_DECLARATION_PATTERN)) {
    events.push({ index: match.index ?? 0, kind: "namespace", match });
  }
  for (const match of masked.matchAll(CSHARP_TYPE_DECLARATION_PATTERN)) {
    events.push({ index: match.index ?? 0, kind: "type", match });
  }
  events.sort((left, right) => left.index - right.index || (left.kind === "namespace" ? -1 : 1));

  const advance = (to: number): void => {
    for (; cursor < to; cursor += 1) {
      const ch = masked[cursor];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        while (scopes.length && scopes[scopes.length - 1]!.openedDepth >= depth) scopes.pop();
      }
    }
  };

  for (const event of events) {
    advance(event.index);
    if (event.kind === "namespace") {
      const namespaceName = event.match[1];
      if (!namespaceName) continue;
      const normalized = normalizeCsharpQualifiedName(namespaceName);
      if (!normalized) continue;
      const matchEnd = event.index + event.match[0].length;
      const terminator = masked[matchEnd - 1];
      cursor = matchEnd;
      if (terminator !== "{") {
        // A file-scoped namespace is always top level and does not open a scope.
        fileScoped = normalized;
        namespaces.add(normalized);
        continue;
      }
      const enclosing = scopes.length ? scopes[scopes.length - 1]!.name : null;
      const qualified = enclosing ? `${enclosing}.${normalized}` : normalized;
      namespaces.add(qualified);
      scopes.push({ openedDepth: depth, name: qualified });
      depth += 1;
      continue;
    }

    const rawName = event.match[1];
    if (!rawName) continue;
    const typeName = normalizeCsharpIdentifier(rawName);
    if (!typeName) continue;
    const currentNamespace = scopes.length ? scopes[scopes.length - 1]!.name : fileScoped;
    if (!currentNamespace) continue;
    const contentDepth = scopes.length ? scopes[scopes.length - 1]!.openedDepth + 1 : 0;
    if (depth !== contentDepth) continue;
    const symbols = symbolsByNamespace.get(currentNamespace) ?? new Set<string>();
    symbols.add(typeName);
    symbolsByNamespace.set(currentNamespace, symbols);
  }

  return { namespaces: Array.from(namespaces), symbolsByNamespace };
}

async function readCsharpNamespaceIndex(filePath: string): Promise<CsharpNamespaceIndexEntry> {
  const cached = csharpNamespaceFileCache.get(filePath);
  if (cached) return cached;

  const source = await readUtf8WithoutBom(filePath);
  const collected = collectCsharpNamespaceIndex(source);
  const entry = { namespaces: collected.namespaces, symbolsByNamespace: collected.symbolsByNamespace };
  csharpNamespaceFileCache.set(filePath, entry);
  return entry;
}

async function getCsharpProjectNamespaceIndex(indexRoot: string): Promise<LanguageProjectSymbolIndex> {
  return await getOrCreateProjectSymbolIndex(csharpProjectNamespaceIndexCache, indexRoot, async () =>
    buildDeclaredContainerIndex(indexRoot, getImportableLanguageGlobs("csharp"), async (filePath) => {
      const entry = await readCsharpNamespaceIndex(filePath);
      return entry.namespaces.map((name) => {
        const symbols = entry.symbolsByNamespace.get(name);
        return symbols ? { name, symbols } : { name };
      });
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
  const normalized = normalizeCsharpQualifiedName(spec);
  const lookup = normalized.startsWith("global::") ? normalized.slice("global::".length) : normalized;
  if (!lookup) return [];
  const packageCandidates = projectIndex.filesByPackage.get(lookup) ?? [];
  const confined: string[] = [];
  for (const candidate of packageCandidates) {
    const hit = await confineResolvedPath(projectRoot, candidate);
    if (hit) confined.push(hit);
  }
  return confined;
}

function slashPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

async function confineCsharpTypeFiles(projectRoot: string, files: readonly string[]): Promise<string[]> {
  const confined: string[] = [];
  const seen = new Set<string>();
  for (const candidate of files) {
    const hit = await confineResolvedPath(projectRoot, candidate);
    if (!hit) continue;
    const normalized = slashPath(hit);
    const key = fileIdentityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    confined.push(normalized);
  }
  return confined;
}

/**
 * The file that declares `typeName` directly in `namespaceName`.
 * One file binds immediately. Several files bind only when partial-type ownership
 * collapses them to one representative; otherwise the result is `ambiguous` or
 * `partial` and never the first path.
 */
export async function resolveCsharpNamespaceTypePath(
  projectRoot: string,
  namespaceName: string,
  typeName: string,
  fromFile: string,
): Promise<CsharpNamespaceTypeResolution> {
  const normalizedNamespace = normalizeCsharpQualifiedName(namespaceName);
  const namespaceLookup = normalizedNamespace.startsWith("global::")
    ? normalizedNamespace.slice("global::".length)
    : normalizedNamespace;
  const normalizedType = normalizeCsharpIdentifier(typeName);
  if (!namespaceLookup || !normalizedType) return { status: "not_found" };

  const indexRoot = await resolveNearestManifestRoot(projectRoot, fromFile, CSHARP_PACKAGE_MANIFEST_NAMES);
  const projectIndex = await getCsharpProjectNamespaceIndex(indexRoot);
  const files = projectIndex.filesByPackageSymbol.get(namespaceLookup)?.get(normalizedType) ?? [];
  const confined = await confineCsharpTypeFiles(projectRoot, files);
  if (confined.length === 0) return { status: "not_found" };
  if (confined.length === 1) return { status: "found", file: confined[0]! };
  return selectUniqueCsharpNamespaceTypeFile(confined, namespaceLookup, normalizedType);
}

/**
 * `N.Point` (and `@N.@Point`) as a type in namespace `N`, after namespace identity
 * normalization. A single-segment spec is not a dotted type. Navigation, references,
 * and the symbol graph follow the import binding this resolves; the dependency graph
 * calls this helper itself because it re-resolves the specifier text.
 */
export async function resolveCsharpDottedTypeImportPath(
  projectRoot: string,
  spec: string,
  fromFile: string,
): Promise<CsharpNamespaceTypeResolution> {
  const normalized = normalizeCsharpQualifiedName(spec);
  const body = normalized.startsWith("global::") ? normalized.slice("global::".length) : normalized;
  const parts = body.split(".").filter(Boolean);
  if (parts.length < 2) return { status: "not_found" };
  const typeName = parts[parts.length - 1]!;
  const namespaceName = parts.slice(0, -1).join(".");
  return await resolveCsharpNamespaceTypePath(projectRoot, namespaceName, typeName, fromFile);
}

export function clearCsharpResolutionCaches(): void {
  csharpNamespaceFileCache.clear();
  csharpProjectNamespaceIndexCache.clear();
}
