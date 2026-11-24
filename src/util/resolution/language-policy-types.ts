import type { CollectModuleSpecifiersOptions } from "../../graphs/specifiers/types.js";
import type { ImportResolver } from "../../indexer/imports/context.js";
import type { ImportBinding } from "../../indexer/import-types.js";
import type { LanguageSupport } from "../../languages.js";
import type { SyntaxTreeLike } from "../../languages/types.js";
import type { NativeQueryResults } from "../../native/contracts.js";
import type { FileId } from "../../types.js";
import type { WorkspaceConfig } from "../workspace.js";
import type { MatchPathFn } from "./tsconfig.js";
import type { ParsedFileContext } from "../../indexer/parse-context.js";
import type {
  CFamilyIncludeForm,
  ModuleSpecifier,
  ModuleSpecifierExportCondition,
  ModuleSpecifierResolutionKind,
  RubyLoadForm,
} from "../specifiers.js";
import type { collectSqlEdgesForFile } from "../../sql/source-graph.js";
import type { SpecifierTargetMetadata, SpecifierTargets } from "./specifier-target-types.js";

/** Inputs already owned by a file's import-binding extraction. */
export type ImportCollectionContext = {
  file: string;
  projectRoot: string;
  source: string;
  support: LanguageSupport;
  resolve: ImportResolver;
  tree?: SyntaxTreeLike | null;
  nativeQueries?: NativeQueryResults | null;
};

export type ImportSourceRange = { start: number; end: number };

/** Per-file additions to graph specifiers and indexed import bindings. */
export type SpecifierCollectionHooks = Readonly<{
  /** Source additions collected before native import statements. */
  prependSpecifiers?: (
    support: LanguageSupport,
    source: string,
    options: CollectModuleSpecifiersOptions | undefined,
    output: ModuleSpecifier[],
  ) => void;
  statementTypeOnly?: (statement: string) => boolean;
  statementTypeOnlyAt?: (source: string) => (startIndex: number) => boolean;
  /** A true result consumes the statement, including an intentionally empty result. */
  statement?: (
    statement: string,
    source: string,
    file: string | undefined,
    startIndex: number | undefined,
    output: ModuleSpecifier[],
  ) => boolean;
  statementNeedsStartIndex?: true;
  resolutionKind?: ModuleSpecifierResolutionKind;
  exportCondition?: Readonly<{ pattern: RegExp; condition: ModuleSpecifierExportCondition }>;
  includeForm?: (statement: string, rawSpecifier: string | undefined) => CFamilyIncludeForm | undefined;
  loadForm?: (method: string | undefined) => RubyLoadForm | undefined;
  fileEdges?: typeof collectSqlEdgesForFile;
  rawEdgeIdentity?: true;
  importStatementRanges?: (
    source: string,
    collectImportRanges: (source: string, languageId: string) => ImportSourceRange[],
  ) => ImportSourceRange[];
  appendSpecifiers?: (
    support: LanguageSupport,
    source: string,
    options: CollectModuleSpecifiersOptions | undefined,
    output: ModuleSpecifier[],
  ) => void;
  appendBindings?: (context: ImportCollectionContext, output: ImportBinding[]) => void | Promise<void>;
}>;

/** Specifier extraction policy; absent collection keeps generic native-query extraction. */
export type SpecifierExtractionPolicy = Readonly<{
  collect?: SpecifierCollectionHooks;
}>;

/** Inputs of one language import resolution, shared by dispatch and language policies. */
export type ImportSpecifierOptions = {
  matchPath?: MatchPathFn;
  workspaceConfig?: WorkspaceConfig;
  resolveNodeModules?: boolean;
  resolutionHints?: string[];
  phpImportType?: "class" | "function" | "const";
  resolutionKind?: ModuleSpecifierResolutionKind;
  allowScssPartialResolution?: boolean;
  exportCondition?: ModuleSpecifierExportCondition;
  pathAttribute?: string;
  statementStartIndex?: number;
  includeForm?: CFamilyIncludeForm;
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>;
};

export type ResolvedSpecifier = FileId | { external: string };

export type GenericSpecifierResolver = (
  fromFile: string,
  specifier: string,
  projectRoot: string,
  matchPath?: MatchPathFn,
  workspaceConfig?: WorkspaceConfig,
  options?: {
    resolveNodeModules?: boolean;
    resolutionHints?: string[];
    resolutionExtensions?: readonly string[];
    resolutionKind?: ModuleSpecifierResolutionKind;
    allowScssPartialResolution?: boolean;
    exportCondition?: ModuleSpecifierExportCondition;
  },
) => Promise<ResolvedSpecifier>;

/** Existing generic operations injected at the import-resolution boundary. */
export type ImportSpecifierDeps = Readonly<{
  confineLanguageHit: (
    projectRoot: string,
    resolved: string | null,
    specifier: string,
  ) => Promise<ResolvedSpecifier | null>;
  acceptFirstPartyFile: (projectRoot: string, file: string | null | undefined) => Promise<string | null>;
  resolveSpecifier: GenericSpecifierResolver;
}>;

/** Existing target-resolution stages, shared without importing the dispatch module at runtime. */
export type SpecifierTargetDeps = Readonly<{
  resolveSpecifier: GenericSpecifierResolver;
  resolveLanguageImport: (
    file: string,
    specifier: string,
    languageId: string,
    metadata: SpecifierTargetMetadata,
    policy: SpecifierTargetPolicy,
    specifierOverride?: string,
  ) => Promise<ResolvedSpecifier>;
  resolveLanguageImportTargets: (
    file: string,
    specifier: string,
    languageId: string,
    metadata: SpecifierTargetMetadata,
    policy: SpecifierTargetPolicy,
  ) => Promise<SpecifierTargets>;
  resolvePathFallbackTargets: (
    file: string,
    specifier: string,
    policy: SpecifierTargetPolicy,
    metadata: SpecifierTargetMetadata,
  ) => Promise<SpecifierTargets>;
}>;

/** Language-specific import targets; undefined continues the existing generic resolver. */
export type SpecifierTargetPolicy = Readonly<{
  /** Imports naming several files retain the first representative in a binding. */
  representativeBindingTarget?: true;
  /** A declaration lookup whose known or incomplete package misses are authoritative. */
  declarationImport?: Readonly<{
    languageId: "java" | "kotlin";
    lookup: (
      projectRoot: string,
      specifier: string,
      options: { languageId: "java" | "kotlin"; fromFile: string },
    ) => Promise<{ file: string | null; incomplete: boolean; packageKnown: boolean }>;
  }>;
  /** Existing package-wildcard lookup used before the selected import stage. */
  packageImportFiles?: (projectRoot: string, specifier: string, fromFile: string) => Promise<string[]>;
  /** Partial filenames participate in non-document resolution. */
  allowPartialResolution?: true;
  /** A language-owned boundary check for a resolved first-party file. */
  acceptsFile?: (file: string, metadata: SpecifierTargetMetadata) => boolean;
  resolve?:
    | "import"
    | ((
        file: string,
        specifier: string,
        metadata: SpecifierTargetMetadata,
        deps: SpecifierTargetDeps,
        policy: SpecifierTargetPolicy,
      ) => Promise<SpecifierTargets | undefined>);
  resolveImport?: (
    projectRoot: string,
    fromFile: string,
    specifier: string,
    options: ImportSpecifierOptions,
    deps: ImportSpecifierDeps,
  ) => Promise<FileId | { external: string } | undefined>;
}>;
