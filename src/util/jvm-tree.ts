import type { SyntaxNodeLike, SyntaxTreeLike } from "../languages/types.js";
import type { JvmLanguageId } from "./syntax-tree.js";

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

/** The children of a node that are not inside braces. */
function childrenOutsideBraces(parent: SyntaxNodeLike): SyntaxNodeLike[] {
  const outside: SyntaxNodeLike[] = [];
  let open = 0;
  for (let index = 0; ; index += 1) {
    const child = parent.child(index);
    if (!child) return outside;
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
  const nodes = childrenOutsideBraces(parent).flatMap((node) => (node.type === "ERROR" ? topLevelNodes(node) : [node]));
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

/** The package and top-level declared names of one file. An ERROR node declares nothing; the nodes around it still count. */
export function collectJvmFileFacts(tree: SyntaxTreeLike, languageId: JvmLanguageId): JvmFileFacts {
  const symbols = new Set<string>();
  const javaTypes = new Set<string>();
  for (const member of topLevelNodes(tree.rootNode)) {
    let name: string | undefined;
    if (languageId === "java") {
      if (JAVA_TYPE_DECLARATION_TYPES[member.type]) name = member.childForFieldName("name")?.text;
    } else if (member.type === "class_declaration" || member.type === "object_declaration") {
      name = member.childForFieldName("name")?.text;
      if (name) javaTypes.add(name);
    } else if (member.type === "type_alias") {
      name = member.childForFieldName("type")?.text;
    } else if (member.type === "function_declaration") {
      name = member.childForFieldName("name")?.text;
    }
    if (name) symbols.add(name);
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
