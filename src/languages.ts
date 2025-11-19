import path from "node:path";
import Parser from "tree-sitter";
import type { LanguageDefinition } from "./languages/types.js";
import { TYPESCRIPT_DEF, TSX_DEF } from "./languages/definitions/typescript.js";
import { JAVASCRIPT_DEF } from "./languages/definitions/javascript.js";
import { PYTHON_DEF } from "./languages/definitions/python.js";

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

function adaptDefinition(def: LanguageDefinition): LanguageSupport {
  return {
    id: def.id,
    matchExts: def.extensions,
    language: (filename) => def.grammar(filename),
    nodeTypes: def.nodeTypes || { identifier: ["identifier"] },
    queries: def.graph,
    classifyDefinition: def.classifyDefinition || (() => "variable"),
    isDeclarationName: def.isDeclarationName || (() => false),
    createsBlockScope: def.createsBlockScope || (() => false),
    createsFunctionScope: def.createsFunctionScope || (() => false),
    supportsCrossModuleSymbols: def.supportsCrossModuleSymbols || false,
  };
}

export const TS_SUPPORT = adaptDefinition(TYPESCRIPT_DEF);
export const TSX_SUPPORT = adaptDefinition(TSX_DEF);
export const JS_SUPPORT = adaptDefinition(JAVASCRIPT_DEF);
export const PY_SUPPORT = adaptDefinition(PYTHON_DEF);

export const LANGUAGE_SUPPORTS: LanguageSupport[] = [
  TS_SUPPORT,
  TSX_SUPPORT,
  JS_SUPPORT,
  PY_SUPPORT,
];

export function supportForFile(filename: string): LanguageSupport {
  const ext = path.extname(filename).toLowerCase();
  return LANGUAGE_SUPPORTS.find((s) => s.matchExts.includes(ext)) ?? TS_SUPPORT;
}
export function languageForFile(filename: string): Parser.Language {
  return supportForFile(filename).language(filename);
}

// ---------------- Compiled query cache (per language grammar) ----------------
type CompiledQueries = {
  imports: Parser.Query;
  exports: Parser.Query;
  locals: Parser.Query;
  importBindings: Parser.Query;
};
const queryCache = new WeakMap<Parser.Language, Map<string, CompiledQueries>>();

export function getCompiledQueries(
  lang: Parser.Language,
  support: LanguageSupport
): CompiledQueries {
  let bySupport = queryCache.get(lang);
  if (!bySupport) {
    bySupport = new Map<string, CompiledQueries>();
    queryCache.set(lang, bySupport);
  }
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
