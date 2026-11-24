import type { SyntaxNodeLike } from "../languages/types.js";

/** Candidate narrowing for a callable parameter's references outside its declaration file. */
export type ParameterReferenceScanFilter = {
  mayContain(source: string, name: string, callName?: string): boolean;
  includes(node: SyntaxNodeLike): boolean;
  unprobeableNameMarker?: string;
  unproven?(node: SyntaxNodeLike, reason: string | undefined): boolean;
};
