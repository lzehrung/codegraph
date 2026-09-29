/**
 * Types for the shared bare-name lookup (`./name-resolution.ts`) and its per-language policies
 * (`./name-lookup-policies/`). A leaf module, so policies can name these types without a cycle.
 */
import type { SyntaxNodeLike } from "../languages/types.js";
import type { FileId } from "../types.js";
import type { ParsedFileContext } from "./parse-context.js";
import type { Binding, ScopeIndex } from "./scope.js";
import type { GoToResult, ModuleIndex, ProjectIndex, SymbolDef } from "./types.js";

/** Synchronous access to parsed files. A miss is recorded so an async caller can load and retry. */
export type ParsedFileProvider = {
  get(file: FileId): ParsedFileContext | null;
};

/** A provider that parses on demand between synchronous resolution passes. */
export type LoadingParsedFileProvider = ParsedFileProvider & {
  /** Files requested since the last call, which were not loaded. */
  takeMisses(): FileId[];
  load(files: readonly FileId[]): Promise<void>;
};

/** A lookup step that needs async member resolution before its answer is known. */
export type DeferredNameRequest =
  /** Inside an out-of-line C++ member body, a member of the owner hides a file-scope name. */
  | { kind: "cpp-out-of-line-member" }
  /** A member of the enclosing type, found through `this`/`self`. */
  | { kind: "implicit-self-member"; lookupName: string }
  /** Several included C/C++ declarations that may be one callable. */
  | { kind: "c-included-star"; lookupName: string; cNamespace: "tag" | "ordinary" | undefined };

export type NameResolution =
  | GoToResult
  | {
      status: "deferred";
      request: DeferredNameRequest;
      /** The answer when the deferred lookup finds nothing; `null` means no answer. */
      fallback: NameResolution | null;
      /** The answer when the lookup proves a hiding member that is not a valid target. */
      hidden?: GoToResult;
    };

export type BareNameUse = {
  index: ProjectIndex;
  mod: ModuleIndex;
  file: FileId;
  parsed: ParsedFileContext;
  scopeIndex: ScopeIndex;
  files: ParsedFileProvider;
  node: SyntaxNodeLike;
  name: string;
  /** PHP import role at the use, when the caller knows it. */
  phpImportType?: "class" | "function" | "const";
};

/** What a lookup step knows about the use once the closest scope binding is found. */
export type NameLookupState = {
  use: BareNameUse;
  /** The name as scope and import tables spell it (C# drops alias qualifiers). */
  lookupName: string;
  closestBinding: Binding | null;
};

/**
 * One language's additions to the shared lookup order. Each hook returns a resolution to stop
 * the lookup, or `undefined` to continue; the skeleton in {@link resolveBareName} fixes the
 * order in which hooks run. A language without special rules has an empty policy.
 */
export type NameLookupPolicy = {
  lookupName?(use: BareNameUse): string;
  /** Before scope lookup: qualified names, role namespaces, unparsed macro input. */
  beforeLexical?(use: BareNameUse, lookupName: string): NameResolution | null | undefined;
  /**
   * Whether the closest scope binding is in a different namespace than the use and must be
   * ignored (a Java variable cannot be called as a method).
   */
  ignoresBinding?(use: BareNameUse, binding: Binding): boolean;
  /** From the closest binding before anything else (a C++ `using` declaration). */
  fromClosestBinding?(state: NameLookupState): NameResolution | null | undefined;
  /** Wraps the rest of the lookup, for a deferred step whose fallback is that rest. */
  wrapRest?(state: NameLookupState, rest: () => NameResolution | null): NameResolution | null;
  /** Before the closest binding's definition is taken (C++ same-scope overload collisions). */
  beforeLocal?(state: NameLookupState): NameResolution | null | undefined;
  /** Adjusts a lexical hit (member precedence, role checks). */
  onLocal?(state: NameLookupState, local: SymbolDef): NameResolution | null | undefined;
  /** No lexical hit, before the shared later-local check. */
  onUnboundLocal?(state: NameLookupState): NameResolution | null | undefined;
  /** No lexical hit, before cross-module lookup (visible C++ callables, `using namespace`). */
  beforeCrossModule?(state: NameLookupState): NameResolution | null | undefined;
  /** Name for cross-module lookup (C# alias-qualified). */
  crossModuleName?(state: NameLookupState): string;
  /** C ordinary versus tag namespace. */
  cNamespace?(node: SyntaxNodeLike): "tag" | "ordinary" | undefined;
  /** Adjusts the cross-module result (arity, roles, member precedence, deferred recovery). */
  afterCrossModule?(state: NameLookupState, resolved: GoToResult | null): NameResolution | null | undefined;
  /** Files a synchronous consumer loads before resolving names in a module of this language. */
  preloadFiles?(index: ProjectIndex, mod: ModuleIndex): Iterable<FileId>;
};
