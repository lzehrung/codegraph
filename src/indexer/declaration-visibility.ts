import type { SyntaxNodeLike } from "../languages/types.js";

/**
 * Per-language declaration visibility for module exports. Rows are keyed by language id and live
 * next to `locals-and-exports.ts` because that is the only consumer this wave.
 *
 * A missing row keeps today's behavior: every module-scope capture is exported. Python stays on
 * its existing `__all__` / underscore filter rather than a row here.
 */

export type DeclarationVisibilityRow = {
  /** Ancestors (and the node itself) that own a visibility modifier. */
  declarationTypes: ReadonlySet<string>;
  /** Named nodes that spell visibility (`pub`, `private`, `internal`, ...). */
  modifierNodeTypes: ReadonlySet<string>;
  /**
   * When set, a declaration is exported only when one of these modifier texts is present.
   * Unmarked items are module-local (Rust).
   */
  publicModifierTexts?: ReadonlySet<string>;
  /**
   * Compacted modifier text with this prefix is public unless also hidden.
   * Covers Rust `pub(in path)` forms that cannot be listed exhaustively.
   */
  publicModifierPrefixes?: readonly string[];
  /** Modifier tokens that hide a declaration from module exports at any scope. */
  hiddenModifierTexts: ReadonlySet<string>;
  /** Extra hidden tokens that apply only outside a type body (C# `internal` at namespace scope). */
  namespaceHiddenModifierTexts?: ReadonlySet<string>;
  /** Ancestor types that mean the declaration is nested in a type, not at namespace/file scope. */
  typeContainerTypes?: ReadonlySet<string>;
  /**
   * Nested declarations inside these containers inherit the container's visibility instead of
   * requiring their own public modifier (Rust trait items).
   */
  inheritPublicFromParentTypes?: ReadonlySet<string>;
};

const RUST_ROW: DeclarationVisibilityRow = {
  declarationTypes: new Set([
    "function_item",
    "struct_item",
    "trait_item",
    "type_item",
    "enum_item",
    "const_item",
    "static_item",
    "macro_definition",
    "use_declaration",
    "mod_item",
  ]),
  modifierNodeTypes: new Set(["visibility_modifier"]),
  publicModifierTexts: new Set(["pub", "pub(crate)", "pub(super)"]),
  publicModifierPrefixes: ["pub("],
  hiddenModifierTexts: new Set(["pub(self)"]),
  inheritPublicFromParentTypes: new Set(["trait_item"]),
};

const JAVA_ROW: DeclarationVisibilityRow = {
  declarationTypes: new Set([
    "class_declaration",
    "record_declaration",
    "interface_declaration",
    "enum_declaration",
    "annotation_type_declaration",
    "method_declaration",
    "field_declaration",
  ]),
  modifierNodeTypes: new Set(["modifiers"]),
  hiddenModifierTexts: new Set(["private"]),
};

const CSHARP_ROW: DeclarationVisibilityRow = {
  declarationTypes: new Set([
    "class_declaration",
    "struct_declaration",
    "record_declaration",
    "interface_declaration",
    "enum_declaration",
    "method_declaration",
    "delegate_declaration",
    "property_declaration",
    "field_declaration",
    "event_field_declaration",
  ]),
  modifierNodeTypes: new Set(["modifier"]),
  hiddenModifierTexts: new Set(["private"]),
  namespaceHiddenModifierTexts: new Set(["internal"]),
  typeContainerTypes: new Set([
    "class_declaration",
    "struct_declaration",
    "record_declaration",
    "interface_declaration",
    "enum_declaration",
  ]),
};

const KOTLIN_ROW: DeclarationVisibilityRow = {
  declarationTypes: new Set([
    "class_declaration",
    "object_declaration",
    "function_declaration",
    "property_declaration",
    "type_alias",
  ]),
  modifierNodeTypes: new Set(["visibility_modifier"]),
  hiddenModifierTexts: new Set(["private", "internal"]),
};

const SWIFT_ROW: DeclarationVisibilityRow = {
  declarationTypes: new Set([
    "class_declaration",
    "protocol_declaration",
    "function_declaration",
    "property_declaration",
    "typealias_declaration",
    "associatedtype_declaration",
    "macro_declaration",
    "operator_declaration",
  ]),
  modifierNodeTypes: new Set(["visibility_modifier"]),
  hiddenModifierTexts: new Set(["private", "fileprivate"]),
};

/**
 * C and C++ `storage_class_specifier` is a named child of `function_definition`,
 * `declaration`, and `field_declaration` with no field name (pinned tree-sitter-c
 * 0.24.1 and tree-sitter-cpp 8b5b49eb). File-scope `static` is internal linkage;
 * `static` on a class/struct/union member is storage duration and stays exported.
 */
const C_FAMILY_ROW: DeclarationVisibilityRow = {
  declarationTypes: new Set(["function_definition", "declaration", "field_declaration"]),
  modifierNodeTypes: new Set(["storage_class_specifier"]),
  hiddenModifierTexts: new Set(),
  namespaceHiddenModifierTexts: new Set(["static"]),
  typeContainerTypes: new Set(["class_specifier", "struct_specifier", "union_specifier"]),
};

/**
 * Zig `pub` is an anonymous keyword child of the declaration (tree-sitter-zig 1.1.2),
 * not a named modifier node. Unmarked top-level items stay module-local, matching
 * `@import` visibility. `export` without `pub` is C ABI only and is not a Zig export.
 */
const ZIG_ROW: DeclarationVisibilityRow = {
  declarationTypes: new Set([
    "function_declaration",
    "variable_declaration",
    "using_namespace_declaration",
    "test_declaration",
    "comptime_declaration",
  ]),
  modifierNodeTypes: new Set(["pub"]),
  publicModifierTexts: new Set(["pub"]),
  hiddenModifierTexts: new Set(),
};

const VISIBILITY_BY_LANGUAGE: Record<string, DeclarationVisibilityRow> = {
  rust: RUST_ROW,
  java: JAVA_ROW,
  csharp: CSHARP_ROW,
  kotlin: KOTLIN_ROW,
  swift: SWIFT_ROW,
  zig: ZIG_ROW,
  c: C_FAMILY_ROW,
  cpp: C_FAMILY_ROW,
};

/** True when `languageId` has a visibility row that filters module exports. */
export function languageHasDeclarationVisibility(languageId: string): boolean {
  return VISIBILITY_BY_LANGUAGE[languageId] !== undefined;
}

function collectModifierTexts(declaration: SyntaxNodeLike, row: DeclarationVisibilityRow): string[] {
  const texts: string[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (row.modifierNodeTypes.has(node.type) && node.text) texts.push(node.text.trim());
  };
  // Zig `pub` is unnamed. Named-only walks miss it; other languages still match named modifiers.
  for (let index = 0; ; index += 1) {
    const child = declaration.child(index);
    if (!child) break;
    visit(child);
    for (const grand of child.namedChildren) visit(grand);
  }
  return texts;
}

function modifierTokens(texts: readonly string[]): string[] {
  const tokens: string[] = [];
  for (const text of texts) {
    for (const part of text.split(/\s+/)) {
      if (part) tokens.push(part);
    }
  }
  return tokens;
}

function enclosingAncestor(node: SyntaxNodeLike, types: ReadonlySet<string>): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node.parent;
  while (current) {
    if (types.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function findVisibilityDeclaration(node: SyntaxNodeLike, row: DeclarationVisibilityRow): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (row.declarationTypes.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

function hasAnyToken(tokens: readonly string[], wanted: ReadonlySet<string>): boolean {
  return tokens.some((token) => wanted.has(token));
}

function compactedModifierTexts(texts: readonly string[]): string[] {
  return texts.map((text) => text.replace(/\s+/g, ""));
}

function matchesPublicModifier(compacted: readonly string[], row: DeclarationVisibilityRow): boolean {
  const publicTexts = row.publicModifierTexts;
  if (!publicTexts) return false;
  if (hasAnyToken(compacted, row.hiddenModifierTexts)) return false;
  if (hasAnyToken(compacted, publicTexts)) return true;
  const prefixes = row.publicModifierPrefixes;
  if (!prefixes) return false;
  return compacted.some((text) => prefixes.some((prefix) => text.startsWith(prefix)));
}

function isExportedByRow(declaration: SyntaxNodeLike, row: DeclarationVisibilityRow): boolean {
  const inherited =
    row.publicModifierTexts && row.inheritPublicFromParentTypes
      ? enclosingAncestor(declaration, row.inheritPublicFromParentTypes)
      : null;
  const target = inherited ?? declaration;
  const texts = collectModifierTexts(target, row);
  const compacted = compactedModifierTexts(texts);
  const tokens = modifierTokens(texts);
  if (row.publicModifierTexts) {
    return matchesPublicModifier(compacted, row);
  }
  if (hasAnyToken(tokens, row.hiddenModifierTexts)) return false;
  if (
    row.namespaceHiddenModifierTexts &&
    hasAnyToken(tokens, row.namespaceHiddenModifierTexts) &&
    row.typeContainerTypes &&
    !enclosingAncestor(declaration, row.typeContainerTypes)
  ) {
    return false;
  }
  return true;
}

/**
 * Whether `node` (typically a name capture, or the declaration itself) is a module export.
 * Languages with no table row are exported, matching pre-visibility behavior.
 */
export function isExportedDeclaration(languageId: string, node: SyntaxNodeLike): boolean {
  const row = VISIBILITY_BY_LANGUAGE[languageId];
  if (!row) return true;
  const declaration = findVisibilityDeclaration(node, row);
  if (!declaration) return true;
  return isExportedByRow(declaration, row);
}
