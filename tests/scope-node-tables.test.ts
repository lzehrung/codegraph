import { describe, expect, it } from "vitest";
import { buildScopeIndexFromSource } from "../src/indexer/scope.js";
import { SCOPE_NODE_ROWS, scopeNodesFor, type ScopeNodeRow } from "../src/indexer/scope-nodes.js";
import { getNativeSingleQueryExecution, getNativeSyntaxTreeExecution } from "../src/native/execution.js";
import { ProjectedSyntaxTree } from "../src/native/projected-tree.js";
import { getNativeTreeSitterSupportedLanguageIds } from "../src/native/runtime.js";
import { LANGUAGE_SUPPORTS, supportById, type LanguageSupport } from "../src/languages.js";
import type { SyntaxNodeLike } from "../src/languages/types.js";

/**
 * `src/indexer/scope-nodes.ts` holds every node-name list the scope walker used to inline. These
 * cases re-derive the table's claims from the pinned grammar: whether a grammar has a node type, or
 * a `name` field of a given identifier type, is decided by compiling a query against that
 * language's own grammar, so a row that drifts from the grammar fails here.
 */

/** Node type names a pinned grammar could use for a node that opens a function scope. */
const FUNCTION_SCOPE_CANDIDATES = [
  "anonymous_function",
  "arrow_function",
  "constructor_declaration",
  "deinit_declaration",
  "destructor_declaration",
  "func_literal",
  "function",
  "function_declaration",
  "function_definition",
  "function_expression",
  "function_item",
  "generator_function",
  "generator_function_declaration",
  "init_declaration",
  "lambda",
  "lambda_expression",
  "lambda_literal",
  "local_function_statement",
  "method",
  "method_declaration",
  "method_definition",
  "singleton_method",
  "subscript_declaration",
];

const NATIVE_LANGUAGE_IDS = new Set(getNativeTreeSitterSupportedLanguageIds("on"));

function grammarQueryCompiles(support: LanguageSupport, query: string): boolean {
  const execution = getNativeSingleQueryExecution("", support, query, "on");
  if (execution.matches) return true;
  if (execution.fallbackReason === "queryFailure" || execution.fallbackReason === "unsupportedLanguage") {
    return false;
  }
  throw new Error(`${support.id}: native grammar probe failed (${execution.fallbackReason}: ${execution.error ?? ""})`);
}

function grammarNameFieldBindsIdentifier(support: LanguageSupport, nodeType: string): boolean {
  return support.nodeTypes.identifier.some((identifierType) =>
    grammarQueryCompiles(support, `(${nodeType} name: (${identifierType})) @x`),
  );
}

let probeNodeId = 0;

function probeNode(type: string): SyntaxNodeLike {
  return {
    id: (probeNodeId += 1),
    type,
    text: type,
    startIndex: 0,
    endIndex: 0,
    startPosition: { row: 0, column: 0 },
    endPosition: { row: 0, column: 0 },
    parent: null,
    namedChildren: [],
    child: () => null,
    childForFieldName: () => null,
  };
}

/** A node of `parentType` whose `name` field holds a node of `nameType`, as a hook predicate sees it. */
function declarationNode(parentType: string, nameType: string): { declaration: SyntaxNodeLike; name: SyntaxNodeLike } {
  const name = probeNode(nameType);
  const declaration = probeNode(parentType);
  name.parent = declaration;
  declaration.namedChildren.push(name);
  declaration.childForFieldName = (field) => (field === "name" ? name : null);
  return { declaration, name };
}

/** Set-valued row fields. The coverage case below keeps this list in step with `ScopeNodeRow`. */
const SCOPE_NODE_LIST_FIELDS = [
  "assignmentDeclarationTypes",
  "assignmentIdentifierTypes",
  "childSkipNameTypes",
  "classNameTypes",
  "declarationPatternTypes",
  "destructuringObjectPatternTypes",
  "destructuringPairPatternTypes",
  "destructuringShorthandTypes",
  "destructuringTypeFieldTypes",
  "enumAssignmentTypes",
  "enumBodyMemberTypes",
  "enumBodyParentTypes",
  "enumMemberLocalTypes",
  "enumMemberTypes",
  "functionNameTypes",
  "hoistedFunctionTypes",
  "hoistedVariableDeclarationTypes",
  "memberContainerTypes",
  "memberFunctionTypes",
  "moduleRootTypes",
  "parameterParents",
  "patternBindingTypes",
  "shortVariableDeclarationTypes",
  "typeNameTypes",
  "typeParameterTypes",
  "typeScopeTypes",
  "unnamedFunctionScopeTypes",
  "variableDeclarationTypes",
  "variableDeclaratorTypes",
] as const satisfies ReadonlyArray<keyof ScopeNodeRow>;

/** Row fields that hold a call or declaration shape rather than a bare node-type list. */
const SCOPE_NODE_SHAPE_FIELDS = new Set<string>(["requireCall", "namelessVariableDeclaration", "scopedEnum"]);

function declaredNodeTypeLists(row: ScopeNodeRow): Array<{ field: string; types: ReadonlySet<string> }> {
  const lists: Array<{ field: string; types: ReadonlySet<string> }> = [];
  for (const field of SCOPE_NODE_LIST_FIELDS) {
    const types = row[field];
    if (types) lists.push({ field, types });
  }
  if (row.requireCall) lists.push({ field: "requireCall.callTypes", types: row.requireCall.callTypes });
  if (row.namelessVariableDeclaration) {
    lists.push({
      field: "namelessVariableDeclaration.declarationTypes",
      types: row.namelessVariableDeclaration.declarationTypes,
    });
  }
  if (row.scopedEnum) {
    lists.push({ field: "scopedEnum.enumDeclarationTypes", types: row.scopedEnum.enumDeclarationTypes });
  }
  return lists;
}

function parseProbeSource(languageId: string, source: string): SyntaxNodeLike {
  const support = supportById(languageId)!;
  const execution = getNativeSyntaxTreeExecution(source, support, "on");
  if (!execution.tree) {
    throw new Error(`${languageId}: no syntax tree (${execution.fallbackReason}: ${execution.error ?? ""})`);
  }
  return new ProjectedSyntaxTree(source, execution.tree).rootNode;
}

function collectNodes(root: SyntaxNodeLike, type: string): SyntaxNodeLike[] {
  const matches: SyntaxNodeLike[] = [];
  const visit = (node: SyntaxNodeLike): void => {
    if (node.type === type) matches.push(node);
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);
  return matches;
}

/**
 * Function-scope node types the grammar gives an identifier-typed `name` field, but which bind no
 * name. The first group's `name` field holds the containing declaration's own name; the second
 * group's field holds something that is not an identifier at all.
 */
const UNNAMED_FUNCTION_SCOPE_FIXTURES = [
  {
    languageId: "java",
    nodeType: "constructor_declaration",
    source: "class Probe {\n  Probe() {}\n}\n",
    bindsContainerName: true,
  },
  {
    languageId: "csharp",
    nodeType: "constructor_declaration",
    source: "class Probe {\n  Probe() {}\n}\n",
    bindsContainerName: true,
  },
  {
    languageId: "csharp",
    nodeType: "destructor_declaration",
    source: "class Probe {\n  ~Probe() {}\n}\n",
    bindsContainerName: true,
  },
  {
    languageId: "kotlin",
    nodeType: "lambda_literal",
    source: "fun main() {\n  val f = { x: Int -> x }\n}\n",
    bindsContainerName: false,
  },
  {
    languageId: "swift",
    nodeType: "init_declaration",
    source: "class Probe {\n  init() {}\n}\n",
    bindsContainerName: false,
  },
  {
    languageId: "swift",
    nodeType: "subscript_declaration",
    source: "class Probe {\n  subscript(i: Int) -> Int { return i }\n}\n",
    bindsContainerName: false,
  },
];

const ZIG_CONTAINER_SOURCE = [
  "const Self = struct {",
  "    pub fn helper() void {}",
  "    pub fn caller() void { helper(); }",
  "};",
  "",
].join("\n");

describe("scope node tables", () => {
  it("declares a row for every registered language and nothing else", () => {
    const registeredIds = LANGUAGE_SUPPORTS.map((support) => support.id).sort();
    expect(NATIVE_LANGUAGE_IDS.size).toBeGreaterThan(0);
    expect(Object.keys(SCOPE_NODE_ROWS).sort()).toEqual(registeredIds);
    expect(scopeNodesFor("not-a-registered-language")).toEqual({});
  });

  it("declares only node types the pinned grammar produces", () => {
    for (const support of LANGUAGE_SUPPORTS) {
      const row = scopeNodesFor(support.id);
      for (const field of Object.keys(row)) {
        if (SCOPE_NODE_SHAPE_FIELDS.has(field)) continue;
        expect(SCOPE_NODE_LIST_FIELDS, `${support.id}.${field} is not a probed list field`).toContain(field);
      }
      const lists = declaredNodeTypeLists(row);
      if (!NATIVE_LANGUAGE_IDS.has(support.id)) {
        // The scope walker needs a native tree, so these languages never reach it; their rows must
        // not claim node names that nothing can verify.
        expect(lists, `${support.id} has no native grammar`).toEqual([]);
        continue;
      }
      for (const { field, types } of lists) {
        for (const nodeType of types) {
          expect(
            grammarQueryCompiles(support, `(${nodeType}) @x`),
            `${support.id}.${field} declares ${nodeType}, which its grammar does not have`,
          ).toBe(true);
        }
      }
    }
  });

  it("registers a name for every function-scope node type, or says why not", () => {
    const probedNodeTypes = new Set(FUNCTION_SCOPE_CANDIDATES);
    for (const [languageId, row] of Object.entries(SCOPE_NODE_ROWS)) {
      const declared = [...(row.functionNameTypes ?? []), ...(row.unnamedFunctionScopeTypes ?? [])];
      for (const nodeType of declared) {
        expect(
          probedNodeTypes.has(nodeType),
          `${languageId}: ${nodeType} is not probed by FUNCTION_SCOPE_CANDIDATES`,
        ).toBe(true);
      }
    }
    for (const support of LANGUAGE_SUPPORTS) {
      const row = scopeNodesFor(support.id);
      for (const nodeType of FUNCTION_SCOPE_CANDIDATES) {
        if (!grammarQueryCompiles(support, `(${nodeType}) @x`)) continue;
        const { declaration, name } = declarationNode(nodeType, support.nodeTypes.identifier[0] ?? "identifier");
        const createsFunctionScope = support.createsFunctionScope(declaration);
        if (row.unnamedFunctionScopeTypes?.has(nodeType)) {
          expect(
            createsFunctionScope,
            `${support.id}: ${nodeType} is declared without a name but does not create a function scope`,
          ).toBe(true);
          expect(
            row.functionNameTypes?.has(nodeType) ?? false,
            `${support.id}: ${nodeType} is declared both name-registering and unnamed`,
          ).toBe(false);
        }
        if (!createsFunctionScope) continue;
        if (!grammarNameFieldBindsIdentifier(support, nodeType)) continue;
        const registersOwnNameFromHooks = support.scopeDeclarationNames(name) && support.isDeclarationName(name);
        const registersName =
          (row.functionNameTypes?.has(nodeType) ?? false) ||
          (row.unnamedFunctionScopeTypes?.has(nodeType) ?? false) ||
          registersOwnNameFromHooks;
        expect(
          registersName,
          `${support.id}: ${nodeType} creates a function scope without a name-registration entry`,
        ).toBe(true);
      }
    }
  });

  it("verifies each deliberately unnamed function scope against its grammar", () => {
    for (const fixture of UNNAMED_FUNCTION_SCOPE_FIXTURES) {
      const support = supportById(fixture.languageId)!;
      const declared = scopeNodesFor(fixture.languageId).unnamedFunctionScopeTypes;
      expect(
        declared?.has(fixture.nodeType) ?? false,
        `${fixture.languageId}.unnamedFunctionScopeTypes must list ${fixture.nodeType}`,
      ).toBe(true);

      const nodes = collectNodes(parseProbeSource(fixture.languageId, fixture.source), fixture.nodeType);
      expect(nodes, `${fixture.languageId}: ${fixture.nodeType} did not parse`).not.toHaveLength(0);
      for (const node of nodes) {
        const nameNode = node.childForFieldName("name");
        if (!fixture.bindsContainerName) {
          const bindsIdentifierName = nameNode !== null && support.nodeTypes.identifier.includes(nameNode.type);
          expect(bindsIdentifierName, `${fixture.languageId}: ${fixture.nodeType} binds an identifier name`).toBe(
            false,
          );
          continue;
        }
        let container = node.parent;
        while (container && container.childForFieldName("name") === null) container = container.parent;
        expect(nameNode?.text, `${fixture.languageId}: ${fixture.nodeType} name`).toBe(
          container?.childForFieldName("name")?.text,
        );
      }
    }
  });

  it("keeps Zig container member function names out of the file scope", () => {
    const support = supportById("zig")!;
    const scope = buildScopeIndexFromSource("self.zig", ZIG_CONTAINER_SOURCE, support);

    expect(scope.bindings.has("Self")).toBe(true);
    expect(scope.bindings.has("helper")).toBe(false);
    expect(scope.bindings.has("caller")).toBe(false);
  });

  it("keeps member function names out of the enclosing scope", () => {
    // `memberFunctionTypes` decides this: Go method names must stay out of the file scope, because
    // Go has no implicit member scope and Zig's container rule is the same shape. A row that drops
    // the entry registers the method name in the file scope instead.
    const go = buildScopeIndexFromSource("probe.go", "package probe\n\nfunc (t T) helper() {}\n", supportById("go")!);
    expect(go.bindings.has("helper")).toBe(false);
    const goTopLevel = buildScopeIndexFromSource(
      "probe.go",
      "package probe\n\nfunc topLevel() {}\n",
      supportById("go")!,
    );
    expect(goTopLevel.bindings.has("topLevel")).toBe(true);

    // An object-literal method is a member function for the ECMAScript family, so it registers no
    // lexical binding either; the surrounding variable still does.
    const js = buildScopeIndexFromSource("probe.js", "const o = { method() {} };\n", supportById("js")!);
    expect(js.bindings.has("method")).toBe(false);
    expect(js.bindings.has("o")).toBe(true);
  });
});
