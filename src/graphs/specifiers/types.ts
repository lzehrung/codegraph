import type { SyntaxTreeLike } from "../../languages/types.js";
import type { NativeQueryResults, CompactQueryResults } from "../../native/tree-sitter-native.js";
import type { LogLevel } from "../../logging.js";
import type { BuildReport } from "../../indexer/types.js";

export type CollectModuleSpecifiersOptions = {
  tree?: SyntaxTreeLike;
  nativeQueries?: NativeQueryResults | null;
  compactNativeImports?: CompactQueryResults | null;
  file?: string;
  logLevel?: LogLevel;
  report?: BuildReport;
};
