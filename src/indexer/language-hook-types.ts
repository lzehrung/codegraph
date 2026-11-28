import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { NativeQueryResults } from "../native/contracts.js";
import type { ProjectFactsPolicy } from "../util/project-file-facts-types.js";
import type { Edge, FileId } from "../types.js";
import type { PreparedFileContextWithWorkerBloomFilter } from "./build-file-types.js";
import type { PublicSurfaceHooks } from "./public-surface-types.js";
import type { BuildOptions, ExportEntry, ImportBinding, ModuleIndex, SymbolDef } from "./types.js";

/** Optional file preparation and module-fact operations. */
export type ModuleIndexHooks = Readonly<{
  /** Resolve source-module paths with the nearest tsconfig when building or invalidating imports. */
  tsconfigPaths?: true;
  /** Facts needed to resolve declarations across files of this compilation unit. */
  projectFacts?: ProjectFactsPolicy;
  /** Per-file declarations that imports can name independently of a file stem. */
  declaredContainers?: (source: string) => string[];
  /** Whether an occurrence must be re-extracted because its stored edge lacks resolution inputs. */
  specifierNeedsSource?: (edge: Edge) => boolean;
  /**
   * The cached `importers` of the language that an added file of the language joins without a specifier or edge
   * naming it, such as a file a manifest imports into every source it governs. A warm build extracts them again.
   * `importers` is read only when an added file can be such a file.
   */
  implicitImportersOfAddedFiles?: (
    projectRoot: string,
    addedFiles: readonly string[],
    importers: Iterable<string>,
  ) => Promise<string[]>;
  /** Build declarations directly from source, without parser-query imports or a fallback tree. */
  sourceModule?: (file: FileId, source: string) => ModuleIndex;
  /** Complete a prepared file before cross-file declaration lookup starts. */
  prepare?: (
    prepared: PreparedFileContextWithWorkerBloomFilter,
    options: BuildOptions | undefined,
    collectModule: (
      file: string,
      source: string,
      support: LanguageSupport,
      imports: ImportBinding[],
      options: {
        tree: SyntaxTreeLike;
        nativeQueries: NativeQueryResults;
        logLevel?: NonNullable<BuildOptions["logLevel"]>;
      },
    ) => ModuleIndex,
  ) => void;
  /** Complete persisted file facts after module construction. */
  collectFacts?: (
    file: FileId,
    source: string,
    tree: SyntaxTreeLike | undefined,
    support: LanguageSupport,
    nativeQueries: NativeQueryResults | null | undefined,
    module: ModuleIndex,
  ) => void;
}>;

/** The existing local/export extraction inputs for one file. */
export type DeclarationHookContext = {
  file: FileId;
  source: string;
  support: LanguageSupport;
  imports: ImportBinding[];
  tree?: SyntaxTreeLike;
  nativeQueries?: NativeQueryResults | null;
};

/** Capture supplements, declaration facts, and export completion for one language. */
export type DeclarationHooks = Readonly<{
  /** Key and replacement role for duplicate local export declarations. */
  localExportKey?: (entry: Extract<ExportEntry, { type: "local" }>) => string;
  preferredTagRole?: "declaration";
  /** Reconcile declarations sharing one language-level namespace. */
  mergeLocals?: (locals: SymbolDef[]) => SymbolDef[];
  /** Extra complexity keywords beyond the shared set. */
  complexityKeywords?: readonly RegExp[];
  /** Recover a parser-split method name only for a matching declaration candidate. */
  splitMethodName?: (node: SyntaxNodeLike) => SyntaxNodeLike | undefined;
  /** Native captures for a language's explicit module export list. */
  explicitExportList?: {
    targetCapture: string;
    methodCapture: string;
    itemCapture: string;
    declarationCapture: string;
    targetName: string;
    additiveMethods: ReadonlySet<string>;
    privatePrefix: string;
  };
  /** Qualify an extracted export and, when distinct, add a second visible spelling. */
  qualifiedExportName?: (node: SyntaxNodeLike, source: string, name: string) => string;
  alternateExportName?: (node: SyntaxNodeLike, source: string, name: string) => string;
  /** Complete syntax-specific export declarations once the native export query has run. */
  completeUsingExports?: (
    tree: SyntaxTreeLike | null,
    source: string,
    imports: ImportBinding[],
    exports: ExportEntry[],
    support: LanguageSupport,
    matchesBlocker: (node: SyntaxNodeLike, blocker: string) => boolean,
  ) => void;
  /** Extra declaration facts and specialized property-promotion syntax. */
  nominalArity?: (declaration: SyntaxNodeLike) => number;
  tagRole?: (name: SyntaxNodeLike) => SymbolDef["cTag"];
  extensionOwner?: (name: SyntaxNodeLike) => SyntaxNodeLike | null;
  /** Declaration kinds and owner syntax whose membership is stored on indexed definitions. */
  ownerFacts?: {
    ownerTypes: ReadonlySet<string>;
    declarationKinds: ReadonlySet<SymbolDef["kind"]>;
    includeMembers?: true;
    complete?: (node: SyntaxNodeLike, definition: SymbolDef, owner: SyntaxNodeLike | undefined) => void;
  };
  promotedProperties?: {
    parameter: (node: SyntaxNodeLike) => SyntaxNodeLike | null;
    variable: (node: SyntaxNodeLike, source?: string) => SyntaxNodeLike | null;
  };
  supplementLocals?: (context: DeclarationHookContext, module: ModuleIndex) => void;
  definitionFacts?: (context: DeclarationHookContext, node: SyntaxNodeLike, definition: SymbolDef) => void;
  completeExports?: (
    imports: readonly ImportBinding[],
    exports: ExportEntry[],
    explicitNames: ReadonlySet<string>,
    hasExplicitList: boolean,
  ) => void;
}>;

/** Indexing additions; an absent field retains the existing generic path. */
export type IndexLanguagePolicy = Readonly<{
  module?: ModuleIndexHooks;
  declarations?: DeclarationHooks;
  publicSurface?: PublicSurfaceHooks;
}>;
