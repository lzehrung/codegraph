import type { SyntaxNodeLike } from "../../languages/types.js";
import { isJavaSwitchLabelName } from "../../util/java-designators.js";
import { findClosestScopeBinding, getOrBuildScopeIndex } from "../navigation-local.js";
import { findReceiverTypeMember, resolveMemberAccessDefinition } from "../navigation-goto.js";
import { createLoadingParsedFileProvider, ensureParsedContextForIndex } from "../parsed-cache.js";
import { fileIdentityKey } from "../../util/paths.js";
import { okGoToResult } from "../navigation-provenance.js";
import { UNPROVEN_JAVA_SWITCH_CASE_REASON } from "../ambiguous-resolution.js";
import type { BareNameUse, JvmTypeNameResolver, NameLookupState, NameResolution } from "../name-resolution-types.js";
import { getCompilationUnitPeers } from "../compilation-units.js";
import { moduleLocalDefinitionsNamed, resolveImported } from "../navigation-resolve.js";
import type { GoToResult, ModuleIndex, SymbolDef } from "../types.js";
import { SymbolKind } from "../types.js";

const JAVA_CONSTANT_SELECTOR_TYPES: Readonly<Record<string, true>> = {
  String: true,
  "java.lang.String": true,
  Byte: true,
  "java.lang.Byte": true,
  Short: true,
  "java.lang.Short": true,
  Integer: true,
  "java.lang.Integer": true,
  Character: true,
  "java.lang.Character": true,
};

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
async function switchFieldTypeUse(
  use: BareNameUse,
  subject: SyntaxNodeLike,
  resolveJvmTypeName: JvmTypeNameResolver,
): Promise<BareNameUse | null> {
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
  return {
    ...use,
    file: mod.file,
    mod,
    parsed,
    scopeIndex: getOrBuildScopeIndex(use.index, mod.file, parsed.source, parsed.sup, mod, parsed.tree),
    files: createLoadingParsedFileProvider(use.index, { file: mod.file, parsed }),
    node: type,
    name: type.text,
  };
}

type ResolveSwitchName = (use: BareNameUse, typeOnly: boolean) => Promise<GoToResult | null>;

/** A declared non-enum type keeps constant lookup; a proven enum never falls back to a field. */
async function caseForDeclaredType(
  use: BareNameUse,
  typeUse: BareNameUse,
  resolve: ResolveSwitchName,
): Promise<GoToResult | "constant" | null> {
  if (typeUse.node.type === "integral_type") return "constant";
  const owner = await resolve(typeUse, true);
  if (owner?.status !== "ok") {
    const typeName = typeUse.parsed.sup.normalizeIdentifier(typeUse.name);
    return Object.hasOwn(JAVA_CONSTANT_SELECTOR_TYPES, typeName) ? "constant" : null;
  }
  const ownerParsed = await ensureParsedContextForIndex(use.index, owner.definition.file);
  const ownerStart = owner.definition.range.start.index;
  const ownerEnd = owner.definition.range.end.index;
  if (ownerStart === undefined || ownerEnd === undefined) return null;
  const enumName = ownerParsed.tree.rootNode.descendantForIndex(ownerStart, ownerEnd);
  if (enumName.parent?.type !== "enum_declaration") return "constant";
  const unproven: GoToResult = { status: "not_found", reason: UNPROVEN_JAVA_SWITCH_CASE_REASON };
  const member = await findReceiverTypeMember(use.index, use.mod, use.node, owner.definition, use.name, undefined);
  if (member.status !== "member" || member.member.kind !== SymbolKind.Variable) return unproven;
  const memberStart = member.member.range.start.index;
  const memberEnd = member.member.range.end.index;
  if (memberStart === undefined || memberEnd === undefined) return unproven;
  const token = ownerParsed.tree.rootNode.descendantForIndex(memberStart, memberEnd);
  if (token.parent?.type !== "enum_constant") return unproven;
  return okGoToResult(use.index, member.member, { resolution: "member-access", confidence: "high" });
}

/** A final field can collide with an enum label; a local constant still follows ordinary lexical lookup. */
async function isConstantField(use: BareNameUse, definition: SymbolDef): Promise<boolean> {
  if (definition.kind !== SymbolKind.Variable) return false;
  const start = definition.range.start.index;
  const end = definition.range.end.index;
  if (start === undefined || end === undefined) return false;
  const parsed = await ensureParsedContextForIndex(use.index, definition.file);
  const name = parsed.tree.rootNode.descendantForIndex(start, end);
  const declaration = name.parent?.parent;
  if (name.parent?.type !== "variable_declarator") return false;
  if (declaration?.type === "constant_declaration") return true;
  if (declaration?.type !== "field_declaration") return false;
  const modifiers = declaration.namedChildren.find((child) => child.type === "modifiers");
  for (let index = 0; modifiers; index += 1) {
    const token = modifiers.child(index);
    if (!token) break;
    if (token.type === "final") return true;
  }
  return false;
}

/** Only enums whose type or constant ordinary lookup can reach participate in an unknown subject's collision. */
async function moduleHasReachableEnumConstant(
  use: BareNameUse,
  mod: ModuleIndex,
  resolve: ResolveSwitchName,
): Promise<boolean> {
  const normalize = use.parsed.sup.normalizeIdentifier;
  const wanted = normalize(use.name);
  for (const candidate of moduleLocalDefinitionsNamed(use.index, mod.file, use.name)) {
    if (candidate.kind !== SymbolKind.Variable || candidate.jvmTypeOwnerStartIndex === undefined) continue;
    const start = candidate.range.start.index;
    const end = candidate.range.end.index;
    if (start === undefined || end === undefined) continue;
    const parsed = await ensureParsedContextForIndex(use.index, mod.file);
    const name = parsed.tree.rootNode.descendantForIndex(start, end);
    const owner = name.parent?.parent?.parent;
    if (name.parent?.type !== "enum_constant" || owner?.type !== "enum_declaration") continue;
    for (const imp of use.mod.imports) {
      if (imp.kind !== "named" && imp.kind !== "star") continue;
      if (!imp.jvmStaticWildcardName) continue;
      if (imp.kind === "named" && normalize(imp.imported) !== wanted) continue;
      const imported = resolveImported(use.index, imp, use.name);
      if (!imported || "namespace" in imported) continue;
      if (fileIdentityKey(imported.file) === fileIdentityKey(mod.file) && imported.range.start.index === start)
        return true;
    }
    const enumName = owner.childForFieldName("name");
    if (!enumName || !use.node.parent) continue;
    // The label's parent keeps the use-site scope without recursively looking up another switch label.
    const visible = await resolve({ ...use, node: use.node.parent, name: enumName.text }, true);
    if (visible?.status !== "ok") continue;
    if (fileIdentityKey(visible.definition.file) !== fileIdentityKey(mod.file)) continue;
    if (visible.definition.range.start.index === enumName.startIndex) return true;
  }
  return false;
}

async function hasReachableEnumConstant(use: BareNameUse, resolve: ResolveSwitchName): Promise<boolean> {
  const files = new Set(getCompilationUnitPeers(use.index, use.file).files);
  for (const imp of use.mod.imports) {
    if (typeof imp.resolved === "string") files.add(imp.resolved);
    if (imp.kind === "star") for (const file of imp.jvmPackageFiles ?? []) files.add(file);
  }
  for (const file of files) {
    const mod = use.index.byFile.get(fileIdentityKey(file));
    if (mod && (await moduleHasReachableEnumConstant(use, mod, resolve))) return true;
  }
  return false;
}

/** No method-result inference: unknown subjects retain the old answer unless an enum/field collision proves it unsafe. */
export async function settleJavaSwitchCase(
  use: BareNameUse,
  subject: SyntaxNodeLike | null,
  declaredType: SyntaxNodeLike | null,
  resolveJvmTypeName: JvmTypeNameResolver,
  resolve: ResolveSwitchName,
  fallback: () => Promise<GoToResult | null>,
): Promise<GoToResult | null> {
  let typeUse: BareNameUse | null = null;
  if (declaredType) typeUse = { ...use, node: declaredType, name: declaredType.text };
  else if (subject?.type === "field_access") typeUse = await switchFieldTypeUse(use, subject, resolveJvmTypeName);
  if (typeUse) {
    const proven = await caseForDeclaredType(use, typeUse, resolve);
    if (proven === "constant") return fallback();
    if (proven) return proven;
  }
  const ordinary = await fallback();
  if (ordinary?.status !== "ok" || !(await isConstantField(use, ordinary.definition))) return ordinary;
  if (!(await hasReachableEnumConstant(use, resolve))) return ordinary;
  return { status: "not_found", reason: UNPROVEN_JAVA_SWITCH_CASE_REASON };
}

/** A proven enum subject owns its labels; unknown subjects must not guess between enum and field constants. */
export function javaSwitchCase(
  state: NameLookupState,
  rest: () => NameResolution | null,
): NameResolution | null | undefined {
  const { use } = state;
  if (!isJavaSwitchLabelName(use.node)) return undefined;
  const fallback = cannotBeCaseConstant(state)
    ? { status: "not_found" as const, reason: UNPROVEN_JAVA_SWITCH_CASE_REASON }
    : rest();
  let switchNode: SyntaxNodeLike | null = use.node.parent;
  while (switchNode && switchNode.type !== "switch_expression") switchNode = switchNode.parent;
  let subject = switchNode?.childForFieldName("condition") ?? null;
  while (subject?.type === "parenthesized_expression") subject = subject.namedChildren[0] ?? null;
  let declaredType = subject?.type === "identifier" ? subjectType(state, subject) : null;
  if (declaredType && use.parsed.sup.normalizeIdentifier(declaredType.text) === "var") declaredType = null;
  if (declaredType?.type === "integral_type") return fallback;
  return { status: "deferred", request: { kind: "java-switch-case", subject, declaredType }, fallback };
}
