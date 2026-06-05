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
