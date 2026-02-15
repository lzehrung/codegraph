import fs from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";
import type { LanguageDefinition } from "./languages/types.js";
import { getAllLanguages, getLanguageById } from "./languages/registry.js";
import "./languages/all.js";

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

export const TS_SUPPORT = adaptDefinition(getLanguageById("ts")!);
export const TSX_SUPPORT = adaptDefinition(getLanguageById("tsx")!);
export const JS_SUPPORT = adaptDefinition(getLanguageById("js")!);
export const PY_SUPPORT = adaptDefinition(getLanguageById("python")!);
export const HTML_SUPPORT = adaptDefinition(getLanguageById("html")!);
export const CSS_SUPPORT = adaptDefinition(getLanguageById("css")!);
export const SCSS_SUPPORT = adaptDefinition(getLanguageById("scss")!);
export const LESS_SUPPORT = adaptDefinition(getLanguageById("less")!);
export const VUE_SUPPORT = adaptDefinition(getLanguageById("vue")!);
export const SVELTE_SUPPORT = adaptDefinition(getLanguageById("svelte")!);
export const RUBY_SUPPORT = adaptDefinition(getLanguageById("ruby")!);
export const GO_SUPPORT = adaptDefinition(getLanguageById("go")!);
export const JAVA_SUPPORT = adaptDefinition(getLanguageById("java")!);
export const CSHARP_SUPPORT = adaptDefinition(getLanguageById("csharp")!);
export const RUST_SUPPORT = adaptDefinition(getLanguageById("rust")!);
export const C_SUPPORT = adaptDefinition(getLanguageById("c")!);
export const CPP_SUPPORT = adaptDefinition(getLanguageById("cpp")!);
export const KOTLIN_SUPPORT = adaptDefinition(getLanguageById("kotlin")!);
export const SWIFT_SUPPORT = adaptDefinition(getLanguageById("swift")!);

export const LANGUAGE_SUPPORTS: LanguageSupport[] =
  getAllLanguages().map(adaptDefinition);

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
