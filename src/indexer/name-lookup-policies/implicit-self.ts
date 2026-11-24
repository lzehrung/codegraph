/**
 * Swift, C#, Java, and Kotlin additions to the shared name lookup order: inside a type, a member
 * reached through the implicit `self`/`this` (including an inherited one) is settled by the
 * member lookup, which applies static scope and overload selection, and it takes precedence over
 * a same-named module-level name or import.
 */
import {
  AMBIGUOUS_STAR_IMPORT_REASON,
  CSHARP_NAMESPACE_NAME_REASON,
  UNPROVEN_CSHARP_MEMBER_DESIGNATOR_REASON,
  UNPROVEN_JAVA_ANNOTATION_ELEMENT_REASON,
  UNRESOLVED_QUALIFIED_TYPE_REASON,
} from "../ambiguous-resolution.js";
import {
  declaresMembers,
  nearestMemberContainer,
  nodeInStaticMemberContext,
} from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { MEMBER_ACCESS_ROWS } from "../../util/member-access-tables.js";
import { csharpUnparsedName, isCsharpDiscardName } from "../../util/csharp-bindings.js";
import {
  csharpDesignatorReceiver,
  csharpDesignatorType,
  csharpNamedArgumentCall,
  isCsharpMemberDesignator,
} from "../../util/csharp-designators.js";
import {
  isJavaAnnotationElementName,
  isJavaSwitchLabelName,
  javaAnnotationTypeForElement,
} from "../../util/java-designators.js";
import { csharpTypeArgumentArity } from "../../util/csharp-tree.js";
import { csharpNamespaceMemberKind } from "../compilation-units.js";
import { MEMBER_LOOKUP_POLICIES } from "../member-lookup-policies/index.js";
import {
  csharpAliasAt,
  csharpAliasQualifiedLookupName,
  csharpAliasUnprovenReason,
  csharpBindingWithinOwner,
  csharpChainQualifier,
  csharpOuterMemberResolution,
  csharpTypeRootName,
  resolveCsharpNameRoot,
  csharpNamespaceFallbackReason,
  implicitSelfCallee,
  isCsharpAliasQualifier,
  isDirectKeywordMemberDeclaration,
  peekCsharpOuterMember,
} from "../navigation-goto.js";
import {
  CSHARP_GENERIC_OWNER_REASON,
  csharpLookupName,
  csharpQualifiedThroughGenericOwner,
  definitionForBinding,
  findDeclarationNameNode,
} from "../navigation-local.js";
import { csharpQualifiedNameNode, findClosestScopeBinding } from "../scope-lookup.js";
import { enclosingReceiverScopes } from "../kotlin-lambda-receiver.js";
import { csharpUsingStaticFiles, withCsharpUsingStatic } from "./csharp-using-static.js";
import { csharpHeaderParameterUse } from "./csharp-header-parameters.js";
import { javaPatternVariableFallback, javaRecordComponentUse } from "./java-record-components.js";
import { javaSwitchCase } from "./java-switch-cases.js";
import { okGoToResult } from "../navigation-provenance.js";
import { resolveCsharpQualifiedName, resolveImported } from "../navigation-resolve.js";
import {
  definitionWithoutDeferredSteps,
  type BareNameUse,
  type NameLookupPolicy,
  type NameLookupState,
  type NameResolution,
} from "../name-resolution-types.js";
import { SymbolKind, type GoToResult, type SymbolDef } from "../types.js";
import {
  isSwiftExtensionTypeName,
  isSwiftQualifiedExtensionSuffix,
  isSwiftQualifiedTypeSuffix,
  swiftQualifiedTypeSegments,
  isSwiftShorthandCase,
} from "../../util/swift-tree.js";
import { fileBindingIsUnshadowed } from "../scope.js";
import type { Binding } from "../scope-types.js";
import { csharpTypeOnlyName } from "../scope-nodes.js";
import { swiftFreeCallableLookup } from "./swift-callable.js";

const implicitSelf = (state: NameLookupState, fallback: NameResolution | null): NameResolution => ({
  status: "deferred",
  request: { kind: "implicit-self-member", lookupName: state.lookupName },
  fallback,
});

const lexical = (state: NameLookupState, local: SymbolDef): GoToResult =>
  okGoToResult(state.use.index, local, { resolution: "exact", confidence: "high" });

/** The closest binding is declared in the file's top scope (module-level function or type). */
const bindsAtFileScope = ({ use, closestBinding }: NameLookupState): boolean =>
  !!closestBinding && use.scopeIndex.allScopes[0]?.map.get(closestBinding.canonicalName) === closestBinding;

/**
 * The closest binding is a method declared directly in a type body. Overloads bound this way are
 * not grouped by the scope lookup, so the member lookup chooses among them; a function declared
 * inside a method body is not a member and keeps its lexical binding.
 */
function bindsTypeMethod({ closestBinding }: NameLookupState): boolean {
  const declaration = closestBinding?.kind === "function" ? closestBinding.node?.parent : undefined;
  const container = declaration ? nearestMemberContainer(declaration) : null;
  return !!declaration && !!container && isDirectKeywordMemberDeclaration(declaration, container);
}

/** An overload name at its declaration resolves to itself, not a later same-scope declaration. */
function ownOverloadDeclaration({ use, closestBinding }: NameLookupState): GoToResult | undefined {
  const { node, file, parsed } = use;
  for (let binding = closestBinding; binding; binding = binding.earlierSameScope ?? null) {
    if (binding.node?.startIndex !== node.startIndex || binding.node.endIndex !== node.endIndex) continue;
    const own = definitionForBinding(binding, file, node, parsed.sup, parsed.source, parsed.tree);
    return own ? okGoToResult(use.index, own, { resolution: "exact", confidence: "high" }) : undefined;
  }
  return undefined;
}

/** The use is the callee of a receiverless call (`f()`). */
const namesCallee = (use: BareNameUse): boolean =>
  implicitSelfCallee(
    MEMBER_LOOKUP_POLICIES[use.parsed.sup.id]?.receiverResolution?.implicit?.call,
    use.node.parent ?? use.node,
  )?.id === use.node.id;
const isImplicitSelfCall = ({ use }: NameLookupState): boolean => namesCallee(use);

/** A Kotlin callable reference can name either a member function or a property. */
const namesKotlinMemberReference = (use: BareNameUse): boolean =>
  use.node.parent?.type === "callable_reference" && use.node.parent.namedChildren.at(-1)?.id === use.node.id;

/** Whether the same scope declared a variable, field, or property before this function binding. */
function hasEarlierValueBinding(binding: Binding): boolean {
  for (let earlier = binding.earlierSameScope; earlier; earlier = earlier.earlierSameScope) {
    if (earlier.kind === "local" || earlier.kind === "param") return true;
  }
  return false;
}

/** A nominal type is not a member of its own declaration or extension. */
function namesEnclosingSwiftType(state: NameLookupState, def: SymbolDef): boolean {
  if (!declaresMembers(def)) return false;
  const owner = nearestMemberContainer(state.use.node);
  return sliceText(owner?.childForFieldName("name"), state.use.parsed.source) === state.lookupName;
}

/**
 * A keyword or other token in a declaration header is not a use of the declared name. Resolving it as that name
 * reaches member selection and can prefer a same-named property (`var count` for the `func` of `count(of:)`).
 * The header token names its own declaration.
 */
function swiftHeaderNamesOwnDeclaration(use: BareNameUse): NameResolution | undefined {
  if (use.parsed.sup.nodeTypes.identifier?.includes(use.node.type)) return undefined;
  const nameNode = findDeclarationNameNode(use.parsed.sup, use.node);
  if (!nameNode) return undefined;
  const own = use.mod.locals.find(
    (local) =>
      !local.swiftExtensionOwner &&
      local.range.start.index === nameNode.startIndex &&
      local.range.end.index === nameNode.endIndex,
  );
  if (!own) return { status: "not_found", reason: "A keyword token is not a name" };
  return okGoToResult(use.index, own, { resolution: "exact", confidence: "high" });
}

/** An extension header names a type: a function or variable of that spelling is in another namespace. */
function extensionOwnerTypeOnly(resolved: GoToResult | null): GoToResult | null {
  if (resolved?.status !== "ok" || declaresMembers(resolved.definition)) return resolved;
  return { status: "not_found", reason: "A Swift extension names a type, not a function or variable" };
}

export const swiftLookupPolicy: NameLookupPolicy = {
  beforeLexical(use, _lookupName, resolveName) {
    const { node, parsed } = use;
    if (isSwiftQualifiedTypeSuffix(node)) {
      const unproven: NameResolution = { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
      const segments = swiftQualifiedTypeSegments(node);
      if (!segments) return unproven;
      const root = segments[0]!;
      let rootResult = resolveName({ ...use, node: root, name: sliceText(root, parsed.source) });
      while (rootResult?.status === "deferred") rootResult = rootResult.fallback;
      const owner = rootResult?.status === "ok" ? rootResult.definition : null;
      if (!owner || !declaresMembers(owner)) return unproven;
      const names = segments.slice(1).map((segment) => sliceText(segment, parsed.source));
      return { status: "deferred", request: { kind: "swift-nested-type", owner, names }, fallback: unproven };
    }
    // A later segment of a dotted owner (`Inner` in `extension Outer.Inner`) is a member of the segment before it.
    // No Swift nested-type lookup proves it, and a bare lookup of its own spelling would match any other `Inner`.
    if (isSwiftQualifiedExtensionSuffix(use.node)) {
      return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
    }
    return swiftHeaderNamesOwnDeclaration(use);
  },
  fromClosestBinding: ownOverloadDeclaration,
  wrapRest(state, rest) {
    const resolution = swiftFreeCallableLookup(state, rest(), bindsTypeMethod(state));
    if (!isSwiftShorthandCase(state.use.node)) return resolution;
    // A leading-dot name needs its contextual type; a bare lookup alone proves only a static member.
    return {
      status: "deferred",
      request: { kind: "swift-enum-case", staticFallback: resolution },
      fallback: { status: "not_found", reason: "Swift enum case type is unproven" },
    };
  },
  // Swift checks every bare name through `self`; method-local bindings still win.
  onLocal(state, local) {
    // An extension header sits outside the extension's members, so its name never reaches one through `self`.
    if (isSwiftExtensionTypeName(state.use.node)) return undefined;
    if (namesEnclosingSwiftType(state, local) || (!bindsAtFileScope(state) && !bindsTypeMethod(state)))
      return undefined;
    return implicitSelf(state, lexical(state, local));
  },
  afterCrossModule(state, resolved: GoToResult | null) {
    if (isSwiftExtensionTypeName(state.use.node)) return extensionOwnerTypeOnly(resolved);
    if (resolved?.status === "ok" && namesEnclosingSwiftType(state, resolved.definition)) return resolved;
    // A member reached only by name, not through `self`, is not a module-level target.
    const memberOnly = resolved?.status === "ok" && !!resolved.definition.isMember;
    return implicitSelf(
      state,
      memberOnly ? { status: "not_found", reason: "No matching Swift member definition" } : resolved,
    );
  },
};

/**
 * A qualified C# type name (`P.Mix`) the directory-scoped lookup missed, resolved through the
 * file's `using P;` across every directory that declares `P`.
 */
function csharpQualifiedThroughUsing({ use, lookupName }: NameLookupState): GoToResult | null {
  const qualifiedName = csharpAliasQualifiedLookupName(use.node, use.parsed.source, lookupName, use.mod.imports);
  if (!qualifiedName.includes(".")) return null;
  const hit = resolveCsharpQualifiedName(
    use.index,
    use.mod,
    qualifiedName,
    use.node.startIndex,
    csharpTypeArgumentArity(use.node),
  );
  return hit?.kind === "resolved"
    ? okGoToResult(use.index, hit.def, { resolution: "import", confidence: "high" })
    : null;
}

/**
 * Enclosing members precede an alias: only nested types participate in type positions, and `X::` bypasses both.
 */
function namesAliasRequiringMemberLookup({ use, closestBinding }: NameLookupState): boolean {
  if (!closestBinding?.import || isCsharpAliasQualifier(use.node, MEMBER_ACCESS_ROWS[use.parsed.sup.id])) return false;
  return !!csharpAliasAt(use.index, use.mod, use.name, use.node);
}

/**
 * A type or dotted-name root that the other parts or the project base classes of an enclosing type can bind before any
 * namespace member or import does. A binding declared inside the innermost type already beats them.
 */
function namesOuterOwnerRoot({ use, closestBinding }: NameLookupState): boolean {
  if (csharpBindingWithinOwner(closestBinding, use.node)) return false;
  return csharpTypeRootName(use.node);
}

/**
 * Enclosing members precede aliases and imports, including nested types of another partial part or a base class.
 */
function enclosingMemberPrecedence(state: NameLookupState, rest: () => NameResolution | null): NameResolution | null {
  const { use } = state;
  const deferToMemberLookup = (): NameResolution => ({
    status: "deferred",
    request: { kind: "csharp-alias-member", lookupName: use.name },
    fallback: rest(),
  });
  if (namesAliasRequiringMemberLookup(state)) return deferToMemberLookup();
  if (!namesOuterOwnerRoot(state)) return rest();
  const peeked = peekCsharpOuterMember(use.index, use.file, use.node, use.name);
  if (!peeked) return deferToMemberLookup();
  return csharpOuterMemberResolution(use.index, peeked) ?? rest();
}

/**
 * A simple or generic type name written as an attribute (`[Marker]`, `[Marker()]`, `[Gen<int>]`): C# looks it up as
 * `Marker` and as `MarkerAttribute`. A verbatim name (`[@Marker]`) skips the suffix; a qualified name is not modeled.
 */
function namesAttributeType(use: BareNameUse): boolean {
  if (use.attributeSuffixTried || use.node.text.startsWith("@")) return false;
  let name = use.node;
  if (name.parent?.type === "generic_name" && name.parent.namedChildren[0]?.id === name.id) name = name.parent;
  const attribute = name.parent;
  return attribute?.type === "attribute" && attribute.childForFieldName("name")?.id === name.id;
}

/** The declared type of a simple value used as the receiver of a pattern or `with` expression. */
function csharpDesignatorReceiverType(use: BareNameUse): SyntaxNodeLike | null {
  const receiver = csharpDesignatorReceiver(use.node);
  if (!receiver) return null;
  const binding = findClosestScopeBinding(use.scopeIndex, receiver.text, receiver, use.parsed.sup);
  if (!binding?.node || (binding.kind !== "local" && binding.kind !== "param")) return null;
  const declarator = binding.node.parent?.type === "variable_declarator" ? binding.node.parent : null;
  const declaration = declarator?.parent ?? binding.node.parent;
  const type = declaration?.childForFieldName("type");
  if (type && type.type !== "implicit_type") return type;
  const creation = declarator?.namedChildren.find((child) => child.type === "object_creation_expression");
  return creation?.childForFieldName("type") ?? null;
}

export const csharpLookupPolicy: NameLookupPolicy = {
  lookupName: (use) => csharpLookupName(use.node, use.parsed.source, use.name),
  beforeLexical(use) {
    if (use.name === "_" && isCsharpDiscardName(use.node)) {
      return { status: "not_found", reason: "C# discard is not a binding" };
    }
    if (
      use.mod.parseErrorRanges?.length &&
      !(use.parsed.sup.isDeclarationName(use.node) && use.node.parent?.type !== "ERROR") &&
      !csharpTypeOnlyName(use.node) &&
      csharpUnparsedName(use.node, use.mod.parseErrorRanges)
    ) {
      const binding = findClosestScopeBinding(use.scopeIndex, use.name, use.node, use.parsed.sup);
      if (csharpUnparsedName(use.node, use.mod.parseErrorRanges, binding?.node)) {
        return { status: "not_found", reason: "C# name occurs in unparsed syntax" };
      }
    }
    if (!isCsharpMemberDesignator(use.node)) return undefined;
    const fallback = { status: "not_found", reason: UNPROVEN_CSHARP_MEMBER_DESIGNATOR_REASON } as const;
    const call = csharpNamedArgumentCall(use.node);
    if (call) return { status: "deferred", request: { kind: "csharp-named-argument", call }, fallback };
    const owner = csharpDesignatorType(use.node) ?? csharpDesignatorReceiverType(use);
    if (!owner) return fallback;
    return {
      status: "deferred",
      request: {
        kind: "contextual-member",
        owner,
        expectedKind: SymbolKind.Variable,
        jvmTypeOnly: false,
      },
      fallback,
    };
  },
  fromClosestBinding: (state) => ownOverloadDeclaration(state) ?? csharpHeaderParameterUse(state),
  crossModuleName: ({ use, lookupName }) =>
    csharpAliasQualifiedLookupName(use.node, use.parsed.source, lookupName, use.mod.imports),
  // A qualified name whose type or alias root could not be resolved must not become a namespace path.
  beforeCrossModule({ use }) {
    const chainNode = csharpQualifiedNameNode(use.node);
    if (!chainNode) {
      // Only an attribute lookup names something other than the node's own spelling (`Marker` read as `MarkerAttribute`).
      const attributeName = use.attributeSuffixTried ? use.name : undefined;
      const root = resolveCsharpNameRoot(use.index, use.mod, use.node, use.parsed.source, use.files, attributeName);
      if (root.kind === "namespace") {
        return { status: "not_found", reason: CSHARP_NAMESPACE_NAME_REASON };
      }
      if (root.kind === "resolved")
        return okGoToResult(use.index, root.definition, { resolution: "import", confidence: "high" });
      if (root.kind === "ambiguous") return { status: "not_found", reason: AMBIGUOUS_STAR_IMPORT_REASON };
      if (root.kind === "unavailable") return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
      return undefined;
    }
    if (csharpQualifiedThroughGenericOwner(chainNode)) {
      return { status: "not_found", reason: CSHARP_GENERIC_OWNER_REASON };
    }
    const lead = csharpChainQualifier(chainNode, use.parsed.source);
    if (!lead) return undefined;
    const { index, mod, parsed } = use;
    const aliasReason = csharpAliasUnprovenReason(index, mod, lead.qualifier, parsed.source);
    if (aliasReason) return { status: "not_found", reason: aliasReason };
    // A member an enclosing type receives from another part or a base class binds the root first, and its own nested
    // lookup is not modeled: no namespace or import may answer in its place.
    const qualifierName = sliceText(lead.qualifier, parsed.source);
    const boundByOwner =
      csharpTypeRootName(lead.qualifier) &&
      !csharpAliasAt(index, mod, qualifierName, lead.qualifier) &&
      peekCsharpOuterMember(index, use.file, lead.qualifier, qualifierName)?.status === "member";
    if (boundByOwner) return { status: "not_found", reason: UNRESOLVED_QUALIFIED_TYPE_REASON };
    const reason = csharpNamespaceFallbackReason(index, mod, lead.qualifier, parsed.source, use.files);
    if (reason) return { status: "not_found", reason };
    const root = resolveCsharpNameRoot(index, mod, lead.qualifier, parsed.source, use.files);
    if (root.kind !== "namespace") return undefined;
    const suffix = lead.names.toReversed().join(".");
    const qualified = `${root.name}.${suffix}`;
    const hit = resolveCsharpQualifiedName(
      index,
      mod,
      `global::${qualified}`,
      use.node.startIndex,
      csharpTypeArgumentArity(use.node),
    );
    if (hit?.kind === "resolved") return okGoToResult(index, hit.def, { resolution: "import", confidence: "high" });
    const namespace = csharpNamespaceMemberKind(index, mod, "", qualified) === "namespace";
    return { status: "not_found", reason: namespace ? CSHARP_NAMESPACE_NAME_REASON : UNRESOLVED_QUALIFIED_TYPE_REASON };
  },
  shadowsModuleAlias: (use) => !!csharpAliasUnprovenReason(use.index, use.mod, use.node, use.parsed.source),
  moduleAliasIsUnshadowed({ use, closestBinding }) {
    if (!csharpAliasAt(use.index, use.mod, use.name, use.node)) return true;
    return fileBindingIsUnshadowed(use.scopeIndex, closestBinding);
  },
  wrapRest(state, rest) {
    const resolved = enclosingMemberPrecedence(state, rest);
    if (!namesAttributeType(state.use)) return resolved;
    return { status: "deferred", request: { kind: "csharp-attribute-suffix" }, fallback: resolved };
  },
  onUnboundLocal({ use, lookupName, closestBinding }) {
    if (!closestBinding?.import || !csharpTypeOnlyName(use.node, true)) return undefined;
    const alias = csharpAliasAt(use.index, use.mod, lookupName, use.node);
    if (alias?.kind !== "named") return undefined;
    const reason = csharpAliasUnprovenReason(use.index, use.mod, use.node, use.parsed.source);
    if (reason) return { status: "not_found", reason };
    const target = resolveImported(use.index, alias, alias.imported);
    if (!target || "namespace" in target) {
      return { status: "not_found", reason: "C# alias does not name an indexed type" };
    }
    return okGoToResult(use.index, target, {
      via: { importedFrom: target.file, exportedName: alias.imported },
      resolution: "import",
      confidence: "high",
    });
  },
  // A static member function reaches only static members of its type.
  onLocal(state, local) {
    if (!bindsTypeMethod(state) || !isImplicitSelfCall(state)) return undefined;
    const staticContext = nodeInStaticMemberContext(state.use.node, state.use.parsed.source);
    return implicitSelf(
      state,
      staticContext
        ? { status: "not_found", reason: "No matching C# static member definition" }
        : lexical(state, local),
    );
  },
  // Partial members declared in another file reach this path only as invocation callees.
  // Without a member, `using static` members join the namespace-level answer.
  afterCrossModule: (state, resolved) =>
    implicitSelf(
      state,
      withCsharpUsingStatic(state.use, state.lookupName, resolved ?? csharpQualifiedThroughUsing(state)),
    ),
  preloadFiles: (_index, mod) => csharpUsingStaticFiles(mod),
};

/**
 * Java and Kotlin: a type method bound lexically still needs static-scope and overload checks,
 * and an inherited member beats a same-file top-level (Kotlin) function, a same-package
 * declaration, or an import.
 */
export const jvmLookupPolicy: NameLookupPolicy = {
  fromClosestBinding: ownOverloadDeclaration,
  onLocal(state, local) {
    if (state.closestBinding?.kind !== "function" || !isImplicitSelfCall(state)) return undefined;
    if (!bindsAtFileScope(state) && !bindsTypeMethod(state)) return undefined;
    return implicitSelf(state, lexical(state, local));
  },
  afterCrossModule: (state, resolved) => implicitSelf(state, resolved),
};

/** Java: a record component binds in its record's scope, except where a pattern variable or annotation element may own the name. */
export const javaLookupPolicy: NameLookupPolicy = {
  ...jvmLookupPolicy,
  // Java methods and variables occupy separate namespaces, including at an unqualified call.
  ignoresBinding(use, binding) {
    if (namesCallee(use)) return binding.kind !== "function";
    if (binding.kind !== "function" || use.parsed.sup.isDeclarationName(use.node)) return false;
    if (use.node.parent?.type === "method_reference") return false;
    return hasEarlierValueBinding(binding);
  },
  beforeLexical(use) {
    if (!isJavaAnnotationElementName(use.node)) return undefined;
    const fallback = { status: "not_found", reason: UNPROVEN_JAVA_ANNOTATION_ELEMENT_REASON } as const;
    const owner = javaAnnotationTypeForElement(use.node);
    if (!owner) return fallback;
    return {
      status: "deferred",
      request: { kind: "contextual-member", owner, expectedKind: SymbolKind.Function, jvmTypeOnly: true },
      fallback,
    };
  },
  fromClosestBinding: (state) =>
    isJavaSwitchLabelName(state.use.node)
      ? undefined
      : (ownOverloadDeclaration(state) ?? javaPatternVariableFallback(state) ?? javaRecordComponentUse(state)),
  wrapRest: (state, rest) => {
    const result = javaSwitchCase(state, rest);
    return result === undefined ? rest() : result;
  },
};

/** A scope whose names a lambda's implicit receiver outranks: a type body or the file itself. */
const RECEIVER_OUTRANKED_SCOPE_TYPES: Readonly<Record<string, true>> = {
  class_body: true,
  enum_class_body: true,
  source_file: true,
};

/**
 * The closest binding is declared where a lambda's implicit receiver outranks it: a member of a named, anonymous, or
 * local type, a file-level function, an import, or no declaration at all. A local function or parameter binds before
 * every receiver.
 */
function bindsBelowLambdaReceivers({ closestBinding }: NameLookupState): boolean {
  if (!closestBinding || closestBinding.import) return true;
  let declaration = closestBinding.node?.parent;
  if (closestBinding.kind === "local" && declaration?.type === "variable_declaration") {
    declaration = declaration.parent ?? undefined;
  } else if (closestBinding.kind !== "function") {
    return false;
  }
  const scope = declaration?.parent;
  return !!scope && !!RECEIVER_OUTRANKED_SCOPE_TYPES[scope.type];
}

/**
 * Kotlin: a lambda between a bare call and its enclosing type may carry an implicit receiver, whose members bind
 * before the enclosing type's, an inherited member, a same-file function, or an import.
 */
export const kotlinLookupPolicy: NameLookupPolicy = {
  ...jvmLookupPolicy,
  // A Kotlin local holding a function is callable; callable references are not plain value reads.
  ignoresBinding(use, binding) {
    if (namesCallee(use)) return false;
    if (binding.kind !== "function" || use.parsed.sup.isDeclarationName(use.node)) return false;
    if (namesKotlinMemberReference(use) || use.node.parent?.type === "method_reference") return false;
    return hasEarlierValueBinding(binding);
  },
  onLocal(state, local) {
    if (namesCallee(state.use) || namesKotlinMemberReference(state.use)) {
      const declaration = state.closestBinding?.node?.parent;
      const container = declaration ? nearestMemberContainer(declaration) : null;
      if (declaration && container && isDirectKeywordMemberDeclaration(declaration, container))
        return implicitSelf(state, lexical(state, local));
    }
    if (state.closestBinding?.kind !== "function" || !isImplicitSelfCall(state)) return undefined;
    if (!bindsAtFileScope(state) && !bindsTypeMethod(state)) return undefined;
    return implicitSelf(state, lexical(state, local));
  },
  wrapRest(state, rest) {
    if (!isImplicitSelfCall(state) || !bindsBelowLambdaReceivers(state)) return rest();
    const receivers = enclosingReceiverScopes(state.use.node);
    if (!receivers.length) return rest();
    const resolution = rest();
    // A class or alias name is a constructor call, which no receiver's member can be.
    const named = definitionWithoutDeferredSteps(resolution);
    if (named && declaresMembers(named)) return resolution;
    return {
      status: "deferred",
      request: { kind: "kotlin-lambda-receiver-member", lookupName: state.lookupName, receivers },
      fallback: resolution,
    };
  },
};
