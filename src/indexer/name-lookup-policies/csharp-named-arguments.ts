import { declaresMembers } from "../../graphs/symbol-graph-detailed/receiver-calls.js";
import { getCallArgumentCount, getCallableArity } from "../../languages/callable-arity.js";
import type { SyntaxNodeLike } from "../../languages/types.js";
import type { FileId } from "../../types.js";
import { sliceText } from "../../util/ast.js";
import { fileIdentityKey } from "../../util/paths.js";
import type { BareNameUse, JvmTypeNameResolver } from "../name-resolution-types.js";
import { memberAcceptsCallAt, resolveMemberAccessDefinition } from "../navigation-goto.js";
import { definitionForBinding } from "../navigation-local.js";
import { findClosestScopeBinding } from "../scope-lookup.js";
import { ensureParsedContextForIndex } from "../parsed-cache.js";
import { SymbolKind, type GoToResult, type ProjectIndex, type SymbolDef } from "../types.js";

/** The indexed parameter with this name on a uniquely selected callable declaration. */
function indexedParameter(
  index: ProjectIndex,
  file: FileId,
  declaration: SyntaxNodeLike,
  name: string,
  normalize: (name: string) => string,
): SymbolDef | undefined {
  const parameters = declaration.childForFieldName("parameters");
  const wanted = normalize(name);
  const parameter = parameters?.namedChildren.find((candidate) => {
    const token = candidate.childForFieldName("name");
    return !!token && normalize(token.text) === wanted;
  });
  const token = parameter?.childForFieldName("name");
  if (!token) return undefined;
  return index.byFile
    .get(fileIdentityKey(file))
    ?.locals.find(
      (candidate) => candidate.range.start.index === token.startIndex && candidate.range.end.index === token.endIndex,
    );
}

/** Resolves a named argument only after its method or constructor is uniquely selected. */
export async function resolveCsharpNamedArgument(
  use: BareNameUse,
  call: SyntaxNodeLike,
  resolve: (use: BareNameUse) => Promise<GoToResult | null>,
  resolveJvmTypeName: JvmTypeNameResolver,
): Promise<SymbolDef | undefined> {
  const { index, mod, file, parsed, scopeIndex } = use;
  const { source, tree, sup } = parsed;
  if (call.type === "invocation_expression") {
    const functionNode = call.childForFieldName("function");
    if (!functionNode) return undefined;
    const callee =
      functionNode.type === "member_access_expression" ? functionNode.childForFieldName("name") : functionNode;
    if (!callee || callee.type !== "identifier") return undefined;
    const calleeUse = { ...use, node: callee, name: sliceText(callee, source) };
    const member =
      functionNode === callee
        ? null
        : await resolveMemberAccessDefinition({
            index,
            mod,
            node: callee,
            source,
            tree,
            sup,
            scopeIndex,
            resolveJvmTypeName,
            resolveLexicalBinding: (receiver) => {
              const binding = findClosestScopeBinding(scopeIndex, sliceText(receiver, source), receiver, sup);
              if (!binding || binding.import) return null;
              return definitionForBinding(binding, file, receiver, sup, source, tree);
            },
          });
    const target = functionNode === callee ? await resolve(calleeUse) : member;
    if (target?.status !== "ok" || target.definition.kind !== SymbolKind.Function) return undefined;
    if (!memberAcceptsCallAt(index, target.definition, callee, source, sup.id)) return undefined;
    const context = await ensureParsedContextForIndex(index, target.definition.file);
    const start = target.definition.range.start.index;
    const end = target.definition.range.end.index;
    if (start === undefined || end === undefined) return undefined;
    const name = context.tree.rootNode.descendantForIndex(start, end);
    const declaration = name.parent;
    return declaration
      ? indexedParameter(index, target.definition.file, declaration, use.name, sup.normalizeIdentifier)
      : undefined;
  }
  const type = call.childForFieldName("type");
  if (!type) return undefined;
  const typeUse = { ...use, node: type, name: sliceText(type, source) };
  const target = await resolve(typeUse);
  if (target?.status !== "ok" || !declaresMembers(target.definition)) return undefined;
  const context = await ensureParsedContextForIndex(index, target.definition.file);
  const start = target.definition.range.start.index;
  const end = target.definition.range.end.index;
  if (start === undefined || end === undefined) return undefined;
  const owner = context.tree.rootNode.descendantForIndex(start, end).parent;
  if (!owner || owner.namedChildren.some((child) => child.type === "modifier" && child.text === "partial"))
    return undefined;
  const count = getCallArgumentCount({ languageId: sup.id, source, call });
  if (count === null) return undefined;
  const candidates = owner.childForFieldName("body")?.namedChildren.filter((child) => {
    if (child.type !== "constructor_declaration") return false;
    const arity = getCallableArity({ languageId: sup.id, source: context.source, declaration: child });
    if (!arity || count < arity.minArgs || (arity.maxArgs !== null && count > arity.maxArgs)) return false;
    return !!indexedParameter(index, target.definition.file, child, use.name, sup.normalizeIdentifier);
  });
  if (candidates?.length !== 1) return undefined;
  return indexedParameter(index, target.definition.file, candidates[0]!, use.name, sup.normalizeIdentifier);
}
