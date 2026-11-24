import { typescriptCollapsedOverloadTarget, typescriptSplitMethodName } from "../ts-callables.js";
import type { GraphHooks } from "./types.js";

export const typescriptGraphHooks: GraphHooks = {
  collapseLocalAliases: typescriptCollapsedOverloadTarget,
  singleSuperclass: {
    declarationType: "class_declaration",
    heritageType: "class_heritage",
    clauseType: "extends_clause",
  },
  declarationShapes: {
    splitMethodName: typescriptSplitMethodName,
    objectTypeAlias: { declarationType: "type_alias_declaration", valueType: "object_type" },
  },
};
