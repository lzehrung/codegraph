import { stripJsLikeComments } from "../../util.js";
import type { ImportBindingSink, ImportResolver } from "./context.js";

export type JsTextImportExtractionContext = ImportBindingSink & {
  source: string;
  languageId: string;
  resolveFrom: ImportResolver;
};

function sourceForTextImportExtraction(context: JsTextImportExtractionContext): string {
  if (context.languageId === "ts" || context.languageId === "tsx" || context.languageId === "js") {
    return stripJsLikeComments(context.source);
  }
  return context.source;
}

function splitNamedImports(namedBlock: string): string[] {
  return namedBlock
    .replace(/[{}]/g, "")
    .split(",")
    .map((spec) => spec.trim())
    .filter(Boolean);
}

async function collectEsImports(context: JsTextImportExtractionContext, source: string): Promise<void> {
  const typeOnlyImport = /\bimport\s+type\b/;
  const fromPattern = /^\s*import\s+([^\n;]*?)\s+from\s+(["'])(?<module>[^"']+)\2/gm;
  for (const match of source.matchAll(fromPattern)) {
    const clause = match[1]!.trim();
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const typeOnly = typeOnlyImport.test(match[0]);
    const resolved = await context.resolveFrom(moduleSpecifier);
    const namespaceMatch = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (namespaceMatch) {
      context.pushBinding({
        kind: "namespace",
        localNS: namespaceMatch[1]!,
        from: moduleSpecifier,
        resolved,
        typeOnly,
      });
      continue;
    }

    const parts = clause.split(",");
    if (!parts.length) continue;
    const first = parts[0]!.trim();
    if (first && !first.startsWith("{")) {
      context.pushBinding({
        kind: "default",
        local: first,
        from: moduleSpecifier,
        resolved,
        typeOnly,
      });
    }
    const namedBlock = parts.slice(1).join(",").trim() || (first.startsWith("{") ? first : "");
    for (const spec of splitNamedImports(namedBlock)) {
      const namedMatch = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!namedMatch) continue;
      const imported = namedMatch[1]!;
      const local = namedMatch[2] ?? imported;
      context.pushBinding({
        kind: "named",
        local,
        imported,
        from: moduleSpecifier,
        resolved,
        typeOnly,
      });
    }
  }
}

async function collectCommonJsImports(context: JsTextImportExtractionContext, source: string): Promise<void> {
  const defaultRequirePattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(["'])(?<module>[^"']+)\2\s*\)/g;
  for (const match of source.matchAll(defaultRequirePattern)) {
    const local = match[1]!;
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const resolved = await context.resolveFrom(moduleSpecifier);
    context.pushBinding({
      kind: "default",
      local,
      from: moduleSpecifier,
      resolved,
      mechanism: "cjs",
    });
  }

  const namedRequirePattern = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*(["'])(?<module>[^"']+)\2\s*\)/g;
  for (const match of source.matchAll(namedRequirePattern)) {
    const specs = match[1]!
      .split(",")
      .map((spec) => spec.trim())
      .filter(Boolean);
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const resolved = await context.resolveFrom(moduleSpecifier);
    for (const spec of specs) {
      const namedMatch = spec.match(/^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/);
      if (!namedMatch) continue;
      const imported = namedMatch[1]!;
      const local = namedMatch[2] ?? imported;
      context.pushBinding({
        kind: "named",
        local,
        imported,
        from: moduleSpecifier,
        resolved,
        mechanism: "cjs",
      });
    }
  }

  const importEqualsPattern = /\bimport\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(["'])(?<module>[^"']+)\2\s*\)/g;
  for (const match of source.matchAll(importEqualsPattern)) {
    const local = match[1]!;
    const moduleSpecifier = match.groups?.module;
    if (!moduleSpecifier) continue;
    const resolved = await context.resolveFrom(moduleSpecifier);
    context.pushBinding({
      kind: "default",
      local,
      from: moduleSpecifier,
      resolved,
      mechanism: "cjs",
    });
  }
}

export async function collectJsTextImports(context: JsTextImportExtractionContext): Promise<void> {
  const source = sourceForTextImportExtraction(context);
  await collectEsImports(context, source);
  await collectCommonJsImports(context, source);
}
