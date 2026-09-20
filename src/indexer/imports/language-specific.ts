import path from "node:path";
import {
  JAVA_DOTTED_NAME_SOURCE,
  isRustItemStartBoundary,
  parseCsharpUsingDirective,
  parseJavaImportStatement,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatements,
  skipRustCommentOrLiteral,
  skipRustMacroTokenTree,
  skipRustOuterAttribute,
  type ParsedRustImportStatement,
} from "../../languages/import-statement-parsers.js";
import { CSHARP_IDENTIFIER_SOURCE, GO_IDENTIFIER_SOURCE, KOTLIN_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { isRustCfgTestStatement } from "../../util/rust-test-modules.js";
import { getPhpComposerImplicitFiles } from "../../util/resolution.js";
import { resolveCsharpNamespaceImportPaths } from "../../util/resolution/csharp.js";
import { extractRustModPathAttribute, resolveRustImportPath } from "../../util/resolution/rust.js";
import { attributeNamedBindingRanges, maskImportBindingTrivia } from "./binding-ranges.js";
import type { ImportBinding } from "../types.js";
import type { ImportBindingSink, ImportResolver, ResolvedImportTarget } from "./context.js";

export type LanguageSpecificImportContext = ImportBindingSink & {
  file: string;
  projectRoot: string;
  source: string;
  languageId: string;
  resolveFrom: ImportResolver;
  getBindings: () => ImportBinding[];
  replaceBindings: (bindings: ImportBinding[]) => void;
};

export type StatementImportOverrideState = {
  handledStatements: Set<string>;
};

export function createStatementImportOverrideState(): StatementImportOverrideState {
  return { handledStatements: new Set() };
}

type ParsedJvmImportStatement =
  | { kind: "star"; from: string }
  | { kind: "named"; from: string; imported: string; explicitAlias?: boolean };

function normalizeGoImports(context: LanguageSpecificImportContext): void {
  const imports = context.getBindings();
  if (context.languageId !== "go" || !imports.length) {
    return;
  }
  const aliasByFrom = new Map<string, string>();
  // Go alias is either the standalone dot-import token or a real Go identifier (Unicode
  // letter/underscore start, decimal-digit continuation); the blank identifier "_" is a
  // valid identifier already covered by GO_IDENTIFIER_SOURCE.
  const importPattern = new RegExp(
    String.raw`^\s*(?:import\s+)?(?:(?<alias>\.|${GO_IDENTIFIER_SOURCE})\s+)?["'\u0060](?<from>[^"'\u0060]+)["'\u0060]`,
    "gmu",
  );
  for (const match of context.source.matchAll(importPattern)) {
    const from = match.groups?.from;
    if (!from) continue;
    const alias = match.groups?.alias;
    if (alias) {
      aliasByFrom.set(from, alias);
    }
  }

  if (!aliasByFrom.size) {
    return;
  }

  const normalized: ImportBinding[] = [];
  const seen = new Set<string>();
  for (const imp of imports) {
    const alias = aliasByFrom.get(imp.from);
    let next: ImportBinding | null = imp;
    if (alias === ".") {
      next = {
        kind: "star",
        from: imp.from,
        ...(imp.resolved !== undefined ? { resolved: imp.resolved } : {}),
        ...(imp.typeOnly ? { typeOnly: imp.typeOnly } : {}),
      };
    } else if (alias === "_") {
      next = null;
    } else if (alias && imp.kind === "namespace") {
      next = {
        ...imp,
        localNS: alias,
      };
    }
    if (!next) continue;
    const key = JSON.stringify(next);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(next);
  }

  context.replaceBindings(normalized);
}

async function appendJavaTextImports(context: LanguageSpecificImportContext): Promise<void> {
  if (context.languageId !== "java" || context.getBindings().length) {
    return;
  }
  const importPattern = new RegExp(
    String.raw`^\s*import\s+(static\s+)?(${JAVA_DOTTED_NAME_SOURCE}(?:\.\*)?)\s*;`,
    "gmu",
  );
  for (const match of context.source.matchAll(importPattern)) {
    const isStatic = !!match[1];
    const rawSpec = match[2];
    if (!rawSpec) continue;
    if (rawSpec.endsWith(".*")) {
      const resolved = await context.resolveFrom(isStatic ? rawSpec.slice(0, -2) : rawSpec);
      context.pushBinding({
        kind: "star",
        from: rawSpec,
        resolved,
        typeOnly: false,
      });
      continue;
    }

    const parts = rawSpec.split(".");
    const imported = parts[parts.length - 1];
    if (!imported) continue;
    const fromValue = isStatic ? parts.slice(0, -1).join(".") : rawSpec;
    const resolved = await context.resolveFrom(fromValue);
    const namedBinding: ImportBinding = {
      kind: "named",
      local: imported,
      imported,
      from: fromValue,
      resolved,
      typeOnly: false,
    };
    if (match.index !== undefined) {
      attributeNamedBindingRanges({
        bindings: [namedBinding],
        fromIndex: 0,
        text: maskImportBindingTrivia(match[0], context.languageId),
        textStartIndex: match.index,
        source: context.source,
      });
    }
    context.pushBinding(namedBinding);
  }
}

async function appendKotlinTextImports(context: LanguageSpecificImportContext): Promise<void> {
  if (context.languageId !== "kotlin" || context.getBindings().length) {
    return;
  }
  const dottedNameWithTrivia = String.raw`${KOTLIN_IDENTIFIER_SOURCE}(?:\s*\.\s*${KOTLIN_IDENTIFIER_SOURCE})*`;
  const importPattern = new RegExp(
    String.raw`^\s*import\s+(${dottedNameWithTrivia}(?:\s*\.\s*\*)?)(?:\s+as\s+(${KOTLIN_IDENTIFIER_SOURCE}))?\s*;?\s*$`,
    "gmu",
  );
  const maskedSource = maskImportBindingTrivia(context.source, context.languageId);
  for (const match of maskedSource.matchAll(importPattern)) {
    const rawSpec = match[1];
    if (!rawSpec) continue;
    const normalizedSpec = rawSpec.replace(/\s+/gu, "");
    if (normalizedSpec.endsWith(".*")) {
      const fromValue = normalizedSpec.slice(0, -2);
      const resolved = await context.resolveFrom(fromValue);
      context.pushBinding({
        kind: "star",
        from: fromValue,
        resolved,
        typeOnly: false,
      });
      continue;
    }

    const parts = normalizedSpec.split(".");
    const imported = parts[parts.length - 1];
    if (!imported) continue;
    const resolved = await context.resolveFrom(normalizedSpec);
    const namedBinding: ImportBinding = {
      kind: "named",
      local: match[2] ?? imported,
      imported,
      from: normalizedSpec,
      ...(match[2] !== undefined ? { explicitAlias: true } : {}),
      resolved,
      typeOnly: false,
    };
    if (match.index !== undefined) {
      attributeNamedBindingRanges({
        bindings: [namedBinding],
        fromIndex: 0,
        text: maskImportBindingTrivia(match[0], context.languageId),
        textStartIndex: match.index,
        source: context.source,
      });
    }
    context.pushBinding(namedBinding);
  }
}

async function appendPhpComposerImplicitImports(context: LanguageSpecificImportContext): Promise<void> {
  if (context.languageId !== "php") {
    return;
  }

  const implicitFiles = await getPhpComposerImplicitFiles(context.projectRoot, context.file);
  const seenResolved = new Set(
    context
      .getBindings()
      .map((entry) => (typeof entry.resolved === "string" ? entry.resolved : null))
      .filter((entry): entry is string => !!entry),
  );

  for (const implicitFile of implicitFiles) {
    const normalizedResolved = implicitFile.replace(/\\/g, "/");
    if (normalizedResolved === context.file.replace(/\\/g, "/")) {
      continue;
    }
    if (seenResolved.has(normalizedResolved)) {
      continue;
    }

    const relativeFrom = path.relative(path.dirname(context.file), implicitFile).replace(/\\/g, "/");
    const from = relativeFrom.startsWith(".") || relativeFrom.startsWith("/") ? relativeFrom : `./${relativeFrom}`;
    context.pushBinding({
      kind: "star",
      from,
      resolved: normalizedResolved,
      mechanism: "php",
    });
    seenResolved.add(normalizedResolved);
  }
}

export async function finalizeLanguageSpecificImports(context: LanguageSpecificImportContext): Promise<void> {
  normalizeGoImports(context);
  await appendJavaTextImports(context);
  await appendKotlinTextImports(context);
  await appendRustTextImports(context);
  await appendPhpComposerImplicitImports(context);
}

function pushCsharpOverride(
  context: LanguageSpecificImportContext,
  parsed: NonNullable<ReturnType<typeof parseCsharpUsingDirective>>,
  typeOnly: boolean,
  fromValue: string,
  resolved: ResolvedImportTarget,
): void {
  if (parsed.alias) {
    const fromParts = parsed.from.split(".");
    const imported = fromParts[fromParts.length - 1] ?? parsed.alias;
    context.pushBinding({
      kind: "named",
      local: parsed.alias,
      imported,
      from: fromValue,
      explicitAlias: true,
      resolved,
      typeOnly,
    });
    return;
  }

  context.pushBinding({
    kind: "star",
    from: fromValue,
    resolved,
    typeOnly,
  });
}

const CSHARP_EXTERN_ALIAS_PATTERN = new RegExp(String.raw`^extern\s+alias\s+(${CSHARP_IDENTIFIER_SOURCE})\s*;$`, "u");

async function applyCsharpStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  const externAlias = normalizedStmt.match(CSHARP_EXTERN_ALIAS_PATTERN)?.[1];
  if (externAlias) {
    // `extern alias X;` names a compiler-provided alias for an assembly's extern alias. It has no
    // first-party or package target, so it stays an unresolved namespace binding and produces no
    // dependency edge: the graph query does not treat it as an import specifier.
    context.pushBinding({ kind: "namespace", localNS: externAlias, from: externAlias });
    return true;
  }

  const parsed = parseCsharpUsingDirective(normalizedStmt);
  if (!parsed) return false;

  // A target that is itself a declared namespace is a namespace alias, even when the alias is
  // written in alias form. Resolving it here keeps the local name a namespace so member
  // navigation can reach the declaring file instead of treating the last segment as a type.
  // A namespace split across several files has no single target, so it keeps the local alias
  // as an unresolved namespace rather than claiming one of the declaring files.
  const namespaceTargets = await resolveCsharpNamespaceImportPaths(context.projectRoot, parsed.from);
  if (parsed.alias && namespaceTargets.length) {
    context.pushBinding({
      kind: "namespace",
      localNS: parsed.alias,
      from: parsed.from,
      ...(namespaceTargets.length === 1 ? { resolved: namespaceTargets[0]!.replace(/\\/g, "/") } : {}),
      typeOnly,
    });
    return true;
  }

  let fromValue = parsed.from;
  let resolved = await context.resolveFrom(fromValue);
  if (typeof resolved !== "string" && namespaceTargets.length === 1) {
    resolved = namespaceTargets[0]!.replace(/\\/g, "/");
  }
  if (parsed.alias) {
    const fromParts = parsed.from.split(".");
    if (typeof resolved !== "string" && fromParts.length > 1) {
      const fallbackFrom = fromParts.slice(0, -1).join(".");
      if (fallbackFrom) {
        const fallbackResolved = await context.resolveFrom(fallbackFrom);
        if (typeof fallbackResolved === "string") {
          fromValue = fallbackFrom;
          resolved = fallbackResolved;
        }
      }
    }
  }
  pushCsharpOverride(context, parsed, typeOnly, fromValue, resolved);
  return true;
}

async function applyJavaStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  return await applyJvmStatementOverride(context, normalizedStmt, typeOnly, parseJavaImportStatement, (parsed) => {
    if (parsed.kind === "named") return parsed.imported;
    return undefined;
  });
}

async function applyKotlinStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  return await applyJvmStatementOverride(context, normalizedStmt, typeOnly, parseKotlinImportStatement, (parsed) => {
    if (parsed.kind === "named") return parsed.local;
    return undefined;
  });
}

async function applyJvmStatementOverride<TParsed extends ParsedJvmImportStatement>(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
  parseStatement: (statement: string) => TParsed | null,
  localNameFor: (parsed: TParsed) => string | undefined,
): Promise<boolean> {
  const parsed = parseStatement(normalizedStmt);
  if (!parsed) return false;
  return await pushJvmImportBinding(context, parsed, localNameFor(parsed), typeOnly);
}

async function pushJvmImportBinding(
  context: LanguageSpecificImportContext,
  parsed: { kind: "star"; from: string } | { kind: "named"; from: string; imported: string; explicitAlias?: boolean },
  local: string | undefined,
  typeOnly: boolean,
): Promise<boolean> {
  const resolved = await context.resolveFrom(parsed.from);
  if (parsed.kind === "star") {
    context.pushBinding({
      kind: "star",
      from: parsed.from,
      resolved,
      typeOnly,
    });
    return true;
  }

  context.pushBinding({
    kind: "named",
    local: local ?? parsed.imported,
    imported: parsed.imported,
    from: parsed.from,
    ...(parsed.explicitAlias ? { explicitAlias: true } : {}),
    resolved,
    typeOnly,
  });
  return true;
}

async function applyRustStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
  statementStartIndex?: number,
): Promise<boolean> {
  if (isRustTestOnlyStatement(context, normalizedStmt, statementStartIndex)) return true;

  const parsedList = parseRustImportStatements(normalizedStmt);
  if (!parsedList.length) return false;
  const seen = new Set(context.getBindings().map(rustBindingKey));
  await pushParsedRustImports(context, parsedList, typeOnly, statementStartIndex, seen);
  return true;
}

async function resolveRustParsedFrom(
  context: LanguageSpecificImportContext,
  from: string,
  pathAttribute?: string,
  statementStartIndex?: number,
): Promise<ResolvedImportTarget> {
  if (pathAttribute) {
    const attributed = await resolveRustImportPath(
      context.projectRoot,
      context.file,
      from,
      pathAttribute,
      statementStartIndex,
    );
    if (attributed) return attributed.replace(/\\/g, "/");
    return { external: from };
  }
  return context.resolveFrom(from);
}

function rustBindingKey(binding: ImportBinding): string {
  const resolved = JSON.stringify(binding.resolved);
  if (binding.kind === "named") return `named:${binding.local}:${binding.imported}:${binding.from}:${resolved}`;
  if (binding.kind === "namespace") return `namespace:${binding.localNS}:${binding.from}:${resolved}`;
  if (binding.kind === "star") return `star:${binding.from}:${resolved}`;
  return JSON.stringify(binding);
}

const RUST_IMPORT_KEYWORD_PATTERN = /^(?:pub(?:\s*\([^)]*\))?\s+)?(use|extern\s+crate|mod)\b/;

function scanRustImportStatements(sourceText: string): Array<{ text: string; start: number }> {
  const results: Array<{ text: string; start: number }> = [];
  let index = 0;
  while (index < sourceText.length) {
    const skipped = skipRustCommentOrLiteral(sourceText, index) ?? skipRustMacroTokenTree(sourceText, index);
    if (skipped) {
      index = skipped.end;
      continue;
    }
    if (/\s/.test(sourceText[index]!)) {
      index += 1;
      continue;
    }

    const statementStart = index;
    let cursor = index;
    for (;;) {
      while (cursor < sourceText.length && /\s/.test(sourceText[cursor]!)) cursor += 1;
      const trivia = skipRustCommentOrLiteral(sourceText, cursor);
      if (trivia) {
        cursor = trivia.end;
        continue;
      }
      const attrEnd = skipRustOuterAttribute(sourceText, cursor);
      if (attrEnd === null) break;
      cursor = attrEnd;
    }

    const match = sourceText.slice(cursor).match(RUST_IMPORT_KEYWORD_PATTERN);
    if (!match || !isRustItemStartBoundary(sourceText, cursor)) {
      index = Math.max(index + 1, cursor);
      continue;
    }

    let consumed = false;
    let depth = 0;
    for (let scan = statementStart; scan < sourceText.length; ) {
      const inner = skipRustCommentOrLiteral(sourceText, scan) ?? skipRustMacroTokenTree(sourceText, scan);
      if (inner) {
        scan = inner.end;
        continue;
      }
      const character = sourceText[scan];
      if (character === "{") {
        const head = sourceText.slice(statementStart, scan);
        if (/\bmod\b/.test(head) && !/\buse\b/.test(head)) {
          index = scan + 1;
          consumed = true;
          break;
        }
        depth += 1;
        scan += 1;
        continue;
      }
      if (character === "}") {
        depth = Math.max(0, depth - 1);
        scan += 1;
        continue;
      }
      if (character === ";" && !depth) {
        results.push({ text: sourceText.slice(statementStart, scan + 1), start: statementStart });
        index = scan + 1;
        consumed = true;
        break;
      }
      scan += 1;
    }
    if (!consumed) index += 1;
  }
  return results;
}

function buildRustBinding(
  parsed: ParsedRustImportStatement,
  resolved: ResolvedImportTarget,
  typeOnly: boolean,
): ImportBinding {
  if (parsed.kind === "member") {
    return {
      kind: "named",
      local: parsed.local,
      imported: parsed.imported,
      from: parsed.from,
      ...(parsed.explicitAlias ? { explicitAlias: true } : {}),
      resolved,
      typeOnly,
    };
  }
  if (parsed.kind === "module") {
    return { kind: "namespace", localNS: parsed.local, from: parsed.from, resolved, typeOnly };
  }
  return { kind: "star", from: parsed.from, resolved, typeOnly };
}

async function pushParsedRustImports(
  context: LanguageSpecificImportContext,
  parsedList: ReturnType<typeof parseRustImportStatements>,
  typeOnly: boolean,
  statementStartIndex: number | undefined,
  seen: Set<string>,
): Promise<void> {
  const statementPathAttribute = extractRustModPathAttribute(context.source, undefined, statementStartIndex);
  for (const parsed of parsedList) {
    const pathAttribute =
      parsed.kind === "module" && !parsed.isExternCrate ? (parsed.pathAttribute ?? statementPathAttribute) : undefined;
    const resolved = await resolveRustParsedFrom(context, parsed.from, pathAttribute, statementStartIndex);
    const binding = buildRustBinding(parsed, resolved, typeOnly);
    const key = rustBindingKey(binding);
    if (seen.has(key)) continue;
    seen.add(key);
    context.pushBinding(binding);
  }
}

async function appendRustTextImports(context: LanguageSpecificImportContext): Promise<void> {
  if (context.languageId !== "rust") return;
  const seen = new Set(context.getBindings().map(rustBindingKey));
  for (const statement of scanRustImportStatements(context.source)) {
    const keywordOffset = rustImportKeywordOffset(statement.text);
    const keywordIndex = keywordOffset >= 0 ? statement.start + keywordOffset : statement.start;
    const keywordText = keywordOffset >= 0 ? statement.text.slice(keywordOffset) : statement.text;
    if (isRustCfgTestStatement(context.source, keywordText, keywordIndex)) continue;
    const parsedList = parseRustImportStatements(statement.text);
    if (!parsedList.length) continue;
    const bindingCountBefore = context.getBindings().length;
    await pushParsedRustImports(context, parsedList, false, statement.start, seen);
    attributeNamedBindingRanges({
      bindings: context.getBindings(),
      fromIndex: bindingCountBefore,
      text: maskImportBindingTrivia(statement.text, context.languageId),
      textStartIndex: statement.start,
      source: context.source,
    });
  }
}

function isRustTestOnlyStatement(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  statementStartIndex?: number,
): boolean {
  if (context.languageId !== "rust") return false;
  if (statementStartIndex !== undefined) {
    const keywordOffset = rustImportKeywordOffset(context.source.slice(statementStartIndex));
    const keywordIndex = keywordOffset >= 0 ? statementStartIndex + keywordOffset : statementStartIndex;
    const keywordText = keywordOffset >= 0 ? context.source.slice(keywordIndex) : normalizedStmt;
    return isRustCfgTestStatement(context.source, keywordText, keywordIndex);
  }
  return isRustCfgTestStatement(context.source, normalizedStmt, statementStartIndex);
}

function rustImportKeywordOffset(text: string): number {
  let index = 0;
  while (index < text.length) {
    if (/\s/.test(text[index]!)) {
      index += 1;
      continue;
    }
    const skipped = skipRustCommentOrLiteral(text, index);
    if (skipped) {
      index = skipped.end;
      continue;
    }
    const attrEnd = skipRustOuterAttribute(text, index);
    if (attrEnd !== null) {
      index = attrEnd;
      continue;
    }
    const match = text.slice(index).match(RUST_IMPORT_KEYWORD_PATTERN);
    if (match) return index;
    index += 1;
  }
  return -1;
}

async function applyPhpStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  const parsed = parsePhpImportStatement(normalizedStmt, context.file);
  if (!parsed.length) return false;

  for (const entry of parsed) {
    if (entry.kind === "include") {
      const resolved = await context.resolveFrom(entry.from);
      context.pushBinding({
        kind: "star",
        from: entry.from,
        resolved,
        typeOnly,
        mechanism: "php",
      });
      continue;
    }
    const resolved = await context.resolveFrom(entry.from, entry.importType);
    context.pushBinding({
      kind: "named",
      local: entry.local,
      imported: entry.imported,
      from: entry.from,
      ...(entry.explicitAlias ? { explicitAlias: true } : {}),
      phpImportType: entry.importType,
      resolved,
      typeOnly,
      mechanism: "php",
    });
  }
  return true;
}

export async function applyStatementImportOverride(
  context: LanguageSpecificImportContext,
  state: StatementImportOverrideState,
  stmtText: string,
  typeOnly: boolean,
  statementStartIndex?: number,
): Promise<boolean> {
  const normalizedStmt = stmtText.trim();
  if (!normalizedStmt) return false;
  const statementKey = statementImportOverrideKey(context.languageId, normalizedStmt, statementStartIndex);
  if (state.handledStatements.has(statementKey)) return true;

  let parserStmt = normalizedStmt;
  const canMaskStrings =
    context.languageId !== "rust" && (context.languageId !== "php" || /^\s*use\b/i.test(normalizedStmt));
  if (canMaskStrings) {
    parserStmt = maskImportBindingTrivia(normalizedStmt, context.languageId);
    if (context.languageId === "csharp" || context.languageId === "java" || context.languageId === "kotlin") {
      parserStmt = parserStmt.replace(/\s*\.\s*/gu, ".");
    }
  }
  let handled = false;
  if (context.languageId === "csharp") {
    handled = await applyCsharpStatementOverride(context, parserStmt, typeOnly);
  } else if (context.languageId === "java") {
    handled = await applyJavaStatementOverride(context, parserStmt, typeOnly);
  } else if (context.languageId === "kotlin") {
    handled = await applyKotlinStatementOverride(context, parserStmt, typeOnly);
  } else if (context.languageId === "rust") {
    handled = await applyRustStatementOverride(context, normalizedStmt, typeOnly, statementStartIndex);
  } else if (context.languageId === "php") {
    handled = await applyPhpStatementOverride(context, parserStmt, typeOnly);
  }

  if (!handled) return false;
  state.handledStatements.add(statementKey);
  return true;
}

function statementImportOverrideKey(languageId: string, normalizedStmt: string, statementStartIndex?: number): string {
  if (languageId === "rust" && statementStartIndex !== undefined) {
    return `${normalizedStmt}@${statementStartIndex}`;
  }
  return normalizedStmt;
}

export function appendImplicitImportBinding(
  context: LanguageSpecificImportContext,
  args: {
    from: string;
    resolved: ResolvedImportTarget;
    typeOnly: boolean;
    stmtText: string;
    /** UTF-16 start index of `stmtText` within the source file, when known. */
    stmtStartIndex?: number;
    source?: string;
    alias?: string;
    wildcard?: boolean;
  },
): void {
  const { from, resolved, typeOnly, stmtText, stmtStartIndex, source, alias, wildcard } = args;
  const pushNamed = (binding: ImportBinding, alwaysAliased?: boolean): void =>
    pushNamedImplicitBinding(context, binding, stmtText, stmtStartIndex, source, alwaysAliased);
  if (context.languageId === "java") {
    const parts = from.split(".");
    const last = parts[parts.length - 1];
    if (last === "*") {
      context.pushBinding({ kind: "star", from, resolved, typeOnly });
    } else if (last) {
      pushNamed({ kind: "named", local: last, imported: last, from, resolved, typeOnly });
    }
  } else if (context.languageId === "csharp") {
    if (alias) {
      const fromParts = from.split(".");
      const imported = fromParts[fromParts.length - 1] ?? alias;
      pushNamed({ kind: "named", local: alias, imported, from, explicitAlias: true, resolved, typeOnly }, true);
    } else {
      context.pushBinding({ kind: "star", from, resolved, typeOnly });
    }
  } else if (context.languageId === "ruby") {
    context.pushBinding({ kind: "star", from, resolved });
  } else if (context.languageId === "go") {
    const goAlias = alias;
    if (goAlias === "_") return;
    if (goAlias === ".") {
      context.pushBinding({ kind: "star", from, resolved });
      return;
    }
    if (goAlias) {
      context.pushBinding({ kind: "namespace", localNS: goAlias, from, resolved });
      return;
    }
    const parts = from.replace(/"/g, "").split("/");
    const last = parts[parts.length - 1];
    if (last) context.pushBinding({ kind: "namespace", localNS: last, from, resolved });
  } else if (context.languageId === "rust") {
    if (stmtText.startsWith("mod ")) {
      context.pushBinding({ kind: "namespace", localNS: from, from, resolved });
    } else {
      const parts = from.split("::");
      const last = parts[parts.length - 1];
      if (!last) return;
      if (last === "*") {
        context.pushBinding({ kind: "star", from, resolved });
      } else {
        pushNamed({ kind: "named", local: last, imported: last, from, resolved });
      }
    }
  } else if (context.languageId === "kotlin") {
    if (wildcard || from.endsWith(".*")) {
      context.pushBinding({ kind: "star", from, resolved, typeOnly });
    } else {
      const parts = from.split(".");
      const imported = parts[parts.length - 1];
      if (imported)
        pushNamed({
          kind: "named",
          local: alias ?? imported,
          imported,
          from,
          ...(alias !== undefined ? { explicitAlias: true } : {}),
          resolved,
          typeOnly,
        });
    }
  } else if (context.languageId === "swift") {
    const parts = from.split(".");
    const last = parts[parts.length - 1];
    if (!last) return;
    if (parts.length === 1) {
      context.pushBinding({ kind: "namespace", localNS: last, from, resolved, typeOnly });
      context.pushBinding({ kind: "star", from, resolved, typeOnly });
    } else {
      pushNamed({ kind: "named", local: last, imported: last, from, resolved, typeOnly });
    }
  } else if (context.languageId === "zig") {
    if (alias) context.pushBinding({ kind: "namespace", localNS: alias, from, resolved, typeOnly });
  } else if (context.languageId === "c" || context.languageId === "cpp") {
    context.pushBinding({ kind: "star", from, resolved, typeOnly });
  }
}

function pushNamedImplicitBinding(
  context: LanguageSpecificImportContext,
  binding: ImportBinding,
  stmtText: string,
  stmtStartIndex: number | undefined,
  source: string | undefined,
  alwaysAliased: boolean | undefined,
): void {
  if (stmtStartIndex !== undefined && source !== undefined) {
    attributeNamedBindingRanges({
      bindings: [binding],
      fromIndex: 0,
      text: maskImportBindingTrivia(stmtText, context.languageId),
      textStartIndex: stmtStartIndex,
      source,
      ...(alwaysAliased !== undefined ? { alwaysAliased } : {}),
    });
  }
  context.pushBinding(binding);
}
