import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { SymbolDef } from "../../indexer/types.js";
import { sliceText, unquote } from "../../util.js";
import { isIdentifierType } from "./ast.js";

export type MemberChainResolver = {
  memberExpressionType: string;
  propertyIdentifierTypes: string[];
  optionalMemberTypes: Set<string>;
  resolveMemberChainTarget: (chainNode: SyntaxNodeLike) => SymbolDef | null;
};

export function createMemberChainResolver(args: {
  sup: LanguageSupport;
  source: string;
  constStringOf: Map<string, string>;
  aliasToTargetModule: Map<string, string>;
  resolveMemberPathFromModule: (startFile: string, names: string[]) => SymbolDef | null;
}): MemberChainResolver {
  const memberExpressionType = args.sup.nodeTypes.memberExpression ?? "member_expression";
  const propertyIdentifierTypes: string[] = args.sup.nodeTypes.propertyIdentifier ?? ["property_identifier"];
  const optionalMemberTypes = new Set<string>([
    memberExpressionType,
    "optional_member_expression",
    "subscript_expression",
    "optional_chain",
    args.sup.id === "python" ? "attribute" : "",
  ]);

  const resolveMemberChainTarget = (chainNode: SyntaxNodeLike): SymbolDef | null => {
    const names: string[] = [];
    let current: SyntaxNodeLike | null = chainNode;
    let base: SyntaxNodeLike | null = null;
    const pushProp = (propNode: SyntaxNodeLike | null): void => {
      if (!propNode) return;
      if (propertyIdentifierTypes.includes(propNode.type)) {
        names.push(sliceText(propNode, args.source));
      } else if (propNode.type === "string") {
        names.push(unquote(sliceText(propNode, args.source)));
      } else if (propNode.type === "identifier") {
        const keyName = sliceText(propNode, args.source);
        const value = args.constStringOf.get(keyName);
        if (typeof value === "string") names.push(value);
      }
    };

    while (current && optionalMemberTypes.has(current.type)) {
      if (current.type === "subscript_expression") {
        base = current.child(0) ?? base;
        const indexNode = current.child(2);
        pushProp(indexNode);
        current = base;
      } else if (
        current.type === memberExpressionType ||
        current.type === "optional_member_expression" ||
        current.type === "attribute"
      ) {
        base = current.child(0) ?? base;
        const propNode =
          current.childForFieldName?.("property") ?? current.child(2) ?? current.childForFieldName?.("attribute");
        pushProp(propNode);
        current = base;
      } else if (current.type === "optional_chain") {
        current = current.child(0);
      } else {
        break;
      }
    }
    if (!current || !isIdentifierType(args.sup, current.type)) return null;
    const alias = sliceText(current, args.source);
    const targetFile = args.aliasToTargetModule.get(alias);
    if (!targetFile || !names.length) return null;
    return args.resolveMemberPathFromModule(targetFile, names);
  };

  return {
    memberExpressionType,
    propertyIdentifierTypes,
    optionalMemberTypes,
    resolveMemberChainTarget,
  };
}
