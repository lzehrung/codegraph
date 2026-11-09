import type { SyntaxNodeLike } from "../languages/types.js";
import { normalizeKotlinIdentifier } from "../util/identifiers.js";
import { fileIdentityKey } from "../util/paths.js";
import {
  definitionForBinding,
  findClosestScopeBinding,
  getOrBuildScopeIndex,
  resolveNamedDefinition,
} from "./navigation-local.js";
import type { ParsedFileContext } from "./parse-context.js";
import {
  assertQuerySourceForIndex,
  cachedParsedContextForIndexSync,
  ensureParsedContextForIndex,
  rethrowStaleQuerySource,
} from "./parsed-cache.js";
import { bindsTypeParameter } from "./type-parameters.js";
import { type ModuleIndex, type ProjectIndex, type SymbolDef, SymbolKind } from "./types.js";

/** Nodes that carry the modifiers of a declaration. */
const DECLARATION_NODE_TYPES: Readonly<Record<string, true>> = {
  type_alias: true,
  class_parameter: true,
  function_declaration: true,
  property_declaration: true,
  class_declaration: true,
  object_declaration: true,
  enum_entry: true,
};

/** The declaration a definition names, with its parsed file; null when that file cannot be read. */
export async function declarationNodeOf(
  index: ProjectIndex,
  def: SymbolDef,
): Promise<{ node: SyntaxNodeLike; parsed: ParsedFileContext } | null> {
  const start = def.range.start.index;
  if (start === undefined) return null;
  try {
    assertQuerySourceForIndex(index, def.file);
    const parsed =
      cachedParsedContextForIndexSync(index, def.file) ?? (await ensureParsedContextForIndex(index, def.file));
    let node: SyntaxNodeLike | null = parsed.tree.rootNode.descendantForIndex(start, start);
    for (; node; node = node.parent) {
      if (DECLARATION_NODE_TYPES[node.type]) return { node, parsed };
    }
  } catch (error) {
    rethrowStaleQuerySource(error);
  }
  return null;
}

/** The nominal spelling inside nullability and parentheses, without inferring its expression type. */
export function unindexedType(node: SyntaxNodeLike): { name: SyntaxNodeLike; nullable: boolean } {
  let type = node;
  let nullable = false;
  while (type.type === "nullable_type" || type.type === "parenthesized_type") {
    nullable = nullable || type.type === "nullable_type";
    const inner = type.namedChildren.find((child) => child.type !== "type_modifiers");
    if (!inner) break;
    type = inner;
  }
  const identifiers = type.namedChildren.filter((child) => child.type === "identifier");
  return { name: identifiers.length === 1 ? identifiers[0]! : type, nullable };
}

/** Whether the call naming `use` supplies its final argument outside the parentheses. */
export function kotlinHasTrailingLambda(use: SyntaxNodeLike): boolean {
  let call = use;
  while (call.parent) {
    const parent = call.parent;
    const callCallee = parent.type === "call_expression" && parent.namedChildren[0]?.id === call.id;
    const memberName = parent.type === "navigation_expression" && parent.namedChildren.at(-1)?.id === call.id;
    if (!callCallee && !memberName) break;
    call = parent;
  }
  return call.type === "call_expression" && call.namedChildren.some((child) => child.type === "annotated_lambda");
}

const NON_LAMBDA_BUILTINS: Readonly<Record<string, true>> = {
  Boolean: true,
  Byte: true,
  Short: true,
  Int: true,
  Long: true,
  Float: true,
  Double: true,
  Char: true,
  String: true,
  Number: true,
  CharSequence: true,
  Unit: true,
  Nothing: true,
};

/** Reject only a final parameter proven not to accept a lambda; aliases and unread external types stay candidates. */
async function acceptsLambdaType(
  index: ProjectIndex,
  mod: ModuleIndex,
  parsed: ParsedFileContext,
  node: SyntaxNodeLike,
  depth: number,
): Promise<boolean> {
  let type = node;
  while (type.type === "nullable_type" || type.type === "parenthesized_type") {
    const inner = type.namedChildren.find((child) => child.type !== "type_modifiers");
    if (!inner) return true;
    type = inner;
  }
  if (type.type === "function_type") return true;
  if (type.type !== "user_type") return true;
  const { name } = unindexedType(type);
  if (bindsTypeParameter(name.text, name, parsed.source, parsed.sup)) return true;
  const scopeIndex = getOrBuildScopeIndex(index, mod.file, parsed.source, parsed.sup, mod, parsed.tree);
  const binding = findClosestScopeBinding(scopeIndex, name.text, name, parsed.sup, true);
  const local = binding ? definitionForBinding(binding, mod.file, name, parsed.sup, parsed.source, parsed.tree) : null;
  const resolved = local
    ? null
    : resolveNamedDefinition(
        index,
        mod,
        mod.file,
        parsed.sup,
        name.text,
        undefined,
        name.startIndex,
        { node: name, source: parsed.source, typeOnly: true },
        scopeIndex,
      );
  const target = local ?? (resolved?.status === "ok" ? resolved.definition : null);
  if (!target) {
    const spelling = normalizeKotlinIdentifier(type.text);
    const unqualified = spelling.startsWith("kotlin.") ? spelling.slice(7) : spelling;
    const builtin = Object.hasOwn(NON_LAMBDA_BUILTINS, unqualified);
    return !builtin || !!binding || mod.imports.some((imp) => imp.kind === "star");
  }
  if (target.typeParameter) return true;
  const declared = await declarationNodeOf(index, target);
  if (!declared) return true;
  if (target.kind === SymbolKind.TypeAlias) {
    const aliased = declared.node.namedChildren.find(
      (child) =>
        child.type === "user_type" ||
        child.type === "function_type" ||
        child.type === "nullable_type" ||
        child.type === "parenthesized_type",
    );
    const targetMod = index.byFile.get(fileIdentityKey(target.file));
    if (!aliased || !targetMod || depth >= 4) return true;
    return acceptsLambdaType(index, targetMod, declared.parsed, aliased, depth + 1);
  }
  if (target.kind !== SymbolKind.Class && target.kind !== SymbolKind.Interface) return true;
  // Kotlin fun interfaces accept SAM conversion; an ordinary nominal project type does not.
  for (let at = 0; ; at += 1) {
    const child = declared.node.child(at);
    if (!child || child.type === "identifier") return false;
    if (child.type === "fun") return true;
  }
}

const trailingLambdaCompatibility = new WeakMap<
  ProjectIndex,
  { byFile: ProjectIndex["byFile"]; size: number; results: WeakMap<SymbolDef, boolean> }
>();

/** The declaration-level half of trailing-lambda call compatibility, shared by navigation and graph selection. */
export async function kotlinCallableAcceptsTrailingLambda(
  index: ProjectIndex,
  def: SymbolDef,
  known?: { node: SyntaxNodeLike; parsed: ParsedFileContext },
): Promise<boolean> {
  let cached = trailingLambdaCompatibility.get(index);
  if (!cached || cached.byFile !== index.byFile || cached.size !== index.byFile.size) {
    cached = { byFile: index.byFile, size: index.byFile.size, results: new WeakMap() };
    trailingLambdaCompatibility.set(index, cached);
  }
  const knownResult = cached.results.get(def);
  if (knownResult !== undefined) {
    assertQuerySourceForIndex(index, def.file);
    // A fully evicted declaration must be reloaded to detect source changes, even on a compatibility hit.
    if (known || cachedParsedContextForIndexSync(index, def.file)) return knownResult;
  }
  const declared = known ?? (await declarationNodeOf(index, def));
  if (!declared || declared.parsed.sup.id !== "kotlin") return true;
  const parameters = declared.node.namedChildren.find((child) => child.type === "function_value_parameters");
  if (!parameters) return true;
  const children = parameters.namedChildren;
  let last: SyntaxNodeLike | undefined;
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i]!.type !== "parameter") continue;
    last = children[i];
    break;
  }
  if (!last) {
    cached.results.set(def, false);
    return false;
  }
  const type = last.namedChildren.find((child) => child.type !== "identifier");
  const mod = index.byFile.get(fileIdentityKey(def.file));
  const accepts = !type || !mod || (await acceptsLambdaType(index, mod, declared.parsed, type, 0));
  cached.results.set(def, accepts);
  return accepts;
}
