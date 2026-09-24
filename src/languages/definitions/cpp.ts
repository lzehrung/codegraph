import { registerLanguage } from "../registry.js";
import { nodeTypeIn } from "./shared.js";
import {
  cFamilyBlock,
  cFamilyContainerClassifyDefinition,
  cFamilyControlSplitPoints,
  cFamilyFunctionBlock,
  cFamilyIsDeclarationName,
  cFamilyTypeIdentifierBlock,
  createCFamilyLanguageDefinition,
  findAncestor,
  isInField,
  isSpecifierNameField,
} from "./c-family.js";

export const CPP_DEF = createCFamilyLanguageDefinition({
  id: "cpp",
  // Module-interface units use `.cppm`/`.ixx`/`.mxx` by convention; without them a declared
  // `export module foo;` is never discovered, so a first-party `import foo;` stays external.
  extensions: [".cc", ".cpp", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".ipp", ".tpp", ".inl", ".cppm", ".ixx", ".mxx"],
  includeFieldIdentifier: true,
  usesQueryDrivenLocals: true,
  membersAreImplicitlyInScope: true,
  blocks: (functionNameQuery) => [
    cFamilyFunctionBlock(functionNameQuery),
    cFamilyTypeIdentifierBlock("class_specifier", "class"),
    cFamilyTypeIdentifierBlock("struct_specifier", "struct"),
    cFamilyTypeIdentifierBlock("enum_specifier", "enum"),
    cFamilyBlock("namespace_definition", "name: (namespace_identifier) @chunk.name", "namespace"),
    cFamilyTypeIdentifierBlock("alias_declaration", "type"),
    cFamilyBlock("type_definition", "declarator: (type_identifier) @chunk.name", "type"),
  ],
  splitPoints: [...cFamilyControlSplitPoints, "try_statement", "catch_clause"],
  extraSymbolQueries: [
    `(class_specifier name: (type_identifier) @name)`,
    `(class_specifier name: (template_type name: (type_identifier) @name))`,
    `(union_specifier name: (type_identifier) @name)`,
    `(enumerator name: (identifier) @name)`,
    `(namespace_definition name: (namespace_identifier) @name)`,
    `(namespace_definition name: (nested_namespace_specifier (namespace_identifier) @name))`,
    `(alias_declaration name: (type_identifier) @name)`,
    `(concept_definition name: (identifier) @name)`,
    `(preproc_def name: (identifier) @name)`,
    `(preproc_function_def name: (identifier) @name)`,
    `(class_specifier body: (field_declaration_list (field_declaration declarator: (function_declarator declarator: (field_identifier) @name))))`,
    `(struct_specifier body: (field_declaration_list (field_declaration declarator: (function_declarator declarator: (field_identifier) @name))))`,
    `(union_specifier body: (field_declaration_list (field_declaration declarator: (function_declarator declarator: (field_identifier) @name))))`,
    `(class_specifier body: (field_declaration_list (field_declaration declarator: (reference_declarator (function_declarator declarator: (operator_name) @name)))))`,
    `(struct_specifier body: (field_declaration_list (field_declaration declarator: (reference_declarator (function_declarator declarator: (operator_name) @name)))))`,
    `(union_specifier body: (field_declaration_list (field_declaration declarator: (reference_declarator (function_declarator declarator: (operator_name) @name)))))`,
    `(class_specifier body: (field_declaration_list (declaration declarator: (function_declarator declarator: (destructor_name) @name))))`,
    `(struct_specifier body: (field_declaration_list (declaration declarator: (function_declarator declarator: (destructor_name) @name))))`,
    `(union_specifier body: (field_declaration_list (declaration declarator: (function_declarator declarator: (destructor_name) @name))))`,
    `(module_declaration name: (module_name) @name)`,
  ],
  nodeTypes: {
    identifier: ["identifier", "field_identifier", "type_identifier", "namespace_identifier"],
    propertyIdentifier: ["field_identifier", "identifier"],
    memberExpression: "field_expression",
  },
  classifyDefinition: (node) => {
    const parent = node.parent;
    if (!parent) return "variable";
    if (parent.type === "enum_specifier") return "type";
    if (
      parent.type === "class_specifier" ||
      parent.type === "struct_specifier" ||
      parent.type === "union_specifier" ||
      parent.type === "namespace_definition" ||
      parent.type === "nested_namespace_specifier" ||
      parent.type === "module_declaration"
    )
      return "class";
    if (parent.type === "module_name") {
      const moduleDeclaration = findAncestor(node, new Set(["module_declaration"]));
      if (moduleDeclaration) return "class";
    }
    if (
      parent.type === "alias_declaration" ||
      (parent.type === "type_definition" && isInField(node, parent, "declarator"))
    )
      return "type";
    return cFamilyContainerClassifyDefinition(node);
  },
  isDeclarationName: (node) => {
    if (isSpecifierNameField(node, ["class_specifier", "struct_specifier", "union_specifier", "enum_specifier"]))
      return true;
    const parent = node.parent;
    if (!parent) return false;
    if (parent.type === "namespace_definition" && isInField(node, parent, "name")) return true;
    if (parent.type === "module_declaration" && isInField(node, parent, "name")) return true;
    if (parent.type === "module_name") {
      const moduleDeclaration = findAncestor(node, new Set(["module_declaration"]));
      if (moduleDeclaration && isInField(node, moduleDeclaration, "name")) return true;
    }
    if (parent.type === "nested_namespace_specifier") {
      const namespaceDefinition = findAncestor(node, new Set(["namespace_definition"]));
      if (namespaceDefinition && isInField(node, namespaceDefinition, "name")) return true;
    }
    if (parent.type === "alias_declaration" && isInField(node, parent, "name")) return true;
    if (parent.type === "concept_definition" && isInField(node, parent, "name")) return true;
    if (
      parent.type === "qualified_identifier" &&
      parent.parent?.type === "using_declaration" &&
      isInField(node, parent, "name")
    )
      return true;
    return cFamilyIsDeclarationName(node);
  },
  createsFunctionScope: nodeTypeIn(["function_definition", "lambda_expression"]),
});

const cppModuleQuery = `
      (import_declaration name: (module_name) @from) @stmt
      (import_declaration header: (string_literal) @from) @stmt
      (import_declaration header: (system_lib_string) @from) @stmt
    `;
CPP_DEF.graph.imports += cppModuleQuery;
CPP_DEF.graph.importBindings += cppModuleQuery;

registerLanguage(CPP_DEF);
