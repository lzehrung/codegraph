export {
  applyEdits,
} from "./applyEdits.js";
export {
  extractFunction,
  type ExtractOptions,
} from "./extract.js";
export {
  moveSymbol,
  type MoveOptions,
} from "./move.js";
export {
  renameSymbol,
} from "./rename.js";
export {
  getSymbolRange,
} from "@lzehrung/codegraph";

export type {
  ApplyEditsOptions,
  ApplyEditsResult,
  RefactorResult,
  SymbolRangeOptions,
  TextEdit,
  TriviaMode,
} from "./types.js";
