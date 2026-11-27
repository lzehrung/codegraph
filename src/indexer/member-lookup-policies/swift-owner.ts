import type { SyntaxNodeLike } from "../../languages/types.js";
import { sliceText } from "../../util/ast.js";
import { normalizeSwiftIdentifier } from "../../util/identifiers.js";
import { isSwiftCrossFileHiddenSharedOwnerMember } from "../declaration-visibility.js";
import type { SharedOwnerIdentity, SharedOwnerRules } from "./owner-identity-types.js";
import type { ParsedFileContext } from "../parse-context.js";
import { toTreeSitterPosition } from "../shared.js";
import type { SymbolDef } from "../types.js";
function swiftKeywordText(container: SyntaxNodeLike, source: string): string {
  const kind = container.childForFieldName("declaration_kind");
  if (kind) {
    const text = sliceText(kind, source).trim();
    if (text) return text;
  }
  const first = container.child(0);
  return first ? sliceText(first, source).trim() : "";
}

export function isSwiftExtensionContainer(container: SyntaxNodeLike, source: string): boolean {
  return container.type === "class_declaration" && swiftKeywordText(container, source) === "extension";
}

function appendSwiftConstraintTokens(node: SyntaxNodeLike, source: string, tokens: string[]): void {
  if (node.type === "comment" || node.type === "line_comment" || node.type === "multiline_comment") return;
  const first = node.child(0);
  if (!first) {
    const text = sliceText(node, source);
    const identifier =
      node.type === "simple_identifier" || node.type === "type_identifier" || node.type === "identifier";
    tokens.push(identifier ? normalizeSwiftIdentifier(text) : text);
    return;
  }
  appendSwiftConstraintTokens(first, source, tokens);
  for (let index = 1; ; index += 1) {
    const child = node.child(index);
    if (!child) break;
    appendSwiftConstraintTokens(child, source, tokens);
  }
}

function swiftConstraintKey(container: SyntaxNodeLike, source: string): string | null {
  if (!isSwiftExtensionContainer(container, source)) return null;
  const constraints = (container.namedChildren ?? []).find((child) => child.type === "type_constraints");
  if (!constraints) return null;
  // Leaf tokens ignore trivia but preserve token boundaries and literal contents.
  // Different constraint expressions remain separate; semantic equivalence is not inferred.
  const tokens: string[] = [];
  appendSwiftConstraintTokens(constraints, source, tokens);
  return JSON.stringify(tokens);
}

export function isSwiftConstrainedExtension(container: SyntaxNodeLike, source: string): boolean {
  return swiftConstraintKey(container, source) !== null;
}

function isSwiftTypeContainer(container: SyntaxNodeLike, source: string): boolean {
  if (container.type === "protocol_declaration") return true;
  if (container.type !== "class_declaration") return false;
  const text = swiftKeywordText(container, source);
  return text === "class" || text === "struct" || text === "enum" || text === "actor";
}

function swiftNameText(container: SyntaxNodeLike, source: string): string | null {
  const nameNode = container.childForFieldName("name");
  if (!nameNode) return null;
  const text = sliceText(nameNode, source).trim();
  return text ? text : null;
}

function getSwiftFullPath(container: SyntaxNodeLike, source: string): string | null {
  const raw = swiftNameText(container, source);
  if (!raw) return null;
  const nameParts = raw
    .split(".")
    .map((part) => normalizeSwiftIdentifier(part.trim()))
    .filter((part) => part.length > 0);
  if (!nameParts.length) return null;
  const outer: string[] = [];
  let current = container.parent;
  while (current) {
    if (current.type === "class_declaration") {
      const outerRaw = swiftNameText(current, source);
      if (outerRaw) {
        const outerParts = outerRaw
          .split(".")
          .map((part) => normalizeSwiftIdentifier(part.trim()))
          .filter((part) => part.length > 0);
        for (let i = outerParts.length - 1; i >= 0; i -= 1) outer.push(outerParts[i] as string);
      }
    }
    current = current.parent;
  }
  outer.reverse();
  return [...outer, ...nameParts].join(".");
}

/** An extension's constraints remain part of its identity, without inferring equivalent constraints. */
export function swiftOwnerIdentity(container: SyntaxNodeLike, source: string): SharedOwnerIdentity | null {
  if (isSwiftExtensionContainer(container, source) || isSwiftTypeContainer(container, source)) {
    const swiftConstraint = swiftConstraintKey(container, source);
    const fullPath = getSwiftFullPath(container, source);
    if (!fullPath) return null;
    return { languageId: "swift", fullPath, ...(swiftConstraint !== null ? { swiftConstraint } : {}) };
  }
  return null;
}

export const swiftSharedOwnerRules: SharedOwnerRules = {
  containerTypes: new Set(["class_declaration", "protocol_declaration"]),
  identity: swiftOwnerIdentity,
  isExtension: isSwiftExtensionContainer,
  isConstrainedExtension: isSwiftConstrainedExtension,
  memberVisible: (ownerFile, peerFile, name) =>
    !!name && !isSwiftCrossFileHiddenSharedOwnerMember("swift", ownerFile, peerFile, name),
};

/** Receiver member visibility also respects a private enclosing extension. */
export function swiftCrossFileMemberHidden(useFile: string, member: SymbolDef, context: ParsedFileContext): boolean {
  const position = toTreeSitterPosition(member.range.start);
  const name = context.tree.rootNode.descendantForPosition(position, position);
  if (!name) return false;
  return isSwiftCrossFileHiddenSharedOwnerMember("swift", useFile, member.file, name);
}
