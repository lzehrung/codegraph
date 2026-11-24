import type { LanguageSupport } from "../languages.js";
import type { ProjectFileFacts } from "../util/project-file-facts-types.js";
import type { NativeBloomFilterPayload } from "../worker/native-bloom-types.js";
import type { ModuleRecord, ModuleRecordFallback } from "./module-record-types.js";
import type { PreparedFileContext, PreparedFileParseAttempt } from "./parse-context.js";
import type { PhpModuleImportNames } from "./php-module-facts-types.js";
import type { ModuleIndex } from "./types.js";

export type PreparedFileContextWithWorkerBloomFilter = PreparedFileContext & {
  workerBloomFilter?: NativeBloomFilterPayload;
  projectFacts?: ProjectFileFacts;
  /** A whole-tree fallback needed before facts can be primed; the module builder reuses its outcome. */
  projectFactsParse?: PreparedFileParseAttempt;
  /** PHP locals/exports extracted before imports resolve; the module builder finishes this same module. */
  phpModule?: ModuleIndex;
  /** Names computed during early project preparation, shared with the resolver reader. */
  phpModuleImportNames?: PhpModuleImportNames | null;
  moduleRecord?: undefined;
  /** Why a worker that was asked for the file's module record returned the extraction instead. */
  moduleRecordFallback?: ModuleRecordFallback;
};

/** A file a worker indexed into a module record: the main thread finishes the record with `finishModuleRecord`. */
export type PreparedModuleRecordFile = {
  file: string;
  sup: LanguageSupport;
  moduleRecord: ModuleRecord;
  workerBloomFilter?: NativeBloomFilterPayload;
};

export type PreparedBuildFile = PreparedFileContextWithWorkerBloomFilter | PreparedModuleRecordFile;
