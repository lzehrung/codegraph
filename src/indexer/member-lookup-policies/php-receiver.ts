import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { foldPhpIdentifierCase } from "../../util/identifiers.js";
import type { PhpObjectCreationKeyword } from "./receiver-operation-types.js";
import type { ReceiverSyntaxDeps, ReceiverSyntaxRules } from "./types.js";

const KEYWORDS: Readonly<Record<string, "self" | "static" | "parent">> = {
  self: "self",
  static: "static",
  parent: "parent",
};

function keywordConstruction(
  node: SyntaxNodeLike,
  source: string,
  sup: LanguageSupport,
  deps: ReceiverSyntaxDeps,
): PhpObjectCreationKeyword | null {
  let creation: SyntaxNodeLike | null = node;
  while (creation && creation.type !== "object_creation_expression") {
    if (
      creation.type === "method_declaration" ||
      creation.type === "function_definition" ||
      creation.type === "class_declaration"
    )
      return null;
    creation = creation.parent;
  }
  if (!creation) return null;
  const nameNode = deps.constructorNameNode(creation, sup);
  if (!nameNode) return null;
  const onName = node === creation || (node.startIndex >= nameNode.startIndex && node.endIndex <= nameNode.endIndex);
  if (!onName) return null;
  const keyword = KEYWORDS[foldPhpIdentifierCase(sliceText(nameNode, source))];
  if (!keyword) return null;
  const container = deps.nearestMemberContainer(creation);
  const classNode = container?.type === "class_declaration" ? container : null;
  return { keyword, nameNode, classNode };
}

export const phpReceiverSyntax: ReceiverSyntaxRules = { keywordConstruction };
