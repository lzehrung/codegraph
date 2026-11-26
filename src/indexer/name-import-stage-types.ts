/**
 * Types of the named/import stages in `./name-import-stages/`. A type-only leaf, so name policies, member policies
 * and navigation can carry a selected stage without importing the modules that build it.
 */
import type { LanguageSupport } from "../languages.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { FileId } from "../types.js";
import type { ScopeNodeRow } from "./scope-nodes.js";
import type { ScopeIndex } from "./scope-types.js";
import type { GoToResult, ImportBinding, ModuleIndex, ProjectIndex } from "./types.js";

/** The use a named lookup answers: its name node, the file source, and whether the use names a type. */
export type NamedImportCallSite = { node: SyntaxNodeLike; source: string; typeOnly?: boolean };

/**
 * The local-export, explicit-import, compilation-unit and star arbitration for a name used in `file`. Select the stage
 * once from the use support (`namedImportStageFor`, or `NameLookupPolicy.namedImports`) and call it directly. `null`
 * means no binding answers; a `not_found` result is an authoritative miss.
 */
export type NamedImportStage = (
  index: ProjectIndex,
  mod: ModuleIndex,
  file: FileId,
  support: LanguageSupport,
  name: string,
  cNamespace?: "tag" | "ordinary",
  referenceIndex?: number,
  callSite?: NamedImportCallSite,
  scopeIndex?: ScopeIndex,
) => GoToResult | null;

/** One language's facts for its named stage, fixed when the stage is built; an absent field keeps the generic step. */
export type NamedImportRules = Readonly<{
  /**
   * The language's scope row, for a stage that reads its generic-arity operation, runtime module bindings or type-only
   * names. The generic stage reads no scope facts, so a language whose scope row declares one needs its own stage.
   */
  scopeRow?: ScopeNodeRow;
  /** A callable reference whose last named child is the use (Kotlin `::Name`) names a callable, not a type receiver. */
  callableReferenceType?: string;
  /** A type position, classified by the scope row's type-only names, reads only type declarations. */
  typeOnlyUses?: true;
  /** The imports that can bind a name, before arbitration; absent reads every module import. */
  importsForName?: (module: ModuleIndex, normalizedName: string, genericArity?: number) => readonly ImportBinding[];
  /**
   * Exports are split into tag and ordinary names, so the file's own exports never answer by spelling before the
   * namespace-aware export lookup.
   */
  splitExportNamespaces?: true;
  /** Only a name qualified with this separator reads the export lookup; another name resolves through imports. */
  exportLookupSeparator?: string;
  /** The export lookup reads the use position, so directives and namespace regions apply from where they appear. */
  positionedExportLookup?: true;
  /** A declaration the export lookup finds in another file arrived through an include and is reported as imported. */
  crossFileExportsAreImports?: true;
  /** The file whose first export a namespace export names, when it is not the export's own file. */
  namespaceExportFile?: (
    index: ProjectIndex,
    imports: readonly ImportBinding[],
    name: string,
    file: string,
  ) => string | undefined;
  /** Whether a star import that an enclosing namespace shadows may still bring the name in, leaving stars ambiguous. */
  starsMayHoldName?: (index: ProjectIndex, module: ModuleIndex, name: string) => boolean;
}>;
