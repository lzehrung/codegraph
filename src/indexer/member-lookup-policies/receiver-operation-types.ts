import type { SyntaxNodeLike } from "../../languages/types.js";

export type PhpObjectCreationKeyword = {
  keyword: "self" | "static" | "parent";
  nameNode: SyntaxNodeLike;
  classNode: SyntaxNodeLike | null;
};
export type CppOutOfLineMemberDeclaration = { node: SyntaxNodeLike; nameNode: SyntaxNodeLike };
