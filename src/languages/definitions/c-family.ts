import type { BlockDefinition, LanguageDefinition, SyntaxNodeLike } from "../types.js";

export const cFamilyContainerTypes = new Set([
  "function_definition",
  "declaration",
  "parameter_declaration",
  "field_declaration",
  "type_definition",
  "init_declarator",
]);

export const cFamilyControlSplitPoints = [
  "if_statement",
  "for_statement",
  "while_statement",
  "do_statement",
  "switch_statement",
  "case_statement",
];

export const cFamilyIncludeImportsQuery = `
      (preproc_include path: (string_literal) @mod) @stmt
      (preproc_include path: (system_lib_string) @mod) @stmt
      (preproc_include path: (call_expression) @mod) @stmt
      ((preproc_include path: (identifier) @mod) @stmt
        (#match? @stmt "^\\s*#include\\s+[A-Za-z_][A-Za-z0-9_]*\\s*$"))
    `;

export const cFamilyIncludeBindingsQuery = `
      (preproc_include path: (string_literal) @from) @stmt
      (preproc_include path: (system_lib_string) @from) @stmt
      (preproc_include path: (call_expression) @from) @stmt
      ((preproc_include path: (identifier) @from) @stmt
        (#match? @stmt "^\\s*#include\\s+[A-Za-z_][A-Za-z0-9_]*\\s*$"))
    `;

const cFamilyParameterListTypes = new Set(["parameter_declaration", "parameter_list"]);

export function cFunctionNameQuery(captureName: string, includeFieldIdentifier: boolean): string {
  const identifierTypes = includeFieldIdentifier ? ["identifier", "field_identifier"] : ["identifier"];
  const patterns: string[] = [];
  for (const identifierType of identifierTypes) {
    patterns.push(`(function_declarator declarator: (${identifierType}) @${captureName})`);
    patterns.push(
      `(function_declarator declarator: (pointer_declarator declarator: (${identifierType}) @${captureName}))`,
    );
    patterns.push(
      `(pointer_declarator declarator: (function_declarator declarator: (${identifierType}) @${captureName}))`,
    );
    patterns.push(
      `(function_declarator declarator: (parenthesized_declarator (pointer_declarator declarator: (${identifierType}) @${captureName})))`,
    );
  }
  if (includeFieldIdentifier) {
    patterns.push(
      `(function_declarator declarator: (qualified_identifier name: (identifier) @${captureName}))`,
      `(function_declarator declarator: (qualified_identifier name: (destructor_name) @${captureName}))`,
      `(function_declarator declarator: (qualified_identifier name: (operator_name) @${captureName}))`,
      `(function_declarator declarator: (qualified_identifier name: (template_function name: (identifier) @${captureName})))`,
      `(function_declarator declarator: (destructor_name) @${captureName})`,
      `(function_declarator declarator: (operator_name) @${captureName})`,
      `(reference_declarator (function_declarator declarator: (qualified_identifier name: (identifier) @${captureName})))`,
      `(reference_declarator (function_declarator declarator: (qualified_identifier name: (destructor_name) @${captureName})))`,
      `(reference_declarator (function_declarator declarator: (qualified_identifier name: (operator_name) @${captureName})))`,
      `(reference_declarator (function_declarator declarator: (operator_name) @${captureName}))`,
    );
  }
  return `
  declarator: [
    ${patterns.join("\n    ")}
  ]
`;
}

/**
 * Module-scope exports. These patterns are NOT anchored on `translation_unit`: a header wraps its
 * declarations in an include guard, so the anchor would have to enumerate every preprocessor
 * nesting depth. `exportScopeBlockers` drops any capture inside a function body instead.
 */
export function cFamilyCoreExportQueries(functionNameQuery: string): string[] {
  return [
    `(function_definition ${functionNameQuery}) @declaration`,
    `(declaration ${functionNameQuery}) @declaration`,
    `(struct_specifier name: (type_identifier) @name)`,
    `(enum_specifier name: (type_identifier) @name)`,
    `(type_definition declarator: (type_identifier) @name)`,
    `(type_definition declarator: (function_declarator declarator: (parenthesized_declarator (pointer_declarator declarator: (type_identifier) @name))))`,
    `(type_definition declarator: (pointer_declarator declarator: (type_identifier) @name))`,
    `((declaration type: (_) @type declarator: (identifier) @name) @declaration
      (#not-match? @type "^(import|export)$"))`,
    `((declaration type: (_) @type declarator: (init_declarator declarator: (identifier) @name)) @declaration
      (#not-match? @type "^(import|export)$"))`,
  ];
}

export function cFamilyCoreLocalQueries(functionNameQuery: string): string[] {
  return [
    `(function_definition ${functionNameQuery})`,
    // A prototype is a `declaration`, not a `function_definition`; without this a header that only
    // declares its API has no function locals at all.
    `(declaration ${functionNameQuery})`,
    `(struct_specifier name: (type_identifier) @name)`,
    `(enum_specifier name: (type_identifier) @name)`,
    `(type_definition declarator: (type_identifier) @name)`,
    // `typedef int (*Comparator)(int, int);` and `typedef int *IntPtr;` wrap the typedef name in a
    // declarator chain rather than exposing it directly.
    `(type_definition declarator: (function_declarator declarator: (parenthesized_declarator (pointer_declarator declarator: (type_identifier) @name))))`,
    `(type_definition declarator: (pointer_declarator declarator: (type_identifier) @name))`,
    `(declaration declarator: (identifier) @name)`,
    `(declaration declarator: (init_declarator declarator: (identifier) @name))`,
    `(parameter_declaration declarator: (identifier) @name)`,
    `(field_declaration declarator: (field_identifier) @name)`,
  ];
}

export function joinQueryPatterns(patterns: readonly string[]): string {
  return `
      ${patterns.join("\n      ")}
    `;
}

export type CFamilyLanguageDefinitionOptions = {
  id: string;
  extensions: string[];
  includeFieldIdentifier: boolean;
  blocks: (functionNameQuery: string) => BlockDefinition[];
  splitPoints?: readonly string[];
  extraExportQueries?: readonly string[];
  extraLocalQueries?: readonly string[];
  usesQueryDrivenLocals?: boolean;
  nodeTypes: NonNullable<LanguageDefinition["nodeTypes"]>;
  classifyDefinition: NonNullable<LanguageDefinition["classifyDefinition"]>;
  isDeclarationName: NonNullable<LanguageDefinition["isDeclarationName"]>;
  createsFunctionScope: NonNullable<LanguageDefinition["createsFunctionScope"]>;
};

export function cFamilyBlock(type: string, nameQuery: string, captureId: string): BlockDefinition {
  return {
    type,
    nameQuery,
    captureId,
  };
}

export function cFamilyFunctionBlock(functionNameQuery: string): BlockDefinition {
  return cFamilyBlock("function_definition", functionNameQuery, "function");
}

export function cFamilyTypeIdentifierBlock(type: string, captureId: string): BlockDefinition {
  return cFamilyBlock(type, "name: (type_identifier) @chunk.name", captureId);
}

export function createCFamilyLanguageDefinition(options: CFamilyLanguageDefinitionOptions): LanguageDefinition {
  const functionNameQuery = cFunctionNameQuery("chunk.name", options.includeFieldIdentifier);
  const graphFunctionNameQuery = cFunctionNameQuery("name", options.includeFieldIdentifier);
  return {
    id: options.id,
    extensions: [...options.extensions],
    structure: {
      blocks: options.blocks(functionNameQuery),
      splitPoints: [...(options.splitPoints ?? cFamilyControlSplitPoints)],
      comments: ["comment"],
    },
    graph: {
      imports: cFamilyIncludeImportsQuery,
      exports: joinQueryPatterns([
        ...cFamilyCoreExportQueries(graphFunctionNameQuery),
        ...(options.extraExportQueries ?? []),
      ]),
      locals: joinQueryPatterns([
        ...cFamilyCoreLocalQueries(graphFunctionNameQuery),
        ...(options.extraLocalQueries ?? []),
      ]),
      importBindings: cFamilyIncludeBindingsQuery,
    },
    nodeTypes: options.nodeTypes,
    classifyDefinition: options.classifyDefinition,
    isDeclarationName: options.isDeclarationName,
    scopeDeclarationNames: "all",
    createsFunctionScope: options.createsFunctionScope,
    createsBlockScope: (node) => node.type === "compound_statement",
    supportsCrossModuleSymbols: true,
    // A name declared inside a function body is not a module export. The exports query cannot
    // anchor on `translation_unit` because include guards nest every header declaration.
    exportScopeBlockers: ["compound_statement"],
    usesQueryDrivenLocals: options.usesQueryDrivenLocals || false,
  };
}

export function isWithin(node: SyntaxNodeLike, ancestor: SyntaxNodeLike | null): boolean {
  let current: SyntaxNodeLike | null = node;
  while (current) {
    if (ancestor && current.id === ancestor.id) return true;
    current = current.parent;
  }
  return false;
}

export function isInField(node: SyntaxNodeLike, parent: SyntaxNodeLike, field: string): boolean {
  return isWithin(node, parent.childForFieldName(field));
}

export function findAncestor(node: SyntaxNodeLike, types: Set<string>): SyntaxNodeLike | null {
  let current: SyntaxNodeLike | null = node.parent;
  while (current) {
    if (types.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

export function isInParameterList(node: SyntaxNodeLike): boolean {
  return !!findAncestor(node, cFamilyParameterListTypes);
}

function resolveDeclaratorRoot(ancestor: SyntaxNodeLike): SyntaxNodeLike | null {
  let declaratorNode = ancestor.childForFieldName("declarator");
  if (!declaratorNode) return null;
  if (declaratorNode.type === "init_declarator") {
    const inner = declaratorNode.childForFieldName("declarator");
    if (inner) declaratorNode = inner;
  }
  if (declaratorNode.type === "function_declarator") {
    const inner = declaratorNode.childForFieldName("declarator");
    if (inner) declaratorNode = inner;
  }
  return declaratorNode;
}

export function isInAncestorDeclarator(node: SyntaxNodeLike, ancestorTypes: Set<string>): boolean {
  const ancestor = findAncestor(node, ancestorTypes);
  if (!ancestor) return false;
  const declaratorNode = resolveDeclaratorRoot(ancestor);
  if (!declaratorNode) return false;
  return isWithin(node, declaratorNode);
}

export function isFunctionDeclarator(node: SyntaxNodeLike): boolean {
  let current: SyntaxNodeLike | null = node.parent;
  while (current) {
    if (current.type === "function_declarator") return true;
    if (cFamilyContainerTypes.has(current.type)) return false;
    current = current.parent;
  }
  return false;
}
