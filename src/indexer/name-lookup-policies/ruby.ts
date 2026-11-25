/**
 * Ruby additions to the shared name lookup order. Every class and module of a file shares the file scope, so scope
 * alone would bind a bare name to a method of an unrelated type, and a local that the scope index does not model would
 * bind to a method of its name. The policy keeps a method to the types that can call it and a local to its own scope.
 */
import { supportForFileWithoutHeaderSample } from "../../languages.js";
import { fileIdentityKey } from "../../util/paths.js";
import {
  rubyDeclaresLocalVariable,
  rubyBareCallMisses,
  rubyBareCallReaches,
  rubyIsClassBodyCall,
  rubyIsBlockTypeMethod,
  rubyIsMethodDeclarationName,
  rubyLambdaParameterShadows,
  rubyMayBuildTypesWithBlocks,
  rubyMethodIsOwnedAt,
  rubyMethodIsPendingAt,
  rubyMethodVisibleAt,
  rubyNamesLocalVariable,
  rubyMethodNameLiteral,
  rubyMethodNameOwner,
  rubyMethodNameIsStatic,
  rubyMethodNameIsAliasDestination,
  rubyMethodNameRefersTo,
  rubyReadsLocalAsOperand,
  rubySelfLevelEvidencePaths,
  rubySetterDeclarationOf,
} from "../../util/ruby-tree.js";
import {
  UNPROVEN_RUBY_CLASS_BODY_METHOD_REASON,
  UNPROVEN_RUBY_LAMBDA_PARAMETER_REASON,
  UNPROVEN_RUBY_SELF_METHOD_REASON,
} from "../ambiguous-resolution.js";
import { definitionForBinding } from "../navigation-local.js";
import { okGoToResult } from "../navigation-provenance.js";
import { localExportsNamed } from "../reference-query-index.js";
import { scopeIdentifierKey, scopeNodesFor } from "../scope-nodes.js";
import { SymbolKind, type GoToResult, type SymbolDef } from "../types.js";
import type { BareNameUse, NameLookupPolicy, NameLookupState, NameResolution } from "../name-resolution-types.js";
import type { Binding } from "../scope-types.js";
import type { SyntaxNodeLike } from "../../languages/types.js";

const UNMODELED_LOCAL_REASON = "A Ruby local variable that the scope index does not bind";

/** The definition of the use's file declared at exactly `declaration`'s range. */
function definitionAt(use: BareNameUse, declaration: SyntaxNodeLike): GoToResult | undefined {
  const fileKey = fileIdentityKey(use.file);
  const def = use.mod.locals.find(
    (local) =>
      fileIdentityKey(local.file) === fileKey &&
      local.range.start.index === declaration.startIndex &&
      local.range.end.index === declaration.endIndex,
  );
  return def ? okGoToResult(use.index, def, { resolution: "exact", confidence: "high" }) : undefined;
}

/**
 * A `def`'s own name token names that definition, never a later redefinition of the name or a later `attr_*` that
 * replaces it, and the token of `def name=(value)` names that writer, never a reader `def name`. Ruby calls the later
 * definition, but the earlier one is still declared by its own token.
 */
function declarationNamesItself({ use, closestBinding }: NameLookupState): GoToResult | undefined {
  const { node } = use;
  const setter = rubySetterDeclarationOf(node);
  if (setter) return definitionAt(use, setter);
  const replaced = closestBinding?.earlierSameScope;
  if (!replaced) return undefined;
  if (!closestBinding.generatedOwner && !rubyIsMethodDeclarationName(node)) return undefined;
  for (let binding: Binding | undefined = replaced; binding; binding = binding.earlierSameScope) {
    if (binding.generatedOwner) continue;
    if (binding.node?.startIndex !== node.startIndex || binding.node.endIndex !== node.endIndex) continue;
    return definitionAt(use, node);
  }
  return undefined;
}

/**
 * A name the syntax binds as a local variable (a multiple assignment, a pattern, a rescue variable, a lambda parameter)
 * is that local, never a method of the same spelling. The scope index models only some of these, and a local it holds
 * is answered by the shared lookup.
 */
function unmodeledLocal({ use, closestBinding }: NameLookupState): NameResolution | undefined {
  if (closestBinding?.kind === "local" || closestBinding?.kind === "param") {
    if (rubyLambdaParameterShadows(use.node)) {
      return { status: "not_found", reason: UNPROVEN_RUBY_LAMBDA_PARAMETER_REASON };
    }
    return undefined;
  }
  if (!rubyNamesLocalVariable(use.node)) return undefined;
  return { status: "not_found", reason: UNMODELED_LOCAL_REASON };
}

/**
 * Whether another indexed Ruby file opens the class around the use, or a superclass or mixin its file declares for it
 * (`rubySelfLevelEvidencePaths`), and so may hand the class its own methods or answer any call for it.
 */
function levelsSharedElsewhere(use: BareNameUse): boolean {
  const fileKey = fileIdentityKey(use.file);
  const languageId = use.parsed.sup.id;
  for (const path of rubySelfLevelEvidencePaths(use.node) ?? []) {
    for (const { module } of localExportsNamed(use.index, path)) {
      if (fileIdentityKey(module.file) === fileKey) continue;
      if (supportForFileWithoutHeaderSample(module.file, use.index.languageExtensions)?.id === languageId) return true;
    }
  }
  return false;
}

/**
 * A method that the type around the use declares itself names it, before a method of a base, a mixin, or an includer
 * that the file declares later: the scope lookup would take the later declaration. The method must also be one the
 * `self` at the use has: a class body calls the class's methods, a `class << self` body those of the singleton class,
 * and a method body those of what the method is defined on, unless another file may share the levels.
 */
function ownTypeMethod({ use, closestBinding }: NameLookupState): NameResolution | undefined {
  if (closestBinding?.kind !== "function" || !closestBinding.node) return undefined;
  const pending = rubyMethodIsPendingAt(closestBinding.node, use.node);
  const classBodyCall = rubyIsClassBodyCall(use.node);
  let sharedElsewhere: boolean | undefined;
  const selfHas = (declaration: SyntaxNodeLike): boolean => {
    if (classBodyCall) return rubyBareCallReaches(declaration, use.node);
    if (!rubyBareCallMisses(declaration, use.node)) return true;
    sharedElsewhere ??= levelsSharedElsewhere(use);
    return sharedElsewhere;
  };
  const closestIsOwned = rubyMethodIsOwnedAt(closestBinding.node, use.node);
  const namespaceFits = !closestIsOwned || selfHas(closestBinding.node);
  if (closestIsOwned && !pending && namespaceFits) return undefined;
  const sup = use.parsed.sup;
  for (let binding = closestBinding.earlierSameScope; binding; binding = binding.earlierSameScope) {
    const declaration = binding.node;
    if (binding.kind !== "function" || !declaration || !rubyMethodIsOwnedAt(declaration, use.node)) continue;
    if (rubyMethodIsPendingAt(declaration, use.node)) continue;
    if (!selfHas(declaration)) continue;
    if (binding.generatedOwner && !sup.generatedMemberVisibleAt?.(binding.generatedOwner, use.node)) continue;
    const own = definitionForBinding(binding, use.file, use.node, sup, use.parsed.source, use.parsed.tree);
    return own ? okGoToResult(use.index, own, { resolution: "exact", confidence: "high" }) : undefined;
  }
  if (!closestIsOwned) return undefined;
  if (classBodyCall && (!namespaceFits || pending)) {
    return { status: "not_found", reason: UNPROVEN_RUBY_CLASS_BODY_METHOD_REASON };
  }
  return namespaceFits ? undefined : { status: "not_found", reason: UNPROVEN_RUBY_SELF_METHOD_REASON };
}

/** Whether a generated method (`attr_reader :name`) of this file is what the cross-module lookup found. */
function foundGeneratedMember(use: BareNameUse, lookupName: string, definition: SymbolDef): boolean {
  if (!use.scopeIndex.hasGeneratedMembers) return false;
  const sup = use.parsed.sup;
  const key = scopeIdentifierKey(scopeNodesFor(sup.id), lookupName, use.node, sup.normalizeIdentifier);
  return !!use.scopeIndex.bindings
    .get(key)
    ?.some((binding) => binding.generatedOwner && binding.def?.start.index === definition.range.start.index);
}

/**
 * A method of a type that a block builds (`Base = Struct.new(:a) { def run }`) binds in that block's scope, which no use
 * outside the block reaches, so a use in a type connected to it finds no binding. That type's method is the answer.
 */
function blockTypeMethod(use: BareNameUse, lookupName: string): GoToResult | undefined {
  if (!rubyMayBuildTypesWithBlocks(use.parsed.tree.rootNode)) return undefined;
  let found: SymbolDef | undefined;
  for (const local of use.mod.locals) {
    if (local.kind !== SymbolKind.Function || local.localName !== lookupName) continue;
    if (fileIdentityKey(local.file) !== fileIdentityKey(use.file)) continue;
    const start = local.range.start.index;
    const end = local.range.end.index;
    if (start === undefined || end === undefined) continue;
    const declaration = use.parsed.tree.rootNode.descendantForIndex(start, end);
    if (rubyIsBlockTypeMethod(declaration) && rubyMethodVisibleAt(declaration, use.node)) found = local;
  }
  return found ? okGoToResult(use.index, found, { resolution: "exact", confidence: "high" }) : undefined;
}

/** Literal method-naming statements have a method namespace, never the local scope's values. */
function methodNameReference(use: BareNameUse): NameResolution | undefined {
  if (!rubyMethodNameLiteral(use.node)) return undefined;
  const unproven: NameResolution = { status: "not_found", reason: "Unproven Ruby method-name argument" };
  const naming = rubyMethodNameOwner(use.node);
  if (!naming) return unproven;
  if (rubyMethodNameIsAliasDestination(use.node)) return unproven;
  const sup = use.parsed.sup;
  const method = naming.childForFieldName("method")?.text;
  const attributeDeclaration = method === "attr_reader" || method === "attr_writer" || method === "attr_accessor";
  // A generated attribute declaration names itself, including a writer spelled without its `=`.
  const own = attributeDeclaration
    ? use.mod.locals.find(
        (local) =>
          local.kind === SymbolKind.Function &&
          local.range.start.index === use.node.startIndex &&
          local.range.end.index === use.node.endIndex,
      )
    : undefined;
  if (own) return okGoToResult(use.index, own, { resolution: "exact", confidence: "high" });
  if (!rubyMethodNameIsStatic(use.node)) {
    // Preserve lexical alias operands in ordinary blocks whose nominal owner is not modeled.
    if (naming.type === "alias" && use.node.type === "identifier") return undefined;
    return unproven;
  }
  let spelling = use.name;
  if (use.node.type === "simple_symbol") spelling = spelling.slice(1);
  if (method === "attr_writer") spelling += "=";
  const name = sup.normalizeIdentifier(spelling);
  const definesMethod = method === "attr_reader" || method === "attr_writer" || method === "define_method";
  let target: SymbolDef | undefined;
  for (const local of use.mod.locals) {
    if (local.kind !== SymbolKind.Function || sup.normalizeIdentifier(local.localName) !== name) continue;
    const start = local.range.start.index;
    const end = local.range.end.index;
    if (start === undefined || end === undefined) continue;
    if (!definesMethod && start > use.node.startIndex) continue;
    const declaration = use.parsed.tree.rootNode.descendantForIndex(start, end);
    if (!rubyMethodNameRefersTo(declaration, use.node)) continue;
    // Reader/writer pairs share one indexed range; do not invent a single-method reference to that token.
    const macro = declaration.parent?.parent;
    if (macro?.type === "call" && macro.childForFieldName("method")?.text === "attr_accessor") return unproven;
    target = local;
  }
  return target ? okGoToResult(use.index, target, { resolution: "exact", confidence: "high" }) : unproven;
}
export const rubyLookupPolicy: NameLookupPolicy = {
  beforeLexical: methodNameReference,
  fromClosestBinding(state) {
    return declarationNamesItself(state) ?? unmodeledLocal(state) ?? ownTypeMethod(state);
  },
  onUnboundLocal({ use, lookupName }) {
    return blockTypeMethod(use, lookupName);
  },
  /**
   * The same-file fallback below the scope lookup binds a name by its spelling alone, so it must not answer where the
   * scope lookup refused: a generated or declared method of a type that cannot call it, or a local variable, which only
   * the scope it is bound in can name.
   */
  afterCrossModule({ use, lookupName }, resolved) {
    if (resolved?.status !== "ok") return undefined;
    const { definition } = resolved;
    if (fileIdentityKey(definition.file) !== fileIdentityKey(use.file)) return undefined;
    if (foundGeneratedMember(use, lookupName, definition)) return null;
    const start = definition.range.start.index;
    const end = definition.range.end.index;
    if (start === undefined || end === undefined) return undefined;
    const declaration = use.parsed.tree.rootNode.descendantForIndex(start, end);
    if (definition.kind === SymbolKind.Variable) {
      if (!rubyDeclaresLocalVariable(declaration)) return undefined;
      // `c0&mask` is a read of the local `c0` that the parser took for a call, so the local is the answer.
      return rubyReadsLocalAsOperand(use.node, declaration) ? undefined : null;
    }
    if (definition.kind === SymbolKind.Function && !rubyMethodVisibleAt(declaration, use.node)) return null;
    return undefined;
  },
};
