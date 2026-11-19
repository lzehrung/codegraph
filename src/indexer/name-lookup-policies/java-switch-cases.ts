import type { SyntaxNodeLike } from "../../languages/types.js";
import { isJavaSwitchLabelName } from "../../util/java-designators.js";
import { findClosestScopeBinding, getOrBuildScopeIndex } from "../navigation-local.js";
import { findReceiverTypeMember, resolveMemberAccessDefinition } from "../navigation-goto.js";
import { createLoadingParsedFileProvider, ensureParsedContextForIndex } from "../parsed-cache.js";
import { fileIdentityKey } from "../../util/paths.js";
import { okGoToResult } from "../navigation-provenance.js";
import { UNPROVEN_JAVA_SWITCH_CASE_REASON } from "../ambiguous-resolution.js";
import type { BareNameUse, JvmTypeNameResolver, NameLookupState, NameResolution } from "../name-resolution-types.js";
import type { GoToResult } from "../types.js";
import { SymbolKind } from "../types.js";

/** Parameters and non-final locals are never Java constant expressions. */
function cannotBeCaseConstant(state: NameLookupState): boolean {
  const { use, closestBinding } = state;
  const normalize = use.parsed.sup.normalizeIdentifier;
  const wanted = normalize(state.lookupName);
  for (let current = use.node.parent; current; current = current.parent) {
    if (current.type === "method_declaration" || current.type === "constructor_declaration") break;
    if (current.type !== "catch_clause" && current.type !== "enhanced_for_statement") continue;
    const body = current.childForFieldName("body");
    if (!body || use.node.startIndex < body.startIndex || use.node.endIndex > body.endIndex) continue;
    const parameter =
      current.type === "catch_clause"
        ? current.namedChildren.find((child) => child.type === "catch_formal_parameter")
        : current;
    const name = parameter?.childForFieldName("name");
    if (name && normalize(name.text) === wanted) return true;
  }
  if (!closestBinding || closestBinding.import) return false;
  if (closestBinding.kind === "param") return true;
  if (closestBinding.kind !== "local") return false;
  let declaration = closestBinding.node?.parent;
  if (declaration?.type === "variable_declarator") declaration = declaration.parent;
  if (declaration?.type === "field_declaration" || declaration?.type === "constant_declaration") return false;
  if (declaration?.type === "enum_constant") return false;
  if (declaration?.type !== "local_variable_declaration") return true;
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  for (let index = 0; modifiers; index += 1) {
    const token = modifiers.child(index);
    if (!token) break;
    if (token.type === "final") return false;
  }
  return true;
}

/** Only the declared type is used: no iterable element or method-result inference. */
function subjectType(state: NameLookupState, subject: SyntaxNodeLike): SyntaxNodeLike | null {
  const { use } = state;
  const binding = findClosestScopeBinding(use.scopeIndex, subject.text, subject, use.parsed.sup);
  for (let parent = subject.parent; parent; parent = parent.parent) {
    if (parent.type === "method_declaration" || parent.type === "constructor_declaration") break;
    if (parent.type !== "enhanced_for_statement") continue;
    const body = parent.childForFieldName("body");
    if (!body || subject.startIndex < body.startIndex || subject.endIndex > body.endIndex) continue;
    const name = parent.childForFieldName("name");
    if (!name || use.parsed.sup.normalizeIdentifier(name.text) !== use.parsed.sup.normalizeIdentifier(subject.text))
      continue;
    // A closer local inside the loop still hides the iteration variable.
    if (binding?.node && binding.node.startIndex >= body.startIndex) break;
    return parent.childForFieldName("type");
  }
  let declaration = binding?.node?.parent;
  if (declaration?.type === "variable_declarator") declaration = declaration.parent;
  if (declaration?.type === "instanceof_expression") return declaration.childForFieldName("right");
  return declaration?.childForFieldName("type") ?? null;
}

/** A selected field supplies its own file's declared type, through ordinary shared receiver lookup. */
export async function settleJavaSwitchField(
  use: BareNameUse,
  subject: SyntaxNodeLike,
  resolveJvmTypeName: JvmTypeNameResolver,
  resolve: (use: BareNameUse) => Promise<GoToResult | null>,
): Promise<GoToResult | null> {
  const fieldName = subject.childForFieldName("field");
  if (!fieldName) return null;
  const field = await resolveMemberAccessDefinition({
    index: use.index,
    mod: use.mod,
    node: fieldName,
    ...use.parsed,
    scopeIndex: use.scopeIndex,
    resolveJvmTypeName,
  });
  if (field?.status !== "ok" || field.definition.kind !== SymbolKind.Variable) return null;
  const parsed = await ensureParsedContextForIndex(use.index, field.definition.file);
  const start = field.definition.range.start.index;
  const end = field.definition.range.end.index;
  if (start === undefined || end === undefined) return null;
  const name = parsed.tree.rootNode.descendantForIndex(start, end);
  const declaration = name.parent?.parent;
  if (name.parent?.type !== "variable_declarator" || declaration?.type !== "field_declaration") return null;
  const type = declaration.childForFieldName("type");
  const mod = use.index.byFile.get(fileIdentityKey(field.definition.file));
  if (!type || !mod) return null;
  const owner = await resolve({
    ...use,
    file: mod.file,
    mod,
    parsed,
    scopeIndex: getOrBuildScopeIndex(use.index, mod.file, parsed.source, parsed.sup, mod, parsed.tree),
    files: createLoadingParsedFileProvider(use.index, { file: mod.file, parsed }),
    node: type,
    name: type.text,
  });
  if (owner?.status !== "ok") return null;
  const ownerParsed = await ensureParsedContextForIndex(use.index, owner.definition.file);
  const ownerStart = owner.definition.range.start.index;
  const ownerEnd = owner.definition.range.end.index;
  if (ownerStart === undefined || ownerEnd === undefined) return null;
  const enumName = ownerParsed.tree.rootNode.descendantForIndex(ownerStart, ownerEnd);
  if (enumName.parent?.type !== "enum_declaration") return null;
  const member = await findReceiverTypeMember(use.index, use.mod, use.node, owner.definition, use.name, undefined);
  if (member.status !== "member" || member.member.kind !== SymbolKind.Variable) return null;
  const memberStart = member.member.range.start.index;
  const memberEnd = member.member.range.end.index;
  if (memberStart === undefined || memberEnd === undefined) return null;
  const token = ownerParsed.tree.rootNode.descendantForIndex(memberStart, memberEnd);
  if (token.parent?.type !== "enum_constant") return null;
  return okGoToResult(use.index, member.member, { resolution: "member-access", confidence: "high" });
}

/** A proven enum subject owns its labels; otherwise retain the ordinary constant lookup. */
export function javaSwitchCase(
  state: NameLookupState,
  rest: () => NameResolution | null,
): NameResolution | null | undefined {
  const { use } = state;
  if (!isJavaSwitchLabelName(use.node)) return undefined;
  const fallback = (): NameResolution | null =>
    cannotBeCaseConstant(state) ? { status: "not_found", reason: UNPROVEN_JAVA_SWITCH_CASE_REASON } : rest();
  let switchNode: SyntaxNodeLike | null = use.node.parent;
  while (switchNode && switchNode.type !== "switch_expression") switchNode = switchNode.parent;
  if (!switchNode) return fallback();
  let subject = switchNode.childForFieldName("condition");
  while (subject?.type === "parenthesized_expression") subject = subject.namedChildren[0] ?? null;
  if (subject?.type === "field_access") {
    return {
      status: "deferred",
      request: { kind: "java-switch-field", subject },
      fallback: fallback(),
    };
  }
  if (subject?.type !== "identifier") return fallback();
  const type = subjectType(state, subject);
  if (!type || type.type === "integral_type" || use.parsed.sup.normalizeIdentifier(type.text) === "var")
    return fallback();
  return {
    status: "deferred",
    request: {
      kind: "contextual-member",
      owner: type,
      expectedKind: SymbolKind.Variable,
      jvmTypeOnly: true,
      ownerDeclarationType: "enum_declaration",
      memberDeclarationType: "enum_constant",
    },
    fallback: fallback(),
  };
}
