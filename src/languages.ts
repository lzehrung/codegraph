import fs from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";
import type { LanguageDefinition } from "./languages/types.js";
import { TYPESCRIPT_DEF, TSX_DEF } from "./languages/definitions/typescript.js";
import { JAVASCRIPT_DEF } from "./languages/definitions/javascript.js";
import { PYTHON_DEF } from "./languages/definitions/python.js";
import { HTML_DEF } from "./languages/definitions/html.js";
import { CSS_DEF } from "./languages/definitions/css.js";
import { SCSS_DEF } from "./languages/definitions/scss.js";
import { LESS_DEF } from "./languages/definitions/less.js";
import { VUE_DEF } from "./languages/definitions/vue.js";
import { SVELTE_DEF } from "./languages/definitions/svelte.js";
import { RUBY_DEF } from "./languages/definitions/ruby.js";
import { GO_DEF } from "./languages/definitions/go.js";
import { JAVA_DEF } from "./languages/definitions/java.js";
import { CSHARP_DEF } from "./languages/definitions/csharp.js";
import { RUST_DEF } from "./languages/definitions/rust.js";
import { C_DEF } from "./languages/definitions/c.js";
import { CPP_DEF } from "./languages/definitions/cpp.js";
import { KOTLIN_DEF } from "./languages/definitions/kotlin.js";
import { SWIFT_DEF } from "./languages/definitions/swift.js";

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
  classifyDefinition: (nameNode: Parser.SyntaxNode) => string;
  isDeclarationName: (node: Parser.SyntaxNode) => boolean;
  createsBlockScope: (node: Parser.SyntaxNode) => boolean;
  createsFunctionScope: (node: Parser.SyntaxNode) => boolean;
  supportsCrossModuleSymbols: boolean;
  isTypeOnly: (stmtText: string) => boolean;
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
    isTypeOnly: def.isTypeOnly || (() => false),
  };
}

export const TS_SUPPORT = adaptDefinition(TYPESCRIPT_DEF);
export const TSX_SUPPORT = adaptDefinition(TSX_DEF);
export const JS_SUPPORT = adaptDefinition(JAVASCRIPT_DEF);
export const PY_SUPPORT = adaptDefinition(PYTHON_DEF);
export const HTML_SUPPORT = adaptDefinition(HTML_DEF);
export const CSS_SUPPORT = adaptDefinition(CSS_DEF);
export const SCSS_SUPPORT = adaptDefinition(SCSS_DEF);
export const LESS_SUPPORT = adaptDefinition(LESS_DEF);
export const VUE_SUPPORT = adaptDefinition(VUE_DEF);
export const SVELTE_SUPPORT = adaptDefinition(SVELTE_DEF);
export const RUBY_SUPPORT = adaptDefinition(RUBY_DEF);
export const GO_SUPPORT = adaptDefinition(GO_DEF);
export const JAVA_SUPPORT = adaptDefinition(JAVA_DEF);
export const CSHARP_SUPPORT = adaptDefinition(CSHARP_DEF);
export const RUST_SUPPORT = adaptDefinition(RUST_DEF);
export const C_SUPPORT = adaptDefinition(C_DEF);
export const CPP_SUPPORT = adaptDefinition(CPP_DEF);
export const KOTLIN_SUPPORT = adaptDefinition(KOTLIN_DEF);
export const SWIFT_SUPPORT = adaptDefinition(SWIFT_DEF);

export const LANGUAGE_SUPPORTS: LanguageSupport[] = [
  TS_SUPPORT,
  TSX_SUPPORT,
  JS_SUPPORT,
  PY_SUPPORT,
  HTML_SUPPORT,
  CSS_SUPPORT,
  SCSS_SUPPORT,
  LESS_SUPPORT,
  VUE_SUPPORT,
  SVELTE_SUPPORT,
  RUBY_SUPPORT,
  GO_SUPPORT,
  JAVA_SUPPORT,
  CSHARP_SUPPORT,
  RUST_SUPPORT,
  C_SUPPORT,
  CPP_SUPPORT,
  KOTLIN_SUPPORT,
  SWIFT_SUPPORT,
];

export function supportForFile(filename: string): LanguageSupport | undefined {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".h") {
    const sample = readFileSample(filename);
    if (sample && isLikelyCppHeader(sample)) return CPP_SUPPORT;
    return C_SUPPORT;
  }
  return LANGUAGE_SUPPORTS.find((s) => s.matchExts.includes(ext));
}
export function languageForFile(filename: string): Parser.Language {
  const sup = supportForFile(filename);
  if (!sup) throw new Error(`Unsupported file extension: ${filename}`);
  return sup.language(filename);
}

export function supportById(id: string): LanguageSupport | undefined {
  return LANGUAGE_SUPPORTS.find((s) => s.id === id);
}

const HEADER_SAMPLE_SIZE = 8000;
const CPP_HEADER_HINT =
  /\b(class|namespace|template|typename|constexpr|operator|using\s+namespace)\b|::/;

function readFileSample(filePath: string): string | null {
  try {
    const contents = fs.readFileSync(filePath, "utf8");
    return contents.slice(0, HEADER_SAMPLE_SIZE);
  } catch {
    return null;
  }
}

function isLikelyCppHeader(sample: string): boolean {
  return CPP_HEADER_HINT.test(sample);
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
  support: LanguageSupport,
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
