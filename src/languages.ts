import fs from "node:fs";
import path from "node:path";
import type { LanguageDefinition, ParserLanguage, NativeCompatibility, SyntaxNodeLike } from "./languages/types.js";
import { getAllLanguages, getLanguageById } from "./languages/registry.js";
import "./languages/all.js";

export type IdentifierNodeType = string;

export type LanguageSupport = {
  id: string;
  matchExts: string[];
  language: (filename: string) => ParserLanguage;
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
  classifyDefinition: (nameNode: SyntaxNodeLike) => string;
  isDeclarationName: (node: SyntaxNodeLike) => boolean;
  createsBlockScope: (node: SyntaxNodeLike) => boolean;
  createsFunctionScope: (node: SyntaxNodeLike) => boolean;
  supportsCrossModuleSymbols: boolean;
  isTypeOnly: (stmtText: string) => boolean;
  native?: NativeCompatibility;
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
    ...(def.native ? { native: def.native } : {}),
  };
}

export const TS_SUPPORT = adaptDefinition(getLanguageById("ts")!);
export const TSX_SUPPORT = adaptDefinition(getLanguageById("tsx")!);
export const JS_SUPPORT = adaptDefinition(getLanguageById("js")!);
export const PY_SUPPORT = adaptDefinition(getLanguageById("python")!);
export const PHP_SUPPORT = adaptDefinition(getLanguageById("php")!);
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
export const ZIG_SUPPORT = adaptDefinition(getLanguageById("zig")!);
export const SQL_SUPPORT = adaptDefinition(getLanguageById("sql")!);

export const LANGUAGE_SUPPORTS: LanguageSupport[] = getAllLanguages().map(adaptDefinition);

export function supportForFile(filename: string): LanguageSupport | undefined {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".h") {
    const sample = readFileSample(filename);
    if (sample && isLikelyCppHeader(sample)) return CPP_SUPPORT;
    return C_SUPPORT;
  }
  return LANGUAGE_SUPPORTS.find((s) => s.matchExts.includes(ext));
}
export function languageForFile(filename: string): ParserLanguage {
  const sup = supportForFile(filename);
  if (!sup) throw new Error(`Unsupported file extension: ${filename}`);
  return sup.language(filename);
}

export function supportById(id: string): LanguageSupport | undefined {
  return LANGUAGE_SUPPORTS.find((s) => s.id === id);
}

const HEADER_SAMPLE_SIZE = 8000;
const CPP_HEADER_HINT = /\b(class|namespace|template|typename|constexpr|operator|using\s+namespace)\b|::/;

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
