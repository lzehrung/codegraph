/**
 * Graph and navigation parity: every call or construction site inside a graph caller must get
 * the same answer from `goToDefinition` and `buildSymbolGraphDetailed`.
 *
 * For each call site found in the parse tree, the callee's name token is the use site:
 *  - `goToDefinition` resolves it to a declaration: the graph must have a `calls` or
 *    `instantiates` edge at that site to the declaration's node.
 *  - `goToDefinition` reports `not_found`: the graph must have no `calls`/`instantiates` edge at
 *    that site.
 *
 * Sites outside every graph caller (module top level) are skipped: the graph records calls only
 * from a declared caller. The site list comes from the syntax tree, not from the graph, so a call
 * form the graph does not recognize still counts.
 */

import { goToDefinition, parseFile, type ProjectIndex } from "../../src/index.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import type { SymbolDef } from "../../src/indexer/types.js";
import {
  CALLABLE_DECLARATION_NODE_TYPES,
  getCallableArity,
  getCallArgumentCount,
} from "../../src/languages/callable-arity.js";
import type { DetailedSymbolGraph } from "../../src/graphs/symbol-graph-detailed.js";
import type { ParsedFileContext } from "../../src/indexer/parse-context.js";
import type { SyntaxNodeLike } from "../../src/languages/types.js";
import { rustTokenTreeHoldsExpressions } from "../../src/util/member-access.js";
import { cppStarImportClosure } from "../../src/indexer/navigation-cpp.js";
import { fileIdentityKey, normalizePath } from "../../src/util/paths.js";

export type GraphNavigationMismatch = {
  /** `missing`: goto resolves, the graph has no matching edge. `wrong`: the graph edge targets
   * another declaration. `extra`: goto finds nothing, the graph has an edge. */
  kind: "missing" | "wrong" | "extra";
  /** `relative/path:line:column` of the callee name token. */
  site: string;
  /** The source line, trimmed. */
  text: string;
  goto?: string;
  graph?: string[];
};

/** Call and construction node types across the supported grammars. */
const CALL_NODE_TYPES = new Set([
  "call_expression",
  "call",
  "method_invocation",
  "invocation_expression",
  "new_expression",
  "object_creation_expression",
  "implicit_object_creation_expression",
  "function_call_expression",
  "member_call_expression",
  "nullsafe_member_call_expression",
  "scoped_call_expression",
  "constructor_invocation",
]);

/** Fields that hold the callee, in lookup order. The first match wins. */
const CALLEE_FIELDS = ["function", "method", "name", "constructor", "type", "callee"];

/** Subtrees that never hold the callee's own name. */
const NON_CALLEE_CHILD = /argument|type_arguments|type_parameter|call_suffix|value_arguments|lambda|closure|block/;

const NAME_LEAF = /identifier|^name$|^constant$/;

const COMPUTED_CALLEE = /parenthesized|binary|ternary|conditional/;

/** Declarations that can own a graph caller node through their name. */
const CALLER_HEADER =
  /function|method|constructor|declarator|lambda|arrow|closure|init_declaration|accessor|subroutine|operator|getter|setter|property_declaration|assignment/;

function calleeNode(call: SyntaxNodeLike): SyntaxNodeLike | null {
  for (const field of CALLEE_FIELDS) {
    const node = call.childForFieldName(field);
    if (node) return node;
  }
  return call.namedChildren.find((child) => !NON_CALLEE_CHILD.test(child.type)) ?? null;
}

/** The rightmost name leaf of a callee expression, skipping type arguments. */
function calleeName(node: SyntaxNodeLike | null): SyntaxNodeLike | null {
  if (!node) return null;
  if (NAME_LEAF.test(node.type) && !node.namedChildren.length) return node;
  for (let i = node.namedChildren.length - 1; i >= 0; i -= 1) {
    const child = node.namedChildren[i]!;
    if (NON_CALLEE_CHILD.test(child.type)) continue;
    const found = calleeName(child);
    if (found) return found;
  }
  return null;
}

/**
 * 1-based line and column of a node in characters. Tree columns are UTF-8 byte offsets, so the
 * position comes from the node's string index, which the parse context maps to characters.
 */
function position(node: SyntaxNodeLike, source: string): { line: number; column: number } | null {
  if (source.slice(node.startIndex, node.endIndex) !== node.text) return null;
  const lineStart = source.lastIndexOf("\n", node.startIndex - 1) + 1;
  const line = source.slice(0, lineStart).split("\n").length;
  return { line, column: node.startIndex - lineStart + 1 };
}

type Edge = DetailedSymbolGraph["edges"][number];

type CallerIndex = {
  /** Callable node ids keyed by file, then by the node's name start index. */
  byFile: Map<string, Map<number, string>>;
  /** Callable members keyed by the full `ns::Owner::member` path, from `member_of` edges. */
  byOwnerMember: Map<string, Array<{ id: string; ownerFile: string }>>;
  /** Every node id keyed by file, then name, for a function assigned to an existing binding. */
  byFileName: Map<string, Map<string, string[]>>;
};

async function callerIndex(graph: DetailedSymbolGraph): Promise<CallerIndex> {
  const byFile = new Map<string, Map<number, string>>();
  const byFileName = new Map<string, Map<string, string[]>>();
  for (const node of graph.nodes.values()) {
    const names = byFileName.get(normalizePath(node.file)) ?? new Map<string, string[]>();
    names.set(node.name, [...(names.get(node.name) ?? []), node.id]);
    byFileName.set(normalizePath(node.file), names);
    if (node.kind !== "function" && !node.callable) continue;
    const start = Number(node.id.slice(node.id.lastIndexOf("::") + 2));
    if (!Number.isFinite(start)) continue;
    const file = normalizePath(node.file);
    const starts = byFile.get(file) ?? new Map<number, string>();
    starts.set(start, node.id);
    byFile.set(file, starts);
  }
  const byOwnerMember = new Map<string, Array<{ id: string; ownerFile: string }>>();
  for (const edge of graph.edges) {
    if (edge.label !== "member_of") continue;
    const member = graph.nodes.get(edge.from);
    const owner = graph.nodes.get(edge.to);
    if (!member || !owner || member.kind !== "function") continue;
    const ownerPath = await declarationScopePath(owner.file, Number(owner.id.slice(owner.id.lastIndexOf("::") + 2)));
    if (!ownerPath) continue;
    const key = [...ownerPath, owner.name, member.name].join("::");
    byOwnerMember.set(key, [
      ...(byOwnerMember.get(key) ?? []),
      { id: member.id, ownerFile: normalizePath(owner.file) },
    ]);
  }
  return { byFile, byOwnerMember, byFileName };
}

const CPP_SCOPE_TYPES = new Set(["namespace_definition", "class_specifier", "struct_specifier", "union_specifier"]);

/** Names of the namespaces and classes enclosing `node`, outermost first. */
function lexicalScopePath(node: SyntaxNodeLike): string[] {
  const path: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (!CPP_SCOPE_TYPES.has(current.type)) continue;
    const name = current.childForFieldName("name");
    if (name) path.unshift(...name.text.split("::").map((segment) => segment.trim()));
  }
  return path;
}

/** The enclosing namespace/class path of the declaration named at `start` in `file`. */
async function declarationScopePath(file: string, start: number): Promise<string[] | null> {
  if (!Number.isFinite(start)) return null;
  const parsed = await parseFile(file);
  const nameNode = parsed.tree.rootNode.descendantForIndex(start, start + 1);
  const declaration = nameNode.parent;
  return declaration ? lexicalScopePath(declaration) : null;
}

/**
 * The full `ns::Owner::member` path a C++ out-of-line definition header declares (`int ns::Box::run()`
 * inside `namespace outer {}` is `outer::ns::Box::run`), else null.
 */
function outOfLineMemberKey(node: SyntaxNodeLike, headerEnd: number): string | null {
  const stack: SyntaxNodeLike[] = [...node.namedChildren].reverse();
  while (stack.length) {
    const current = stack.pop()!;
    if (current.startIndex >= headerEnd || /parameter/.test(current.type)) continue;
    if (current.type === "qualified_identifier") {
      const segments = current.text.split("::").map((segment) => segment.replace(/<.*$/s, "").trim());
      return [...lexicalScopePath(node), ...segments].join("::");
    }
    for (let index = current.namedChildren.length - 1; index >= 0; index -= 1)
      stack.push(current.namedChildren[index]!);
  }
  return null;
}

/** Caller node ids of the innermost enclosing declaration the graph models. */
function enclosingCallers(
  call: SyntaxNodeLike,
  file: string,
  visibleFiles: ReadonlySet<string>,
  callers: CallerIndex,
): string[] {
  const starts = callers.byFile.get(file);
  const owners: string[] = [];
  for (let node = call.parent; node; node = node.parent) {
    if (!CALLER_HEADER.test(node.type)) continue;
    // The caller's name sits in the header, before the body or value. Kotlin's `function_body`
    // (a block or `= expression`) is an unfielded child.
    const body =
      node.childForFieldName("body") ??
      node.childForFieldName("value") ??
      node.childForFieldName("right") ??
      node.namedChildren.find((child) => child.type === "function_body") ??
      null;
    // Without a body or value there is no header boundary, so nothing inside can be proven
    // to be the caller's name.
    if (!body || body.startIndex <= node.startIndex) continue;
    const headerEnd = body.startIndex;
    let found = false;
    for (const [start, id] of starts ?? []) {
      if (start >= node.startIndex && start < headerEnd && !(start >= call.startIndex && start < call.endIndex)) {
        owners.push(id);
        found = true;
      }
    }
    // A C++ out-of-line definition folds into its in-class prototype's node, which lives
    // elsewhere; the owner class, declared in this file or one it includes, identifies that node.
    const key = !found && body && node.type === "function_definition" ? outOfLineMemberKey(node, headerEnd) : null;
    // `listener = () => {...}` makes the function the value of an existing binding, which the
    // graph may record as the caller.
    const assignsFunction =
      /assignment/.test(node.type) && /function|arrow/.test(node.childForFieldName("right")?.type ?? "");
    const assigned = assignsFunction ? node.childForFieldName("left") : null;
    if (assigned && /identifier/.test(assigned.type))
      owners.push(...(callers.byFileName.get(file)?.get(assigned.text) ?? []));
    for (const member of key ? (callers.byOwnerMember.get(key) ?? []) : []) {
      if (visibleFiles.has(member.ownerFile)) owners.push(member.id);
    }
    // A function expression bound by a declarator or assignment (`var h = function named() {}`)
    // is one caller under either name, so the binding's header joins this level.
    const binder = node.parent;
    const boundValue = binder?.childForFieldName("value") ?? binder?.childForFieldName("right");
    if (binder && boundValue && boundValue.startIndex === node.startIndex && boundValue.endIndex === node.endIndex) {
      for (const [start, id] of starts ?? []) {
        if (start >= binder.startIndex && start < node.startIndex) owners.push(id);
      }
    }
    // Only the innermost graph caller owns the call; an outer function's edge for a call made in
    // a nested named function is misattributed.
    if (owners.length) return owners;
  }
  return owners;
}

/**
 * Call sites in a file: each call node with its callee name, plus `name(...)` inside a Rust macro
 * argument list, which the grammar keeps as an unparsed token tree. `inner!(...)` inside that list
 * is a nested macro, not a call.
 */
function* callSites(root: SyntaxNodeLike, source: string): Generator<{ call: SyntaxNodeLike; name: SyntaxNodeLike }> {
  const stack: SyntaxNodeLike[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    for (const child of node.namedChildren) stack.push(child);
    if (CALL_NODE_TYPES.has(node.type)) {
      const callee = calleeNode(node);
      // A computed callee such as `(options.wait ?? delay)(ms)` names no single declaration.
      if (callee && COMPUTED_CALLEE.test(callee.type)) continue;
      const name = calleeName(callee);
      if (name) yield { call: node, name };
      continue;
    }
    // Only a standard expression macro's arguments are proven expressions; other macros and
    // `macro_rules!` bodies are raw tokens.
    if (node.type !== "token_tree" || !rustTokenTreeHoldsExpressions(node)) continue;
    const children = node.namedChildren;
    for (let i = 0; i + 1 < children.length; i += 1) {
      const name = children[i]!;
      const args = children[i + 1]!;
      const adjacent = !source.slice(name.endIndex, args.startIndex).trim();
      if (name.type === "identifier" && args.type === "token_tree" && adjacent && args.text.startsWith("(")) {
        yield { call: args, name };
      }
    }
  }
}

/**
 * Whether the call's known argument count cannot be accepted by the declaration's parameters,
 * measured by the same shared arity helpers the graph uses.
 */
async function rejectsArgumentCount(
  definition: SymbolDef,
  call: SyntaxNodeLike,
  callerContext: ParsedFileContext,
): Promise<boolean> {
  const languageId = callerContext.sup.id;
  const argumentCount = getCallArgumentCount({ languageId, source: callerContext.source, call });
  if (argumentCount === null) return false;
  const target = await parseFile(definition.file);
  const start = definition.range.start.index ?? 0;
  let declaration: SyntaxNodeLike | null = target.tree.rootNode.descendantForIndex(
    start,
    definition.range.end.index ?? start,
  );
  while (declaration && !CALLABLE_DECLARATION_NODE_TYPES[declaration.type]) declaration = declaration.parent;
  if (!declaration) return false;
  const callable = declaration;
  // A type-qualified call can pass the receiver explicitly (`Self.helper(s)`), so exempt the call
  // only when neither receiver binding accepts the argument count.
  const rejects = (binding: "bound" | "unbound") => {
    const arity = getCallableArity({
      languageId: target.sup.id,
      source: target.source,
      declaration: callable,
      binding,
    });
    return !!arity && (argumentCount < arity.minArgs || (arity.maxArgs !== null && argumentCount > arity.maxArgs));
  };
  return rejects("bound") && rejects("unbound");
}

function includesFile(index: ProjectIndex, from: string, to: string): boolean {
  const module = index.byFile.get(fileIdentityKey(from));
  return !!module?.imports.some((imp) => typeof imp.resolved === "string" && normalizePath(imp.resolved) === to);
}

const LITERAL_VALUE =
  /^(number|integer|float|string|template_string|true|false|null|none|object|array|dictionary|list|tuple|[a-z_]*string_literal|[a-z_]*number_literal|integer_literal|boolean_literal)$/;

/** Whether a definition binds a literal value (`const value = 1`), which is never callable. */
async function initializedWithLiteral(definition: SymbolDef): Promise<boolean> {
  const target = await parseFile(definition.file);
  const start = definition.range.start.index ?? 0;
  const nameNode = target.tree.rootNode.descendantForIndex(start, definition.range.end.index ?? start);
  const binding = nameNode.parent;
  const value = binding?.childForFieldName("value") ?? binding?.childForFieldName("right");
  return !!value && value.startIndex > nameNode.startIndex && LITERAL_VALUE.test(value.type);
}

/** Whether a definition is a parameter or sits in a function body, from its source. */
async function declaredInsideCallable(definition: SymbolDef): Promise<boolean> {
  const target = await parseFile(definition.file);
  const start = definition.range.start.index ?? 0;
  const nameNode = target.tree.rootNode.descendantForIndex(start, definition.range.end.index ?? start);
  for (let current = nameNode.parent; current; current = current.parent) {
    if (/parameter/.test(current.type)) return true;
    const body = current.childForFieldName("body");
    const inBody = !!body && body.startIndex <= start && start < body.endIndex;
    if (inBody && CALLABLE_DECLARATION_NODE_TYPES[current.type]) return true;
  }
  return false;
}

export async function collectGraphNavigationMismatches(
  index: ProjectIndex,
  graph: DetailedSymbolGraph,
  root: string,
): Promise<GraphNavigationMismatch[]> {
  const normalizedRoot = normalizePath(root).replace(/\/$/, "");
  const relative = (file: string) => {
    const normalized = normalizePath(file);
    return normalized.startsWith(normalizedRoot + "/") ? normalized.slice(normalizedRoot.length + 1) : normalized;
  };
  const nodeLabel = (id: string) => {
    const node = graph.nodes.get(id);
    return node ? `${relative(node.file)}::${node.name}` : id;
  };
  const edgesByFile = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    if (!edge.site || (edge.label !== "calls" && edge.label !== "instantiates")) continue;
    const file = normalizePath(edge.site.file);
    const list = edgesByFile.get(file) ?? [];
    list.push(edge);
    edgesByFile.set(file, list);
  }
  const callers = await callerIndex(graph);
  const mismatches: GraphNavigationMismatch[] = [];

  for (const module of index.byFile.values()) {
    const file = normalizePath(module.file);
    let parsed: ParsedFileContext;
    try {
      parsed = await parseFile(file);
    } catch {
      continue;
    }
    const lines = parsed.source.split("\n");
    const fileEdges = edgesByFile.get(file) ?? [];
    // A C++ out-of-line definition folds into a class declared in any header its includes reach.
    const visibleFiles = new Set([
      file,
      ...module.imports.flatMap((imp) => (typeof imp.resolved === "string" ? [normalizePath(imp.resolved)] : [])),
      ...(parsed.sup.id === "cpp"
        ? cppStarImportClosure(index, module).map((reachable) => normalizePath(reachable.file))
        : []),
    ]);
    for (const { call, name: nameNode } of callSites(parsed.tree.rootNode, parsed.source)) {
      const owners = enclosingCallers(call, file, visibleFiles, callers);
      if (!owners.length) continue;
      const at = position(nameNode, parsed.source);
      if (!at) continue;
      // A call edge's site is the callee expression, which ends at the callee's name (`f`,
      // `a.f`, `A::f`, `new A.F`). An outer call's site that merely contains this name is not
      // this site.
      const covering = fileEdges.filter(
        (edge) =>
          owners.includes(edge.from) &&
          edge.site!.range.end.index === nameNode.endIndex &&
          (edge.site!.range.start.index ?? 0) <= nameNode.startIndex,
      );
      const site = `${relative(file)}:${at.line}:${at.column}`;
      const text = (lines[at.line - 1] ?? "").trim();
      const goto = await goToDefinition(index, { file, line: at.line, column: at.column }, parsed);
      if (goto.status !== "ok") {
        if (covering.length) {
          mismatches.push({ kind: "extra", site, text, graph: covering.map((edge) => nodeLabel(edge.to)) });
        }
        continue;
      }
      const targetId = defNodeId(goto.definition);
      const targetFile = normalizePath(goto.definition.file);
      const targetNode = graph.nodes.get(targetId);
      // Only C and C++ fold equivalent declarations (a header prototype and its source
      // definition) into one canonical node, and only across files joined by an include.
      const includeLinked = (other: string) =>
        other === targetFile || includesFile(index, targetFile, other) || includesFile(index, other, targetFile);
      const matches = (edge: Edge) => {
        if (edge.to === targetId) return true;
        const node = graph.nodes.get(edge.to);
        return (
          !targetNode &&
          (parsed.sup.id === "c" || parsed.sup.id === "cpp") &&
          node?.name === goto.definition.localName &&
          includeLinked(normalizePath(node.file))
        );
      };
      // Every edge at the site must name goto's declaration; one right edge beside a wrong one
      // is still a wrong edge.
      // No call edge can exist to a value that is not callable (an `int` class attribute) or to a
      // parameter or function-local binding, which the graph does not model.
      const notCallable = targetNode
        ? targetNode.kind === "variable" && !targetNode.callable
        : await declaredInsideCallable(goto.definition);
      // A binding whose value is a literal (`const value = 1`) cannot be called, so a `calls` edge to
      // it is wrong. A parameter or a variable holding a function can be called.
      const callsNonCallable =
        covering.some((edge) => edge.label === "calls") && (await initializedWithLiteral(goto.definition));
      if (!callsNonCallable && covering.length && covering.every(matches)) continue;
      if (!covering.length && notCallable) continue;
      // Navigation keeps an incompatible call on its only candidate so an in-progress signature
      // change still finds its callers; the graph may refuse that call as a `calls` edge.
      if (!covering.length && (await rejectsArgumentCount(goto.definition, call, parsed))) continue;
      const gotoLabel = `${relative(goto.definition.file)}::${goto.definition.localName}:${goto.definition.range.start.line}`;
      mismatches.push(
        covering.length
          ? { kind: "wrong", site, text, goto: gotoLabel, graph: covering.map((edge) => nodeLabel(edge.to)) }
          : { kind: "missing", site, text, goto: gotoLabel },
      );
    }
  }
  return mismatches.sort((a, b) => a.site.localeCompare(b.site));
}
