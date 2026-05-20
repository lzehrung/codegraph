import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { SymbolDef } from "../../indexer/types.js";
import { sliceText } from "../../util/ast.js";
import {
  collectMemberAccessChain,
  memberAccessTraversalTypes,
  memberExpressionTypeFor,
  memberPropertyIdentifierTypes,
} from "../../util/memberAccess.js";
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
  const memberExpressionType = memberExpressionTypeFor(args.sup);
  const propertyIdentifierTypes = memberPropertyIdentifierTypes(args.sup);
  const optionalMemberTypes = memberAccessTraversalTypes(args.sup);

  const resolveMemberChainTarget = (chainNode: SyntaxNodeLike): SymbolDef | null => {
    const chain = collectMemberAccessChain({
      sup: args.sup,
      source: args.source,
      chainNode,
      constStringOf: args.constStringOf,
    });
    if (!chain || !isIdentifierType(args.sup, chain.base.type)) return null;
    const alias = sliceText(chain.base, args.source);
    const targetFile = args.aliasToTargetModule.get(alias);
    if (!targetFile) return null;
    return args.resolveMemberPathFromModule(targetFile, chain.names);
  };

  return {
    memberExpressionType,
    propertyIdentifierTypes,
    optionalMemberTypes,
    resolveMemberChainTarget,
  };
}
