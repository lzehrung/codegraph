import type { SwiftCallableParameter } from "../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../languages/types.js";
import type { Range } from "../types.js";
import type { ExportEntry, SymbolDef } from "./types.js";

/** Facts already supplied when deriving an indexed callable identity. */
export type CallableIdentityArgs = {
  file: string;
  name: string;
  range: Range;
  languageId: string;
  source: string;
  node?: SyntaxNodeLike;
};

/** Declarative key composition and file-level callable completion. */
export type CallableIdentityPolicy = Readonly<{
  /** Complete file-local callable identities after all declarations have been collected. */
  completeLocals?: (file: string, locals: readonly SymbolDef[]) => void;
  /** Canonicalize export entries for one callable identity. */
  completeExports?: (entries: ExportEntry[]) => ExportEntry[];
  /** Key components used to group declarations; absent uses the source range. */
  keyShape?: "file-name" | "qualified-signature" | "file-owner-name";
  /** Additional declaration parameter facts, when the language records them. */
  declarationParameters?: (declaration: SyntaxNodeLike) => SwiftCallableParameter[] | null;
}>;
