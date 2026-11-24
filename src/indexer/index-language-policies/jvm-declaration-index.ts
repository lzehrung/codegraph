import type { SyntaxNodeLike } from "../../languages/types.js";
import { isJavaProtectedDeclaration, isJavaPublicDeclaration } from "../declaration-visibility.js";
import type { DeclarationHooks } from "../language-hook-types.js";
import { SymbolKind, type SymbolDef } from "../types.js";

const JVM_OWNER_TYPES = new Set([
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
  "object_declaration",
]);
const JVM_CLASSIFIER_KINDS = new Set([SymbolKind.Class, SymbolKind.Interface]);
const JAVA_OWNER_KINDS = new Set([...JVM_CLASSIFIER_KINDS, SymbolKind.TypeAlias]);

/** Record Java's own static and access facts after the enclosing type is found. */
function completeJavaDeclaration(node: SyntaxNodeLike, definition: SymbolDef, owner: SyntaxNodeLike | undefined): void {
  if (owner && definition.isMember) {
    const declaration = node.parent?.type === "variable_declarator" ? node.parent.parent : node.parent;
    const implicitStatic =
      declaration?.type === "enum_declaration" ||
      declaration?.type === "interface_declaration" ||
      declaration?.type === "annotation_type_declaration" ||
      declaration?.type === "enum_constant" ||
      owner.type === "interface_declaration" ||
      (owner.type === "annotation_type_declaration" && declaration?.type !== "annotation_type_element_declaration");
    const explicitStatic = declaration?.namedChildren.some(
      (child) => child.type === "modifiers" && /\bstatic\b/u.test(child.text),
    );
    if (implicitStatic || explicitStatic) definition.jvmStaticMember = true;
  }
  if (definition.isMember && isJavaProtectedDeclaration(node)) definition.javaProtectedMember = true;
  if (
    !isJavaPublicDeclaration(node) &&
    owner?.type !== "interface_declaration" &&
    owner?.type !== "annotation_type_declaration"
  ) {
    definition.javaPackagePrivate = true;
  }
}

export const javaDeclarations: DeclarationHooks = {
  ownerFacts: {
    ownerTypes: JVM_OWNER_TYPES,
    declarationKinds: JAVA_OWNER_KINDS,
    includeMembers: true,
    complete: completeJavaDeclaration,
  },
};

export const kotlinDeclarations: DeclarationHooks = {
  ownerFacts: { ownerTypes: JVM_OWNER_TYPES, declarationKinds: JVM_CLASSIFIER_KINDS },
};
