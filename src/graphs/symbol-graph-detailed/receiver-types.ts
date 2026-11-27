import type { SyntaxNodeLike } from "../../languages/types.js";

export type ReceiverMemberScope = "any" | "instance" | "static";

export type ReceiverBinding =
  | { kind: "own-type"; memberScope: ReceiverMemberScope }
  | { kind: "supertype"; memberScope: ReceiverMemberScope }
  | { kind: "module-import"; receiver: SyntaxNodeLike }
  | { kind: "unknown"; receiver: SyntaxNodeLike }
  | {
      kind: "named-type";
      proof: "constructor" | "declared-type" | "static-type";
      typeName: string;
      /** Syntax proving the type, including imported qualified types. */
      typeNode: SyntaxNodeLike;
      memberScope: ReceiverMemberScope;
    };
