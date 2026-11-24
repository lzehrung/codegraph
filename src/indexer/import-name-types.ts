import type { FileId } from "../types.js";
import type { ExportEntry, ImportBinding, ModuleIndex, ProjectIndex, ResolvedExport, SymbolDef } from "./types.js";

export type ImportNameResolutionOptions = Readonly<{
  preferredKind?: SymbolDef["kind"];
  allowLocalFallback?: boolean;
  cNamespace?: "tag" | "ordinary";
  referenceIndex?: number;
  csharpGenericArity?: number;
  argumentCount?: number;
  isCallableUse?: boolean;
  typeOnly?: boolean;
}>;

export type ImportNameResult = SymbolDef | { namespace: FileId } | null;
export type ReopenedImportParts = { parts: SymbolDef[]; incomplete: boolean };
export type ImportStarCandidate = { imp: Extract<ImportBinding, { kind: "star" }>; def: SymbolDef };

/** Exact views of the existing export/import operations; never a second resolver. */
export type ImportNameDeps = Readonly<{
  resolveExport: (
    index: ProjectIndex,
    file: FileId,
    name: string,
    options?: ImportNameResolutionOptions,
  ) => ResolvedExport | null;
  csharpShadowedImports: (index: ProjectIndex) => WeakSet<ImportBinding>;
  resolveCsharpNamespaceImport: (
    index: ProjectIndex,
    binding: ImportBinding,
    file: string,
    name: string,
    options: ImportNameResolutionOptions | undefined,
  ) => ImportNameResult;
  resolvePhpExportByImportType: (
    index: ProjectIndex,
    file: FileId,
    name: string,
    role: "class" | "function" | "const",
  ) => ResolvedExport | null;
  directModuleValueEntry: (module: ModuleIndex) => Extract<ExportEntry, { type: "local" }> | undefined;
  sameResolvedExport: (index: ProjectIndex, left: ResolvedExport, right: ResolvedExport) => boolean;
}>;

export type StarImportDeps = Readonly<{
  localExportsNamed: (
    index: ProjectIndex,
    name: string,
  ) => Iterable<{ module: ModuleIndex; entry: Extract<ExportEntry, { type: "local" }> }>;
}>;

export type StarExpansionRules = Readonly<{
  localFallback?: "exports-only";
  excludeMembers?: true;
  namespaceKinds?: Readonly<Partial<Record<SymbolDef["kind"], true>>>;
  classifierKinds?: Readonly<Partial<Record<SymbolDef["kind"], true>>>;
  normalizeTypeName?: (name: string) => string;
}>;

export type StarImportRules = Readonly<{
  localFallback?: "exports-only";
  excludeMembers?: true;
  sameIdentity?: (index: ProjectIndex, left: SymbolDef, right: SymbolDef) => boolean;
  representative?: (index: ProjectIndex, group: readonly SymbolDef[], useFile: string) => SymbolDef | undefined;
  blocksCandidates?: (
    index: ProjectIndex,
    candidates: readonly ImportStarCandidate[],
    isCallableUse: boolean,
    useFile: string | undefined,
  ) => boolean;
  reopenedParts?: (index: ProjectIndex, definition: SymbolDef, deps: StarImportDeps) => ReopenedImportParts;
}>;

/** Language-owned import and export stages, selected once for the module or outer lookup. */
export type ImportNameRules = Readonly<{
  aliasKey?: (name: string) => string;
  resolveTarget?: (
    index: ProjectIndex,
    binding: ImportBinding,
    targetFile: string,
    exportedName: string,
    options: ImportNameResolutionOptions | undefined,
    namespace: ImportNameResolutionOptions["cNamespace"],
    deps: ImportNameDeps,
  ) => ImportNameResult | undefined;
  resolveMissingTarget?: (
    index: ProjectIndex,
    binding: ImportBinding,
    targetFile: string,
    lookupName: string,
    deps: ImportNameDeps,
  ) => ImportNameResult;
  submoduleMechanism?: "python";
  resolveSubmodule?: (file: string, name: string) => string | undefined;
  namespaceLookup?: Readonly<{
    separator: string;
    globalPrefix: string;
    normalizeQualifier: (name: string) => string;
    qualifiedUnitOptions: { csharpQualifiedName: boolean };
    coalesce: (index: ProjectIndex, candidates: SymbolDef[]) => SymbolDef[];
  }>;
  includedAmbiguity?: "continue";
  selectOverload?: (candidates: readonly SymbolDef[], argumentCount: number) => SymbolDef | null;
  exportStars?: "last-wins";
  starExpansion?: StarExpansionRules;
  star?: StarImportRules;
}>;
