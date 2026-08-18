import path from "node:path";
import {
  JAVA_DOTTED_NAME_SOURCE,
  KOTLIN_DOTTED_NAME_SOURCE,
  parseCsharpUsingDirective,
  parseJavaImportStatement,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatement,
} from "../../languages/importStatementParsers.js";
import { GO_IDENTIFIER_SOURCE, JAVA_IDENTIFIER_SOURCE, KOTLIN_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
import { isRustCfgTestStatement } from "../../util/rustTestModules.js";
import { getPhpComposerImplicitFiles } from "../../util/resolution.js";
import type { ImportBinding } from "../types.js";
import type { ImportBindingSink, ImportResolver, ResolvedImportTarget } from "./context.js";

const JAVA_UPPERCASE_IDENTIFIER_PATTERN = new RegExp(String.raw`^(?=\p{Lu})${JAVA_IDENTIFIER_SOURCE}$`, "u");

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

type ParsedJvmImportStatement = { kind: "star"; from: string } | { kind: "named"; from: string; imported: string };

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
    context.pushBinding({
      kind: "named",
      local: imported,
      imported,
      from: fromValue,
      resolved,
      typeOnly: false,
    });
  }
}

async function appendKotlinTextImports(context: LanguageSpecificImportContext): Promise<void> {
  if (context.languageId !== "kotlin" || context.getBindings().length) {
    return;
  }
  const importPattern = new RegExp(
    String.raw`^\s*import\s+(${KOTLIN_DOTTED_NAME_SOURCE}(?:\.\*)?)(?:\s+as\s+(${KOTLIN_IDENTIFIER_SOURCE}))?\s*$`,
    "gmu",
  );
  for (const match of context.source.matchAll(importPattern)) {
    const rawSpec = match[1];
    if (!rawSpec) continue;
    if (rawSpec.endsWith(".*")) {
      const fromValue = rawSpec.slice(0, -2);
      const resolved = await context.resolveFrom(fromValue);
      context.pushBinding({
        kind: "star",
        from: fromValue,
        resolved,
        typeOnly: false,
      });
      continue;
    }

    const parts = rawSpec.split(".");
    const imported = parts[parts.length - 1];
    if (!imported) continue;
    const resolved = await context.resolveFrom(rawSpec);
    context.pushBinding({
      kind: "named",
      local: match[2] ?? imported,
      imported,
      from: rawSpec,
      resolved,
      typeOnly: false,
    });
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

async function applyCsharpStatementOverride(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  typeOnly: boolean,
): Promise<boolean> {
  const parsed = parseCsharpUsingDirective(normalizedStmt);
  if (!parsed) return false;

  let fromValue = parsed.from;
  let resolved = await context.resolveFrom(fromValue);
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
  parsed: { kind: "star"; from: string } | { kind: "named"; from: string; imported: string },
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

  const parsed = parseRustImportStatement(normalizedStmt);
  if (!parsed) return false;

  const resolved = await context.resolveFrom(parsed.from);
  if (parsed.kind === "member") {
    context.pushBinding({
      kind: "named",
      local: parsed.local,
      imported: parsed.imported,
      from: parsed.from,
      resolved,
      typeOnly,
    });
  } else if (parsed.kind === "module") {
    context.pushBinding({
      kind: "namespace",
      localNS: parsed.local,
      from: parsed.from,
      resolved,
      typeOnly,
    });
  } else {
    context.pushBinding({
      kind: "star",
      from: parsed.from,
      resolved,
      typeOnly,
    });
  }
  return true;
}

function isRustTestOnlyStatement(
  context: LanguageSpecificImportContext,
  normalizedStmt: string,
  statementStartIndex?: number,
): boolean {
  if (context.languageId !== "rust") return false;
  return isRustCfgTestStatement(context.source, normalizedStmt, statementStartIndex);
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

  let handled = false;
  if (context.languageId === "csharp") {
    handled = await applyCsharpStatementOverride(context, normalizedStmt, typeOnly);
  } else if (context.languageId === "java") {
    handled = await applyJavaStatementOverride(context, normalizedStmt, typeOnly);
  } else if (context.languageId === "kotlin") {
    handled = await applyKotlinStatementOverride(context, normalizedStmt, typeOnly);
  } else if (context.languageId === "rust") {
    handled = await applyRustStatementOverride(context, normalizedStmt, typeOnly, statementStartIndex);
  } else if (context.languageId === "php") {
    handled = await applyPhpStatementOverride(context, normalizedStmt, typeOnly);
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
    alias?: string;
    wildcard?: boolean;
  },
): void {
  const { from, resolved, typeOnly, stmtText, alias, wildcard } = args;
  if (context.languageId === "java") {
    const parts = from.split(".");
    const last = parts[parts.length - 1];
    if (last === "*") {
      context.pushBinding({ kind: "star", from, resolved, typeOnly });
    } else if (last && JAVA_UPPERCASE_IDENTIFIER_PATTERN.test(last)) {
      context.pushBinding({ kind: "named", local: last, imported: last, from, resolved, typeOnly });
    }
  } else if (context.languageId === "csharp") {
    if (alias) {
      const fromParts = from.split(".");
      const imported = fromParts[fromParts.length - 1] ?? alias;
      context.pushBinding({ kind: "named", local: alias, imported, from, resolved, typeOnly });
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
        context.pushBinding({ kind: "named", local: last, imported: last, from, resolved });
      }
    }
  } else if (context.languageId === "kotlin") {
    if (wildcard || from.endsWith(".*")) {
      context.pushBinding({ kind: "star", from, resolved, typeOnly });
    } else {
      const parts = from.split(".");
      const imported = parts[parts.length - 1];
      if (imported)
        context.pushBinding({ kind: "named", local: alias ?? imported, imported, from, resolved, typeOnly });
    }
  } else if (context.languageId === "swift") {
    const parts = from.split(".");
    const last = parts[parts.length - 1];
    if (!last) return;
    if (parts.length === 1) {
      context.pushBinding({ kind: "namespace", localNS: last, from, resolved, typeOnly });
      context.pushBinding({ kind: "star", from, resolved, typeOnly });
    } else {
      context.pushBinding({ kind: "named", local: last, imported: last, from, resolved, typeOnly });
    }
  } else if (context.languageId === "zig") {
    if (alias) context.pushBinding({ kind: "namespace", localNS: alias, from, resolved, typeOnly });
  } else if (context.languageId === "c" || context.languageId === "cpp") {
    context.pushBinding({ kind: "star", from, resolved, typeOnly });
  }
}
