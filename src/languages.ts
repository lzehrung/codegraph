import path from "node:path";
import Parser from "tree-sitter";
import tsGrammars from "tree-sitter-typescript";
import JavaScript from "tree-sitter-javascript";
import PythonLang from "tree-sitter-python";

export type IdentifierNodeType = string;

export type LanguageSupport = {
  id: string;
  matchExts: string[];
  language: (filename: string) => Parser.Language;
  nodeTypes: {
    identifier: IdentifierNodeType[];
    propertyIdentifier?: IdentifierNodeType[];
    shorthandPropertyIdentifier?: IdentifierNodeType[];
    memberExpression?: string;
  };
  queries: {
    imports: string;
    exports: string;
    locals: string;
    importBindings: string;
  };
  classifyDefinition: (nameNode: Parser.SyntaxNode) => any;
  isDeclarationName: (node: Parser.SyntaxNode) => boolean;
  createsBlockScope: (node: Parser.SyntaxNode) => boolean;
  createsFunctionScope: (node: Parser.SyntaxNode) => boolean;
  supportsCrossModuleSymbols: boolean;
};

const LangTS = (tsGrammars as any).typescript as Parser.Language;
const LangTSX = (tsGrammars as any).tsx as Parser.Language;
const LangJS = JavaScript as unknown as Parser.Language;

export const TS_SUPPORT: LanguageSupport = {
  id: "ts",
  matchExts: [".ts", ".tsx", ".mts", ".cts"],
  language: (filename) => {
    const ext = path.extname(filename).toLowerCase();
    if (ext === ".tsx") return LangTSX;
    return LangTS;
  },
  nodeTypes: {
    identifier: ["identifier", "type_identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier"],
    memberExpression: "member_expression",
  },
  queries: {
    imports: `
      (import_statement (string) @mod) @stmt
      (export_statement (string) @mod) @stmt
    `,
    exports: `
      (export_statement) @stmt
      (export_statement (function_declaration name: (identifier) @name)) @stmt
      (export_statement (class_declaration name: (identifier) @name)) @stmt
      (export_statement (lexical_declaration (variable_declarator name: (identifier) @name))) @stmt
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)))
      (export_statement (export_clause (export_specifier name: (identifier) @src)))
      (export_statement (string) @from)
      (export_statement (function_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")
      (export_statement (class_declaration name: (identifier) @default)) @stmt (#match? @stmt "default")
      (export_assignment (identifier) @ts_export_assign)
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (class_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_statement (string) @from)
      (import_statement (import_clause (identifier) @def) (string) @from)
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier) @alias))) (string) @from)
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from)
      (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from)
      (import_equals_declaration name: (identifier) @def module: (call_expression (identifier) @req (arguments (string) @from))) (#eq? @req "require")
    `,
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_declaration") return "function";
    if (t === "class_declaration") return "class";
    if (t === "interface_declaration") return "interface";
    if (t === "type_alias_declaration") return "type";
    return "variable";
  },
  isDeclarationName: (node) => {
    const p = node.parent?.type;
    return (
      !!p &&
      [
        "function_declaration",
        "class_declaration",
        "variable_declarator",
        "interface_declaration",
        "type_alias_declaration",
        "import_specifier",
        "namespace_import",
        "import_clause",
        "import_equals_declaration",
      ].includes(p)
    );
  },
  createsBlockScope: (n) => n.type === "program" || n.type === "block",
  createsFunctionScope: (n) =>
    n.type === "function_declaration" ||
    n.type === "function" ||
    n.type === "function_expression" ||
    n.type === "arrow_function" ||
    n.type === "method_definition",
  supportsCrossModuleSymbols: true,
};

export const JS_SUPPORT: LanguageSupport = {
  id: "js",
  matchExts: [".js", ".jsx", ".mjs", ".cjs"],
  language: () => LangJS,
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["property_identifier"],
    shorthandPropertyIdentifier: ["shorthand_property_identifier"],
    memberExpression: "member_expression",
  },
  queries: {
    imports: `
      (import_statement (string) @mod) @stmt
      (export_statement (string) @mod) @stmt
      (call_expression function: (identifier) @fn arguments: (arguments (string) @mod)) (#eq? @fn "require")
    `,
    exports: `
      (export_statement) @stmt
      (export_statement (function_declaration name: (identifier) @name))
      (export_statement (class_declaration name: (identifier) @name))
      (export_statement (lexical_declaration (variable_declarator (identifier) @name)))
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src)) (string) @from)
      (export_statement (export_clause (export_specifier name: (identifier) @src alias: (identifier) @alias)))
      (export_statement (export_clause (export_specifier name: (identifier) @src)))
      (export_statement (string) @from)
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (shorthand_property_identifier) @cjs_shorthand)))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (identifier) @cjs_local))))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (identifier) @cjs_local))
        (#eq? @exp "exports")
      ;; CJS function/arrow direct exports
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (function) @cjs_fn))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (member_expression object: (identifier) @mod property: (property_identifier) @prop) property: (property_identifier) @cjs_export_name)
        right: (arrow_function) @cjs_fn))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (function) @cjs_fn))
        (#eq? @exp "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @exp property: (property_identifier) @cjs_export_name)
        right: (arrow_function) @cjs_fn))
        (#eq? @exp "exports")
      ;; CJS object export with function value
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (arrow_function) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
      ;; CJS: module.exports = { helper () {} }
      (expression_statement (assignment_expression
        left: (member_expression object: (identifier) @mod property: (property_identifier) @prop)
        right: (object (pair key: (property_identifier) @cjs_export_name value: (function_declaration) @cjs_fn))))
        (#eq? @mod "module") (#eq? @prop "exports")
    `,
    locals: `
      (function_declaration name: (identifier) @name)
      (class_declaration name: (identifier) @name)
      (variable_declarator name: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_statement (string) @from)
      (import_statement (import_clause (identifier) @def) (string) @from)
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname alias: (identifier) @alias))) (string) @from)
      (import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from)
      (import_statement (import_clause (namespace_import (identifier) @ns)) (string) @from)
      (lexical_declaration (variable_declarator name:(identifier) @def value: (call_expression (identifier) @req arguments: (arguments (string) @from)))) (#eq? @req "require")
      (lexical_declaration (variable_declarator (object_pattern) @pattern value: (call_expression (identifier) @req arguments: (arguments (string) @from)))) (#eq? @req "require")
    `,
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_declaration") return "function";
    if (t === "class_declaration") return "class";
    return "variable";
  },
  isDeclarationName: (node) => {
    const p = node.parent?.type;
    return (
      !!p &&
      [
        "function_declaration",
        "class_declaration",
        "variable_declarator",
        "import_specifier",
        "namespace_import",
        "import_clause",
      ].includes(p)
    );
  },
  createsBlockScope: (n) => n.type === "program" || n.type === "block",
  createsFunctionScope: (n) =>
    n.type === "function_declaration" ||
    n.type === "function" ||
    n.type === "function_expression" ||
    n.type === "arrow_function" ||
    n.type === "method_definition",
  supportsCrossModuleSymbols: true,
};

export const PY_SUPPORT: LanguageSupport = {
  id: "python",
  matchExts: [".py"],
  language: () => PythonLang as unknown as Parser.Language,
  nodeTypes: {
    identifier: ["identifier"],
    propertyIdentifier: ["identifier"],
    memberExpression: "attribute",
  },
  queries: {
    imports: `
      (import_statement) @stmt
      (import_from_statement) @stmt
    `,
    exports: `
      (assignment left: (identifier) @left right: (list (string)+ @all_item)) @stmt
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (assignment left: (identifier) @name)
    `,
    locals: `
      (function_definition name: (identifier) @name)
      (class_definition name: (identifier) @name)
      (assignment left: (identifier) @name)
    `,
    importBindings: `
      (import_statement) @stmt
      (import_from_statement) @stmt
    `,
  },
  classifyDefinition: (n) => {
    const t = n.parent?.type;
    if (t === "function_definition") return "function";
    if (t === "class_definition") return "class";
    return "variable";
  },
  isDeclarationName: (node) => {
    const t = node.parent?.type;
    return (
      !!t &&
      [
        "function_definition",
        "class_definition",
        "assignment",
        "aliased_import",
      ].includes(t)
    );
  },
  createsBlockScope: (n) => n.type === "module" || n.type === "block",
  createsFunctionScope: (n) =>
    n.type === "function_definition" || n.type === "lambda",
  supportsCrossModuleSymbols: true,
};

export const LANGUAGE_SUPPORTS: LanguageSupport[] = [TS_SUPPORT, JS_SUPPORT, PY_SUPPORT];

export function supportForFile(filename: string): LanguageSupport {
  const ext = path.extname(filename).toLowerCase();
  return LANGUAGE_SUPPORTS.find((s) => s.matchExts.includes(ext)) ?? TS_SUPPORT;
}
export function languageForFile(filename: string): Parser.Language {
  return supportForFile(filename).language(filename);
}

// ---------------- Compiled query cache (per language grammar) ----------------
type CompiledQueries = { imports: Parser.Query; exports: Parser.Query; locals: Parser.Query; importBindings: Parser.Query };
const queryCache = new WeakMap<Parser.Language, Map<string, CompiledQueries>>();

export function getCompiledQueries(lang: Parser.Language, support: LanguageSupport): CompiledQueries {
  let bySupport = queryCache.get(lang);
  if (!bySupport) { bySupport = new Map<string, CompiledQueries>(); queryCache.set(lang, bySupport); }
  const key = support.id;
  let cq = bySupport.get(key);
  if (!cq) {
    cq = {
      imports: new Parser.Query(lang, support.queries.imports),
      exports: new Parser.Query(lang, support.queries.exports),
      locals: new Parser.Query(lang, support.queries.locals),
      importBindings: new Parser.Query(lang, support.queries.importBindings),
    };
    bySupport.set(key, cq);
  }
  return cq;
}


