import type { SyntaxNodeLike } from "../../languages/types.js";
import { normalizeCsharpIdentifier } from "../../util/identifiers.js";
import { fileIdentityKey } from "../../util/paths.js";
import { ensureParsedContextForIndex, rethrowStaleQuerySource } from "../parsed-cache.js";
import { SymbolKind, type SymbolDef } from "../types.js";
import { csharpRecordProperty } from "./csharp-record-property.js";
import type { MemberLookupPolicy, MemberOwnerRef, RenameCompanions } from "./types.js";

type RenameContext = Parameters<NonNullable<MemberLookupPolicy["renameCompanions"]>>[0];

const CONTRACT_MEMBER_TYPES: ReadonlySet<string> = new Set([
  "property_declaration",
  "method_declaration",
  "event_declaration",
  "event_field_declaration",
]);
const UNPROVEN_INTERFACE_RENAME: RenameCompanions = {
  definitions: [],
  unprovenReason: "C# interface member and implementation names are not linked for rename.",
};
const UNPROVEN_VIRTUAL_RENAME: RenameCompanions = {
  definitions: [],
  unprovenReason: "C# virtual member and override names are not linked for rename.",
};

/** Fields and ordinary parameters are not interface implementations; record parameters may synthesize properties. */
function contractDeclaration(name: SyntaxNodeLike): SyntaxNodeLike | null {
  let declaration = name.parent;
  if (declaration?.type === "variable_declarator") declaration = declaration.parent?.parent ?? null;
  if (declaration && CONTRACT_MEMBER_TYPES.has(declaration.type)) return declaration;
  if (declaration?.type !== "parameter" || declaration.parent?.type !== "parameter_list") return null;
  return declaration.parent.parent?.type === "record_declaration" ? declaration : null;
}

function hasVirtualModifier(declaration: SyntaxNodeLike): boolean {
  for (const child of declaration.namedChildren) {
    if (child.type !== "modifier") continue;
    if (child.text === "abstract" || child.text === "virtual" || child.text === "override") return true;
  }
  return false;
}

/** Class and struct members default to private; interface members and positional properties do not. */
function isPrivateMember(declaration: SyntaxNodeLike, owner: SyntaxNodeLike): boolean {
  let explicitlyPrivate = false;
  for (const child of declaration.namedChildren) {
    if (child.type !== "modifier") continue;
    if (child.text === "public" || child.text === "protected" || child.text === "internal") return false;
    if (child.text === "private") explicitlyPrivate = true;
  }
  return explicitlyPrivate || (declaration.type !== "parameter" && owner.type !== "interface_declaration");
}

function ownerDefinition(owner: MemberOwnerRef): SymbolDef | undefined {
  const name = owner.container.childForFieldName("name");
  if (!name) return undefined;
  return owner.module.locals.find(
    (definition) => definition.range.start.index === name.startIndex && definition.range.end.index === name.endIndex,
  );
}

/** Reuse the existing partial-owner lookup instead of treating a source part as a separate implementing type. */
async function typeParts(args: RenameContext, definition: SymbolDef): Promise<readonly MemberOwnerRef[] | undefined> {
  const owner = await args.deps.keywordClassRefFromDef(args.index, definition);
  if (!owner) return undefined;
  const result = await args.deps.sharedOwnerParts(args.index, owner);
  if (!result.complete) return undefined;
  return result.parts;
}

function declaredBaseCount(owner: MemberOwnerRef): number {
  return owner.container.namedChildren.find((child) => child.type === "base_list")?.namedChildren.length ?? 0;
}

async function typeDeclaresMember(
  args: RenameContext,
  owner: SymbolDef,
  name: string,
  kind: "any" | "abstract" | "instance-contract" | "static-contract",
): Promise<boolean | undefined> {
  const parts = await typeParts(args, owner);
  if (!parts) return undefined;
  for (const { module, context, container } of parts) {
    for (const member of module.locals) {
      if (normalizeCsharpIdentifier(member.localName) !== name) continue;
      const token = args.deps.nameNodeForDef(context, member);
      if (!token) return undefined;
      const declaration = contractDeclaration(token);
      if (!declaration) continue;
      const declaringType = args.deps.nearestMemberContainer(token);
      if (declaringType?.startIndex !== container.startIndex || declaringType.type !== container.type) continue;
      if (kind === "abstract") {
        const abstractMember = declaration.namedChildren.some(
          (child) => child.type === "modifier" && child.text === "abstract",
        );
        if (!abstractMember) continue;
      }
      if (kind === "instance-contract" && args.deps.hasStaticModifier(member, context, container)) continue;
      if (kind === "static-contract") {
        if (!args.deps.hasStaticModifier(member, context, container) || !hasVirtualModifier(declaration)) continue;
      }
      return true;
    }
  }
  return false;
}

/** Existing hierarchy queries bound this safety check; no override family is synthesized. */
async function relatedTypeDeclaresMember(
  args: RenameContext,
  owner: SymbolDef,
  name: string,
  direction: "super" | "sub",
  kind: "any" | "abstract",
): Promise<boolean | undefined> {
  const related = args.relatedTypes(owner, direction);
  if (!related?.complete) return undefined;
  for (const definition of related.definitions) {
    if (definition.kind === SymbolKind.Interface) continue;
    const declared = await typeDeclaresMember(args, definition, name, kind);
    if (declared === undefined || declared) return declared;
  }
  return false;
}

/** Independently renaming a proven virtual or interface member family is unsafe until its declarations are linked. */
export async function csharpInterfaceRenameCompanions(args: RenameContext): Promise<RenameCompanions | undefined> {
  const { index, target, deps } = args;
  if (target.kind !== SymbolKind.Variable && target.kind !== SymbolKind.Function) return undefined;
  try {
    const module = index.byFile.get(fileIdentityKey(target.file));
    if (!module) return UNPROVEN_INTERFACE_RENAME;
    const context = await ensureParsedContextForIndex(index, target.file);
    const name = deps.nameNodeForDef(context, target);
    if (!name) return UNPROVEN_INTERFACE_RENAME;
    const declaration = contractDeclaration(name);
    if (!declaration) return undefined;
    const owner = await deps.keywordClassRefFromNode(index, module, name);
    if (!owner) return UNPROVEN_INTERFACE_RENAME;
    const explicitImplementation = declaration.namedChildren.some(
      (child) => child.type === "explicit_interface_specifier",
    );
    if (explicitImplementation) return UNPROVEN_INTERFACE_RENAME;
    if (isPrivateMember(declaration, owner.container)) return undefined;
    const staticMember = deps.hasStaticModifier(target, context, owner.container);
    const virtualMember = hasVirtualModifier(declaration);
    const ownerDef = ownerDefinition(owner);
    if (!ownerDef) return UNPROVEN_INTERFACE_RENAME;
    const wanted = normalizeCsharpIdentifier(target.localName);
    if (declaration.type === "parameter") {
      const property = await csharpRecordProperty(index, owner, target.localName, deps);
      if (!property) {
        const ownMembers = deps.findDirectLocalsWithinNode(
          module.locals,
          wanted,
          owner.container,
          context,
          normalizeCsharpIdentifier,
        );
        if (ownMembers.length) return undefined;
        const inheritedAbstract = await relatedTypeDeclaresMember(args, ownerDef, wanted, "super", "abstract");
        if (inheritedAbstract === undefined || inheritedAbstract) return UNPROVEN_VIRTUAL_RENAME;
        return undefined;
      }
      if (property.range.start.index !== target.range.start.index) return undefined;
    }
    if (virtualMember && ownerDef.kind !== SymbolKind.Interface) {
      const baseMember = await relatedTypeDeclaresMember(args, ownerDef, wanted, "super", "any");
      if (baseMember === undefined || baseMember) return UNPROVEN_VIRTUAL_RENAME;
      const overridesUnindexedMember = declaration.namedChildren.some(
        (child) => child.type === "modifier" && child.text === "override",
      );
      if (overridesUnindexedMember) return UNPROVEN_VIRTUAL_RENAME;
      const derivedMember = await relatedTypeDeclaresMember(args, ownerDef, wanted, "sub", "any");
      if (derivedMember === undefined || derivedMember) return UNPROVEN_VIRTUAL_RENAME;
    }
    if (staticMember && ownerDef.kind === SymbolKind.Interface && !virtualMember) return undefined;
    const ownParts = await typeParts(args, ownerDef);
    if (!ownParts) return UNPROVEN_INTERFACE_RENAME;
    const candidates = new Set<SymbolDef>();
    for (const part of ownParts) {
      const definition = ownerDefinition(part);
      if (!definition) return UNPROVEN_INTERFACE_RENAME;
      if (ownerDef.kind === SymbolKind.Interface) {
        if (args.hasImplementers(definition)) return UNPROVEN_INTERFACE_RENAME;
        const ancestors = args.relatedTypes(definition, "super");
        if (!ancestors?.complete) return UNPROVEN_INTERFACE_RENAME;
        if (ancestors.directCount !== declaredBaseCount(part)) return UNPROVEN_INTERFACE_RENAME;
        continue;
      }
      candidates.add(definition);
      // A descendant can use this inherited member to implement an interface its base never declared.
      const descendants = args.relatedTypes(definition, "sub");
      if (!descendants?.complete) return UNPROVEN_INTERFACE_RENAME;
      for (const descendant of descendants.definitions) candidates.add(descendant);
    }
    const checkedParts = new Set<SymbolDef>();
    for (const related of candidates) {
      if (checkedParts.has(related)) continue;
      const parts = related === ownerDef ? ownParts : await typeParts(args, related);
      if (!parts) return UNPROVEN_INTERFACE_RENAME;
      for (const part of parts) {
        const definition = ownerDefinition(part);
        if (!definition) return UNPROVEN_INTERFACE_RENAME;
        checkedParts.add(definition);
        const ancestors = args.relatedTypes(definition, "super");
        if (!ancestors?.complete) return UNPROVEN_INTERFACE_RENAME;
        if (!staticMember && ancestors.directCount !== declaredBaseCount(part)) return UNPROVEN_INTERFACE_RENAME;
        for (const ancestor of ancestors.definitions) {
          if (ancestor.kind !== SymbolKind.Interface) continue;
          const contractKind = staticMember ? "static-contract" : "instance-contract";
          const declaresMember = await typeDeclaresMember(args, ancestor, wanted, contractKind);
          if (declaresMember === undefined) return UNPROVEN_INTERFACE_RENAME;
          if (declaresMember) return UNPROVEN_INTERFACE_RENAME;
        }
      }
    }
    return undefined;
  } catch (error) {
    rethrowStaleQuerySource(error);
    return UNPROVEN_INTERFACE_RENAME;
  }
}
