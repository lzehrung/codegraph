import type { TriviaMode } from "./symbol-ranges.js";

const commentNodeTypes = new Set(["comment", "line_comment", "block_comment"]);

const leadingAllNodeTypes: Record<string, Set<string>> = {
  csharp: new Set(["attribute_list"]),
  java: new Set(["modifiers"]),
  js: new Set(["decorator"]),
  jsx: new Set(["decorator"]),
  kotlin: new Set(["modifiers"]),
  php: new Set(["attribute_list"]),
  python: new Set(["decorator"]),
  rust: new Set(["attribute_item", "inner_attribute_item"]),
  swift: new Set(["attribute"]),
  ts: new Set(["decorator"]),
  tsx: new Set(["decorator"]),
};

export function isLeadingTriviaNode(languageId: string, nodeType: string, mode: TriviaMode): boolean {
  if (commentNodeTypes.has(nodeType)) return true;
  if (mode !== "leading-all") return false;
  return leadingAllNodeTypes[languageId]?.has(nodeType) ?? false;
}

export function isLeadingTriviaTransparentNode(languageId: string, nodeType: string): boolean {
  if (commentNodeTypes.has(nodeType)) return true;
  return Object.values(leadingAllNodeTypes).some((nodeTypes) => nodeTypes.has(nodeType)) ||
    (languageId === "go" && nodeType === "comment");
}
