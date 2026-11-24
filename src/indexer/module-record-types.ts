import type { LanguageSupport } from "../languages.js";
import type { LogLevel } from "../logging.js";
import type { NativeQueryResults } from "../native/contracts.js";
import type { ProjectedSyntaxTree } from "../native/projected-tree.js";
import type { Range } from "../types.js";
import type { ModuleSpecifier } from "../util/specifiers.js";
import type { ImportResolverOptions } from "./imports/context.js";
import type { ModuleIndex, SymbolDef } from "./types.js";

/** One distinct import resolution a module record defers, as the extraction asked for it. */
export type ImportResolutionRequest = {
  from: string;
  phpImportType?: "class" | "function" | "const";
  options?: ImportResolverOptions;
};

/**
 * A JavaScript or TypeScript module indexed up to import resolution. In `module`, each import binding's `resolved`
 * holds the `PendingImportTarget` of its request, and re-exports keep the specifier they were written with.
 * `requests` lists the distinct requests in the order the extraction first asked for them, and `specifiers` are the
 * module specifiers the file's dependency edges resolve.
 */
export type ModuleRecord = {
  module: ModuleIndex;
  requests: ImportResolutionRequest[];
  specifiers: ModuleSpecifier[];
};

/**
 * Why a file is indexed the way it was before module records. Each depends only on the file's content: no syntax tree
 * or native results, an import extraction that degraded, a write to the build report, a rule that reads a resolved
 * import target (the CommonJS `module.exports = { ...required }` spread), or an error.
 */
export type ModuleRecordFallback = "noTree" | "degradedImport" | "reportWrite" | "resolutionDependent" | "error";

export type ModuleRecordOutcome = { record: ModuleRecord } | { fallback: ModuleRecordFallback };

/** What a native extraction worker needs, besides the file and its parse, to build the file's module record. */
export type ModuleRecordTask = {
  projectRoot: string;
  dynamicImportHeuristics: boolean;
  logLevel?: LogLevel;
};

export type ModuleRecordInput = ModuleRecordTask & {
  file: string;
  source: string;
  support: LanguageSupport;
  nativeQueries: NativeQueryResults | null;
  tree: ProjectedSyntaxTree | undefined;
};

/**
 * A module record as a worker posts it. Each symbol definition's file and the file prefix of its callable key are
 * left out when they are the module's file, and every range is packed into `data`; `decodeModuleRecord` restores the
 * record exactly, including which objects are shared.
 *
 * `data` holds, in order: a header (definition count, range count, distinct range count, pending binding count), one
 * flag word per definition of `defs`, the distinct range of each range in visit order, six words per distinct range
 * (start line, column, index; end line, column, index; an absent index is -1), and a binding index and request for
 * each binding whose target is pending.
 */
export type ModuleRecordPayload = {
  module: ModuleIndex;
  /** Each symbol definition of the module once: its locals, then export targets that are not locals. */
  defs: SymbolDef[];
  /** Stands in for every range packed into `data`. */
  packedRange: Range;
  data: Int32Array;
  requests: ImportResolutionRequest[];
  specifiers: ModuleSpecifier[];
};
