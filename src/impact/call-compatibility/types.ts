import type { CallableBinding } from "../../languages/callable-arity.js";
import type { SyntaxTreeLike } from "../../languages/types.js";

export interface CallableSignature {
  minArgs: number;
  maxArgs: number | null;
  confidence: "high";
}

export interface ExtractCallableSignatureRequest {
  languageId: string;
  source: string;
  symbolStartIndex: number;
  tree?: SyntaxTreeLike;
  /**
   * Call form to measure: `"bound"` (default) drops the receiver parameter, `"unbound"` counts it
   * as an explicit argument. See `languages/callable-arity.ts`.
   */
  binding?: CallableBinding;
}

export interface CallsiteArguments {
  argCount: number;
  confidence: "high";
}

export interface ExtractCallsiteArgumentsRequest {
  languageId: string;
  source: string;
  calleeStartIndex: number;
  calleeEndIndex?: number;
  tree?: SyntaxTreeLike;
}
