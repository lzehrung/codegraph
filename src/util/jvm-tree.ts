import { supportById } from "../languages.js";
import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import { parseSyntaxTree, type JvmLanguageId } from "./syntax-tree.js";

/** Nodes that spell a dotted name: Java `scoped_identifier` and Kotlin `qualified_identifier`. */
const NAME_NODE_TYPES: Record<string, true> = { identifier: true, scoped_identifier: true, qualified_identifier: true };

const JAVA_TYPE_DECLARATION_TYPES: Record<string, true> = {
  class_declaration: true,
  interface_declaration: true,
  enum_declaration: true,
  record_declaration: true,
  annotation_type_declaration: true,
};

/**
 * What one Java or Kotlin file declares, read from its own syntax tree and stored with its module. Nothing here
 * depends on another file, so a cached module stays valid while its source does; lookups that need other files'
 * declarations combine these facts when they run.
 */
export type JvmFileFacts = {
  /** The declared package, or `null` for the unnamed package. */
  packageName: string | null;
  /** Top-level declared names an import can name. */
  symbols: string[];
  /** Kotlin top-level classes, objects, and interfaces: the only Kotlin declarations a Java import can name. */
  javaTypes?: string[];
};

/** One `import`, read from its syntax node, so its ranges come from the node and nothing is searched in text. */
export type JvmImportDirective = {
  statement: SyntaxNodeLike;
  /** The dotted name as written, without a trailing `.*`. */
  name: string;
  /** The last identifier of the name. */
  leaf: SyntaxNodeLike;
  /** A Java `import static`. */
  isStatic: boolean;
  /** An `import a.b.*`. */
  wildcard: boolean;
  /** The Kotlin `as` alias. */
  alias?: SyntaxNodeLike;
};

/** The identifiers of a dotted name in source order; a comment between segments is not one. */
function nameIdentifiers(node: SyntaxNodeLike, out: SyntaxNodeLike[] = []): SyntaxNodeLike[] {
  if (node.type === "identifier") out.push(node);
  else for (const child of node.namedChildren) if (NAME_NODE_TYPES[child.type]) nameIdentifiers(child, out);
  return out;
}

/** The children of a node outside braces, how many braces they leave open, and the last child. */
type ScannedChildren = { outside: SyntaxNodeLike[]; open: number; last: SyntaxNodeLike | null };

function scanChildren(parent: SyntaxNodeLike): ScannedChildren {
  const outside: SyntaxNodeLike[] = [];
  let open = 0;
  let last: SyntaxNodeLike | null = null;
  for (let index = 0; ; index += 1) {
    const child = parent.child(index);
    if (!child) return { outside, open, last };
    last = child;
    if (child.type === "{") open += 1;
    else if (child.type === "}") open = Math.max(0, open - 1);
    else if (!open) outside.push(child);
  }
}

/**
 * The nodes at the top of a file. A syntax error the grammar cannot recover from leaves the nodes it did read in an
 * ERROR node, which is the root itself when nothing around the error parsed. An ERROR is listed together with its nodes
 * outside braces, which count as top-level too.
 */
function topLevelNodes(parent: SyntaxNodeLike): SyntaxNodeLike[] {
  const nodes = scanChildren(parent).outside.flatMap((node) => (node.type === "ERROR" ? topLevelNodes(node) : [node]));
  return parent.type === "ERROR" ? [parent, ...nodes] : nodes;
}

/** The package a file declares, or `null` for the unnamed package. */
export function jvmPackageName(tree: SyntaxTreeLike, languageId: JvmLanguageId): string | null {
  const clauseType = languageId === "kotlin" ? "package_header" : "package_declaration";
  const clause = topLevelNodes(tree.rootNode).find((member) => member.type === clauseType);
  const name = clause?.namedChildren.find((child) => NAME_NODE_TYPES[child.type]);
  const identifiers = name ? nameIdentifiers(name) : [];
  return identifiers.length ? identifiers.map((identifier) => identifier.text).join(".") : null;
}

function firstIdentifier(node: SyntaxNodeLike): SyntaxNodeLike | undefined {
  if (node.type === "identifier") return node;
  for (const child of node.namedChildren) {
    const found = firstIdentifier(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * The name a Kotlin top-level function contributes to its package: the identifier that directly follows `fun`. An
 * extension function therefore names its receiver type, while a function with type parameters or a parenthesized
 * receiver type names nothing.
 */
function kotlinFunctionSymbol(node: SyntaxNodeLike): string | undefined {
  for (let index = 0; ; index += 1) {
    const child = node.child(index);
    if (!child) return undefined;
    if (child.type !== "fun") continue;
    const following = node.child(index + 1);
    if (!following || following.type === "type_parameters") return undefined;
    const identifier = firstIdentifier(following);
    return identifier?.startIndex === following.startIndex ? identifier.text : undefined;
  }
}

/** What re-reading the text a syntax error left out of a tree may cost: the parses and characters one file may use. */
export const MAX_UNREAD_PARSES = 256;
export const MAX_UNREAD_CHARS = 1024 * 1024;

/**
 * The text of an ERROR node that can be parsed again: the declaration its children begin, and the text after them. The
 * grammar skips that text without building nodes for it, as when two one-line Kotlin class bodies follow each other.
 * Only an ERROR whose braces balance holds whole declarations and leaves the text after it outside braces. A part is
 * returned only when it is shorter than the `size` of the text it was read from, so reading parts of parts always ends.
 */
function unreadParts(error: SyntaxNodeLike, size: number): string[] {
  const { open, last } = scanChildren(error);
  const cut = last ? last.endIndex - error.startIndex : 0;
  if (open || cut <= 0) return [];
  const text = error.text;
  const parts: string[] = [];
  if (cut < size) parts.push(text.slice(0, cut));
  if (cut < text.length) parts.push(text.slice(cut));
  return parts;
}

/**
 * The package and top-level declared names of one file. A syntax error can leave the end of a file out of its tree: that
 * text, and the declaration the ERROR node begins, are parsed again within the limits above so their names count too.
 * Names the limits cannot reach stay undeclared.
 */
export function collectJvmFileFacts(tree: SyntaxTreeLike, languageId: JvmLanguageId): JvmFileFacts {
  const symbols = new Set<string>();
  const javaTypes = new Set<string>();
  const unread: string[] = [];
  const read = (root: SyntaxNodeLike): void => {
    const size = root.endIndex - root.startIndex;
    for (const member of topLevelNodes(root)) {
      let name: string | undefined;
      if (member.type === "ERROR") {
        unread.push(...unreadParts(member, size));
      } else if (languageId === "java") {
        if (JAVA_TYPE_DECLARATION_TYPES[member.type]) name = member.childForFieldName("name")?.text;
      } else if (member.type === "class_declaration" || member.type === "object_declaration") {
        name = member.childForFieldName("name")?.text;
        if (name) javaTypes.add(name);
      } else if (member.type === "type_alias") {
        name = member.childForFieldName("type")?.text;
      } else if (member.type === "function_declaration") {
        name = kotlinFunctionSymbol(member);
      }
      if (name) symbols.add(name);
    }
  };
  read(tree.rootNode);
  // Each part parsed can leave more text behind its own ERROR, so `unread` grows while it is read.
  const support = supportById(languageId);
  let parses = 0;
  let chars = 0;
  for (const text of unread) {
    parses += 1;
    chars += text.length;
    if (!support || parses > MAX_UNREAD_PARSES || chars > MAX_UNREAD_CHARS) break;
    const part = parseSyntaxTree(text, support).tree;
    if (part) read(part.rootNode);
  }
  const packageName = jvmPackageName(tree, languageId);
  return languageId === "java"
    ? { packageName, symbols: [...symbols] }
    : { packageName, symbols: [...symbols], javaTypes: [...javaTypes] };
}

/** Whether a persisted value has the shape of {@link JvmFileFacts}. Both cache layers validate rows with it. */
export function isJvmFileFacts(value: unknown): value is JvmFileFacts {
  if (!value || typeof value !== "object") return false;
  const facts = value as { packageName?: unknown; symbols?: unknown; javaTypes?: unknown };
  const isNames = (names: unknown): boolean => Array.isArray(names) && names.every((name) => typeof name === "string");
  return (
    (facts.packageName === null || typeof facts.packageName === "string") &&
    isNames(facts.symbols) &&
    (facts.javaTypes === undefined || isNames(facts.javaTypes))
  );
}

/** The `import` statements of a file in source order; only the top level of a file, or an ERROR in it, can hold one. */
export function collectJvmImportDirectives(tree: SyntaxTreeLike, languageId: JvmLanguageId): JvmImportDirective[] {
  const statementType = languageId === "kotlin" ? "import" : "import_declaration";
  const directives: JvmImportDirective[] = [];
  for (const statement of topLevelNodes(tree.rootNode)) {
    if (statement.type !== statementType) continue;
    let nameNode: SyntaxNodeLike | undefined;
    let alias: SyntaxNodeLike | undefined;
    let isStatic = false;
    let wildcard = false;
    for (let index = 0; ; index += 1) {
      const child = statement.child(index);
      if (!child) break;
      if (child.type === "static") isStatic = true;
      else if (child.type === "asterisk" || child.type === "*") wildcard = true;
      else if (!NAME_NODE_TYPES[child.type]) continue;
      else if (nameNode) alias = child;
      else nameNode = child;
    }
    const identifiers = nameNode ? nameIdentifiers(nameNode) : [];
    const leaf = identifiers[identifiers.length - 1];
    if (!leaf) continue;
    directives.push({
      statement,
      name: identifiers.map((identifier) => identifier.text).join("."),
      leaf,
      isStatic,
      wildcard,
      ...(alias ? { alias } : {}),
    });
  }
  return directives;
}
