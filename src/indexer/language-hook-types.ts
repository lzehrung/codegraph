import type { LanguageSupport } from "../languages.js";
import type { CallableIdentity } from "../languages/callable-arity.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { NativeQueryResults } from "../native/contracts.js";
import type { FileId, Range } from "../types.js";
import type { PreparedBuildFile } from "./build-workers.js";
import type { DeclarationImportRecheck, DeclarationNameChanges } from "./public-surface.js";
import type { BuildOptions, BuildReport, ImportBinding, ModuleIndex, SymbolDef } from "./types.js";

/** Arguments already used to derive an indexed callable identity. */
export type CallableIdentityArgs = {
  file: string;
  name: string;
  range: Range;
  languageId: string;
  source: string;
  node?: SyntaxNodeLike;
};

/** A language's callable identity addition; absent means the generic identity. */
export type CallableIdentityPolicy = Readonly<{
  forDeclaration?: (args: CallableIdentityArgs) => CallableIdentity | undefined;
}>;

/** File inputs already available while preparing or building a module. */
export type ModuleHookContext = {
  file: FileId;
  support: LanguageSupport;
  source?: string;
  options?: BuildOptions;
  report?: BuildReport;
  prepared?: PreparedBuildFile;
};

/** Optional file preparation and module-fact operations. */
export type ModuleIndexHooks = Readonly<{
  prepare?: (context: ModuleHookContext) => Promise<PreparedBuildFile | undefined>;
  collectFacts?: (context: ModuleHookContext, module: ModuleIndex) => void | Promise<void>;
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
  supplementLocals?: (context: DeclarationHookContext, module: ModuleIndex) => void;
  definitionFacts?: (context: DeclarationHookContext, node: SyntaxNodeLike, definition: SymbolDef) => void;
  completeExports?: (context: DeclarationHookContext, module: ModuleIndex) => void;
}>;

/** Language-specific public-surface and incremental import decisions. */
export type PublicSurfaceHooks = Readonly<{
  normalizeImportName?: (name: string) => string;
  declarationNames?: (module: ModuleIndex, support: LanguageSupport) => readonly string[] | undefined;
  recheck?: (
    binding: ImportBinding,
    support: LanguageSupport,
    changes: DeclarationNameChanges,
  ) => DeclarationImportRecheck | undefined;
}>;

/** Indexing additions; an absent field retains the existing generic path. */
export type IndexLanguagePolicy = Readonly<{
  module?: ModuleIndexHooks;
  declarations?: DeclarationHooks;
  publicSurface?: PublicSurfaceHooks;
}>;
