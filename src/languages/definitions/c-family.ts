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

export const cFamilyIncludeQuery = `
      (preproc_include path: (string_literal) @from) @stmt
      (preproc_include path: (system_lib_string) @from) @stmt
      (preproc_include path: (identifier) @from) @stmt
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
    // Keep scope/storage evidence even when the native syntax-tree projection is unavailable.
    `(compound_statement) @export_scope`,
    `((declaration (storage_class_specifier) @storage) @private_declaration (#eq? @storage "static"))`,
    `((function_definition (storage_class_specifier) @storage) @private_declaration (#eq? @storage "static"))`,
    `(function_definition ${functionNameQuery}) @declaration`,
    `(declaration ${functionNameQuery}) @declaration`,
    `(struct_specifier name: (type_identifier) @name)`,
    `(enum_specifier name: (type_identifier) @name)`,
    `(type_definition declarator: (_) @declarator)`,
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
    // Resolve the declarator chain in the consumer, without a fixed pointer/array depth.
    `(type_definition declarator: (_) @declarator)`,
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
  extraSymbolQueries?: readonly string[];
  usesQueryDrivenLocals?: boolean;
  membersAreImplicitlyInScope?: boolean;
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
      imports: cFamilyIncludeQuery,
      exports: joinQueryPatterns([
        ...cFamilyCoreExportQueries(graphFunctionNameQuery),
        ...(options.extraSymbolQueries ?? []),
      ]),
      locals: joinQueryPatterns([
        ...cFamilyCoreLocalQueries(graphFunctionNameQuery),
        ...(options.extraSymbolQueries ?? []),
      ]),
      importBindings: cFamilyIncludeQuery,
    },
    nodeTypes: options.nodeTypes,
    classifyDefinition: options.classifyDefinition,
    isDeclarationName: options.isDeclarationName,
    scopeDeclarationNames: "all",
    createsFunctionScope: options.createsFunctionScope,
    createsBlockScope: (node) => node.type === "compound_statement",
    supportsCrossModuleSymbols: true,
    // A name declared inside a function body or a class/struct/union body is not a module
    // export. C and C++ spell that type body `field_declaration_list`, not `class_body`.
    // The exports query cannot anchor on `translation_unit` because include guards nest
    // every header declaration.
    exportScopeBlockers: ["compound_statement", "field_declaration_list"],
    usesQueryDrivenLocals: options.usesQueryDrivenLocals || false,
    ...(options.membersAreImplicitlyInScope !== undefined
      ? { membersAreImplicitlyInScope: options.membersAreImplicitlyInScope }
      : {}),
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

/** True when `node` sits inside the `name` field of a parent of one of the listed types. */
export function isSpecifierNameField(node: SyntaxNodeLike, specifierTypes: readonly string[]): boolean {
  const parent = node.parent;
  return !!parent && specifierTypes.includes(parent.type) && isInField(node, parent, "name");
}

/**
 * Declarator-chain and preprocessor declaration checks shared by C and C++: parameter, field,
 * initializer, typedef, function, and plain declarations name their declarator, and enumerator
 * and preprocessor definitions carry a `name` field.
 */
export function cFamilyIsDeclarationName(node: SyntaxNodeLike): boolean {
  if (
    isInAncestorDeclarator(node, new Set(["parameter_declaration"])) ||
    isInAncestorDeclarator(node, new Set(["field_declaration"])) ||
    isInAncestorDeclarator(node, new Set(["init_declarator"])) ||
    isInAncestorDeclarator(node, new Set(["type_definition"]))
  )
    return true;
  if (isInAncestorDeclarator(node, new Set(["function_definition"])) && !isInParameterList(node)) return true;
  if (isInAncestorDeclarator(node, new Set(["declaration"])) && !isInParameterList(node)) return true;
  return isSpecifierNameField(node, ["enumerator", "preproc_def", "preproc_function_def"]);
}

/**
 * Container-walk classification shared by C and C++: a name inside a function body is a
 * function, one inside a declaration with a function declarator is a function, and
 * `typedef int (*Comparator)(int, int);` wraps the typedef name in a declarator chain, so the
 * direct-parent checks above cannot see it.
 */
export function cFamilyContainerClassifyDefinition(node: SyntaxNodeLike): string {
  const container = findAncestor(node, cFamilyContainerTypes);
  if (container?.type === "function_definition") return "function";
  if (container?.type === "declaration" && isFunctionDeclarator(node)) return "function";
  if (container?.type === "type_definition") return "type";
  return "variable";
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
