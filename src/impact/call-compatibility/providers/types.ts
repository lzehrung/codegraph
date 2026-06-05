import type { SyntaxTreeLike } from "../../../languages/types.js";
import type { CallableSignature, CallsiteArguments } from "../types.js";

export interface ExtractSignatureRequest {
  languageId: string;
  source: string;
  symbolStartIndex: number;
  tree?: SyntaxTreeLike;
}

export interface ExtractCallsiteRequest {
  languageId: string;
  source: string;
  calleeStartIndex: number;
  calleeEndIndex?: number;
  tree?: SyntaxTreeLike;
}

export interface CallCompatibilityLimitation {
  languageId: string;
  reason: string;
}

export interface CallCompatibilityProvider {
  languageIds: readonly string[];
  extractSignature(request: ExtractSignatureRequest): CallableSignature | null;
  extractCallsite(request: ExtractCallsiteRequest): CallsiteArguments | null;
  limitations(): readonly CallCompatibilityLimitation[];
}
