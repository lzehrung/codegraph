import type { LanguageSupport } from "../../languages.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { SymbolDef } from "../../indexer/types.js";
import { sliceText } from "../../util/ast.js";
import {
  collectMemberAccessChain,
  memberAccessTraversalTypes,
  memberExpressionTypeFor,
  memberPropertyIdentifierTypes,
} from "../../util/member-access.js";
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
  /** The key the alias map is stored under; a use-site spelling must go through it. */
  aliasKey: (name: string) => string;
  resolveMemberPathFromModule: (startFile: string, names: string[]) => SymbolDef | null;
  resolveNamespaceAlias?: (alias: string, useNode: SyntaxNodeLike) => string | undefined;
  /**
   * The module a chain's leading names spell through the alias, longest spelling first (Python `a.b.c.x` after an
   * `import a.b.c`): its file and how many names it consumed.
   */
  resolveNamespacePhrase?: (
    alias: string,
    names: readonly string[],
    useNode: SyntaxNodeLike,
  ) => { file: string; consumed: number } | undefined;
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
    // Chain names run from the last access back to the first; a spelled module is read from the first.
    const phrase = args.resolveNamespacePhrase
      ? args.resolveNamespacePhrase(alias, [...chain.names].reverse(), chain.base)
      : undefined;
    if (phrase) {
      const rest = chain.names.slice(0, chain.names.length - phrase.consumed);
      return rest.length ? args.resolveMemberPathFromModule(phrase.file, rest) : null;
    }
    const targetFile = args.resolveNamespaceAlias
      ? args.resolveNamespaceAlias(alias, chain.base)
      : args.aliasToTargetModule.get(args.aliasKey(alias));
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
