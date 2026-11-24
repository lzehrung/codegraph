import type { LanguageExtensionMap } from "../../languages.js";
import type { WorkspaceConfig } from "../workspace.js";
import type { BuildReport } from "../../indexer/types.js";
import type { ParsedFileContext } from "../../indexer/parse-context.js";
import type { MatchPathFn } from "./tsconfig.js";
import type {
  CFamilyIncludeForm,
  ModuleSpecifierExportCondition,
  ModuleSpecifierResolutionKind,
  RubyLoadForm,
} from "../specifiers.js";

export type SpecifierTargetMetadata = {
  projectRoot: string;
  matchPath?: MatchPathFn;
  workspaceConfig?: WorkspaceConfig;
  resolveNodeModules?: boolean;
  resolutionHints?: string[];
  phpImportType?: "class" | "function" | "const";
  resolutionKind?: ModuleSpecifierResolutionKind;
  exportCondition?: ModuleSpecifierExportCondition;
  pathAttribute?: string;
  statementStartIndex?: number;
  includeForm?: CFamilyIncludeForm;
  rubyLoadForm?: RubyLoadForm;
  languageExtensions?: LanguageExtensionMap;
  parsedFiles?: ReadonlyMap<string, ParsedFileContext>;
  report?: BuildReport;
  /** Distinguishes `import p.C.*` from `import p.C` when both a package and a class exist. */
  jvmPackageWildcard?: true;
  /** Rust tries this spelling before `specifier` when it differs, without `pathAttribute`. */
  rawSpecifier?: string;
  resolutionExtensions?: readonly string[];
};

export type SpecifierTargets = {
  /** Every first-party file this specifier names. Empty when external. */
  files: string[];
  /** Name for an external edge or binding. Unused when `files` is non-empty. */
  externalName: string;
  /** True only when the JVM wildcard matched a package rather than a type. */
  jvmPackageMatched?: true;
  /**
   * C# ambiguous and partial type matches keep an external edge.
   * Other unresolved specifiers still honor `dropIfUnresolved`.
   */
  retainExternalEdge?: boolean;
};
