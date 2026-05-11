import fs from "node:fs";
import path from "node:path";
import {
  isJsFallbackAvailable,
  isJsFallbackUnavailableError,
  parseWithJsLanguage,
  type JsSyntaxTree,
} from "../jsFallback.js";
import { prepareSourceInput } from "../languages/filePrep.js";
import {
  parseCsharpUsingDirective,
  parseJavaImportStatement,
  parseKotlinImportStatement,
  parsePhpImportStatement,
  parseRustImportStatement,
} from "../languages/importStatementParsers.js";
import {
  getGraphOnlyResolutionExtensions,
  getPhpComposerImplicitFiles,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  resolveImportSpecifier,
  resolvePythonModule,
  resolveSpecifier,
  sliceText,
  stripJsLikeComments,
  stripPythonCommentsAndStrings,
  unquote,
} from "../util.js";
import { logWithLevel, type LogLevel } from "../logging.js";
import { type FallbackImportExtractionEvent, type FallbackImportExtractionReason } from "../graphs/specifiers.js";
import type { GraphBuildOptions } from "../graphs/types.js";
import {
  extractGraphOnlyModuleSpecifiers,
  graphOnlyLanguageSupportsImportAliases,
  graphOnlySpecifierNeedsResolutionConfig,
  isGraphOnlyLanguage,
} from "../documentLinks.js";
import { capturesByName, capturesNamed, rangeFromNativeCapture } from "../native/queryResults.js";
import {
  executeJsQueryAsNativeMatches,
  isNativeQueryAuthoritative,
  isNativeRequiredUnavailableError,
  shouldAvoidJsFallbackForLanguage,
  type NativeQueryResults,
} from "../native/treeSitterNative.js";
import { parseGoImportAlias } from "./shared.js";
import type { LanguageSupport } from "../languages.js";
import type { JsLanguage } from "../languages/types.js";
import type { ImportBinding } from "./types.js";

function parseObjectPatternBindings(patternText: string): Array<{ imported: string; local: string }> {
  const trimmed = patternText.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  const parts = body
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const out: Array<{ imported: string; local: string }> = [];
  for (const part of parts) {
    const withoutDefault = part.replace(/\s*=\s*.+$/, "").trim();
    const match = withoutDefault.match(/^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/);
    if (!match) continue;
    const imported = match[1]!;
    const local = match[2] ?? imported;
    out.push({ imported, local });
  }
  return out;
}

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: {
    source?: string;
    tree?: JsSyntaxTree;
    sup?: LanguageSupport;
    lang?: JsLanguage;
    nativeQueries?: NativeQueryResults | null;
    graphOptions?: GraphBuildOptions;
    onFallbackImportExtraction?: (event: FallbackImportExtractionEvent) => void;
    logLevel?: LogLevel;
  },
): Promise<ImportBinding[]> {
  let source = opts?.source;
  let sup = opts?.sup;
  let lang = opts?.lang;

  if (!source || !sup) {
    const prep = await prepareSourceInput(file, source !== undefined ? { source } : undefined);
    source = prep.source;
    sup = prep.sup;
  }

  const resolvedSource = source;
  const resolvedSup = sup;
  let resolvedLang = lang;
  if (isGraphOnlyLanguage(resolvedSup.id)) {
    const entries = Array.from(extractGraphOnlyModuleSpecifiers(resolvedSup.id, resolvedSource));
    const needsGraphOnlyResolutionConfig =
      graphOnlyLanguageSupportsImportAliases(resolvedSup.id) &&
      entries.some(({ spec }) => graphOnlySpecifierNeedsResolutionConfig(spec));
    const { matchPath } = needsGraphOnlyResolutionConfig
      ? await loadNearestTsconfigFor(file, opts?.logLevel)
      : { matchPath: undefined };
    const workspaceConfig = needsGraphOnlyResolutionConfig ? await loadWorkspaceConfig(projectRoot) : undefined;
    const resolutionHints = opts?.graphOptions?.resolutionHints;
    const resolvedSpecifiers = await Promise.all(
      entries.map((entry) =>
        resolveSpecifier(file, entry.spec, projectRoot, matchPath, workspaceConfig, {
          resolveNodeModules: !!opts?.graphOptions?.resolveNodeModules,
          resolutionExtensions: getGraphOnlyResolutionExtensions(resolvedSup.id, entry.resolutionKind ?? "document"),
          ...(resolutionHints ? { resolutionHints } : {}),
        }),
      ),
    );
    return entries.flatMap((entry, index) => {
      const resolved = resolvedSpecifiers[index];
      if (resolved === undefined) {
        throw new Error(`Missing graph-only resolution result for ${resolvedSup.id}:${entry.spec}`);
      }
      if (typeof resolved !== "string" && entry.dropIfUnresolved) {
        return [];
      }
      const from = entry.raw ?? entry.spec;
      return [
        {
          kind: "star" as const,
          from,
          ...(typeof resolved === "string"
            ? { resolved: resolved.replace(/\\/g, "/") }
            : { resolved: { ...resolved, external: from } }),
        },
      ];
    });
  }

  const resolvedNativeQueries = opts?.nativeQueries ?? null;
  const ensureResolvedLang = (): JsLanguage => {
    resolvedLang ??= resolvedSup.language(file);
    return resolvedLang;
  };

  const imports: ImportBinding[] = [];
  const reportFallback = (reason: FallbackImportExtractionReason) => {
    opts?.onFallbackImportExtraction?.({
      file: file.replace(/\\/g, "/"),
      language: resolvedSup.id,
      reason,
    });
  };
  const normalizeGoImports = (): void => {
    if (resolvedSup.id !== "go" || imports.length === 0) {
      return;
    }
    const aliasByFrom = new Map<string, string>();
    const importPattern = /^\s*(?:import\s+)?(?:(?<alias>[._A-Za-z][\w]*)\s+)?["'`](?<from>[^"'`]+)["'`]/gm;
    for (const match of resolvedSource.matchAll(importPattern)) {
      const from = match.groups?.from;
      if (!from) continue;
      const alias = match.groups?.alias;
      if (alias) {
        aliasByFrom.set(from, alias);
      }
    }

    if (aliasByFrom.size === 0) {
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

    imports.splice(0, imports.length, ...normalized);
  };
  const appendJavaTextImports = async (): Promise<void> => {
    if (resolvedSup.id !== "java" || imports.length > 0) {
      return;
    }
    const importPattern = /^\s*import\s+(static\s+)?([A-Za-z_][\w.]*(?:\.\*)?)\s*;/gm;
    for (const match of resolvedSource.matchAll(importPattern)) {
      const isStatic = !!match[1];
      const rawSpec = match[2];
      if (!rawSpec) continue;
      if (rawSpec.endsWith(".*")) {
        const resolved = await resolveFrom(isStatic ? rawSpec.slice(0, -2) : rawSpec);
        imports.push({
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
      const resolved = await resolveFrom(fromValue);
      imports.push({
        kind: "named",
        local: imported,
        imported,
        from: fromValue,
        resolved,
        typeOnly: false,
      });
    }
  };
  const appendKotlinTextImports = async (): Promise<void> => {
    if (resolvedSup.id !== "kotlin" || imports.length > 0) {
      return;
    }
    const importPattern = /^\s*import\s+([A-Za-z_][\w.]*(?:\.\*)?)(?:\s+as\s+([A-Za-z_][\w]*))?\s*$/gm;
    for (const match of resolvedSource.matchAll(importPattern)) {
      const rawSpec = match[1];
      if (!rawSpec) continue;
      if (rawSpec.endsWith(".*")) {
        const fromValue = rawSpec.slice(0, -2);
        const resolved = await resolveFrom(fromValue);
        imports.push({
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
      const resolved = await resolveFrom(rawSpec);
      imports.push({
        kind: "named",
        local: match[2] ?? imported,
        imported,
        from: rawSpec,
        resolved,
        typeOnly: false,
      });
    }
  };
  const appendPhpComposerImplicitImports = async (): Promise<void> => {
    if (resolvedSup.id !== "php") {
      return;
    }

    const implicitFiles = await getPhpComposerImplicitFiles(projectRoot, file);
    const seenResolved = new Set(
      imports
        .map((entry) => (typeof entry.resolved === "string" ? entry.resolved : null))
        .filter((entry): entry is string => !!entry),
    );

    for (const implicitFile of implicitFiles) {
      const normalizedResolved = implicitFile.replace(/\\/g, "/");
      if (normalizedResolved === file.replace(/\\/g, "/")) {
        continue;
      }
      if (seenResolved.has(normalizedResolved)) {
        continue;
      }

      const relativeFrom = path.relative(path.dirname(file), implicitFile).replace(/\\/g, "/");
      const from = relativeFrom.startsWith(".") || relativeFrom.startsWith("/") ? relativeFrom : `./${relativeFrom}`;
      imports.push({
        kind: "star",
        from,
        resolved: normalizedResolved,
        mechanism: "php",
      });
      seenResolved.add(normalizedResolved);
    }
  };
  const finalizeLanguageSpecificImports = async (): Promise<void> => {
    normalizeGoImports();
    await appendJavaTextImports();
    await appendKotlinTextImports();
    await appendPhpComposerImplicitImports();
  };
  const handledStatementImports = new Set<string>();
  const applyStatementImportOverride = async (stmtText: string, typeOnly: boolean): Promise<boolean> => {
    const normalizedStmt = stmtText.trim();
    if (!normalizedStmt) return false;

    if (resolvedSup.id === "csharp") {
      const parsed = parseCsharpUsingDirective(normalizedStmt);
      if (!parsed) return false;
      if (handledStatementImports.has(normalizedStmt)) return true;
      handledStatementImports.add(normalizedStmt);

      let fromValue = parsed.from;
      let resolved = await resolveFrom(fromValue);
      if (parsed.alias) {
        const fromParts = parsed.from.split(".");
        const imported = fromParts[fromParts.length - 1] ?? parsed.alias;
        if (typeof resolved !== "string" && fromParts.length > 1) {
          const fallbackFrom = fromParts.slice(0, -1).join(".");
          if (fallbackFrom) {
            const fallbackResolved = await resolveFrom(fallbackFrom);
            if (typeof fallbackResolved === "string") {
              fromValue = fallbackFrom;
              resolved = fallbackResolved;
            }
          }
        }
        imports.push({
          kind: "named",
          local: parsed.alias,
          imported,
          from: fromValue,
          resolved,
          typeOnly,
        });
      } else {
        imports.push({
          kind: "star",
          from: fromValue,
          resolved,
          typeOnly,
        });
      }
      return true;
    }

    if (resolvedSup.id === "java") {
      const parsed = parseJavaImportStatement(normalizedStmt);
      if (!parsed) return false;
      if (handledStatementImports.has(normalizedStmt)) return true;
      handledStatementImports.add(normalizedStmt);

      const resolved = await resolveFrom(parsed.from);
      if (parsed.kind === "star") {
        imports.push({
          kind: "star",
          from: parsed.from,
          resolved,
          typeOnly,
        });
      } else {
        imports.push({
          kind: "named",
          local: parsed.imported,
          imported: parsed.imported,
          from: parsed.from,
          resolved,
          typeOnly,
        });
      }
      return true;
    }

    if (resolvedSup.id === "kotlin") {
      const parsed = parseKotlinImportStatement(normalizedStmt);
      if (!parsed) return false;
      if (handledStatementImports.has(normalizedStmt)) return true;
      handledStatementImports.add(normalizedStmt);

      const resolved = await resolveFrom(parsed.from);
      if (parsed.kind === "star") {
        imports.push({
          kind: "star",
          from: parsed.from,
          resolved,
          typeOnly,
        });
      } else {
        imports.push({
          kind: "named",
          local: parsed.local,
          imported: parsed.imported,
          from: parsed.from,
          resolved,
          typeOnly,
        });
      }
      return true;
    }

    if (resolvedSup.id === "rust") {
      const parsed = parseRustImportStatement(normalizedStmt);
      if (!parsed) return false;
      if (handledStatementImports.has(normalizedStmt)) return true;
      handledStatementImports.add(normalizedStmt);

      const resolved = await resolveFrom(parsed.from);
      if (parsed.kind === "member") {
        imports.push({
          kind: "named",
          local: parsed.local,
          imported: parsed.imported,
          from: parsed.from,
          resolved,
          typeOnly,
        });
      } else if (parsed.kind === "module") {
        imports.push({
          kind: "namespace",
          localNS: parsed.local,
          from: parsed.from,
          resolved,
          typeOnly,
        });
      } else {
        imports.push({
          kind: "star",
          from: parsed.from,
          resolved,
          typeOnly,
        });
      }
      return true;
    }

    if (resolvedSup.id === "php") {
      const parsed = parsePhpImportStatement(normalizedStmt, file);
      if (parsed.length === 0) return false;
      if (handledStatementImports.has(normalizedStmt)) return true;
      handledStatementImports.add(normalizedStmt);

      for (const entry of parsed) {
        if (entry.kind === "include") {
          const resolved = await resolveFrom(entry.from);
          imports.push({
            kind: "star",
            from: entry.from,
            resolved,
            typeOnly,
            mechanism: "php",
          });
          continue;
        }
        const resolved = await resolveFrom(entry.from, entry.importType);
        imports.push({
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

    return false;
  };

  if (resolvedSup.id === "python") {
    const pySrc = stripPythonCommentsAndStrings(resolvedSource);
    const pushStar = async (moduleSpec: string) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? m[2] || null : moduleSpec;
      const resolved = await resolvePythonModule(projectRoot, file, mod, relDots);
      imports.push({
        kind: "star",
        from: moduleSpec,
        resolved,
        mechanism: "python",
      });
    };
    const pushNamed = async (moduleSpec: string, imported: string, local: string) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? m[2] || null : moduleSpec;
      const resolved = await resolvePythonModule(projectRoot, file, mod, relDots);
      let nsResolved: string | undefined;
      if (typeof resolved === "string") {
        let baseDir = resolved;
        try {
          const st = fs.statSync(baseDir);
          if (!st.isDirectory() && baseDir.toLowerCase().endsWith("__init__.py")) baseDir = path.dirname(baseDir);
        } catch {
          /* stat failed */
        }
        const sub = [
          path.join(baseDir, `${imported}.py`),
          path.join(baseDir, imported, "__init__.py"),
          path.join(baseDir, imported),
        ];
        for (const c of sub) {
          try {
            if (fs.existsSync(c)) {
              nsResolved = c.replace(/\\/g, "/");
              break;
            }
          } catch {
            /* existsSync/stat: ignore */
          }
        }
      }
      if (nsResolved) {
        imports.push({
          kind: "namespace",
          localNS: local,
          from: moduleSpec,
          resolved: nsResolved,
          mechanism: "python",
        });
      } else {
        imports.push({
          kind: "named",
          local,
          imported,
          from: moduleSpec,
          resolved,
          mechanism: "python",
        });
      }
    };
    const pushDefault = async (dotted: string, local: string) => {
      const resolved = await resolvePythonModule(projectRoot, file, dotted, 0);
      imports.push({
        kind: "namespace",
        localNS: local,
        from: dotted,
        resolved,
        mechanism: "python",
      });
    };

    const reFromLine = /^\s*from\s+([^\s]+)\s+import\s+([^\n#]+)/gm;
    for (const m of pySrc.matchAll(reFromLine)) {
      const mod = m[1]!.trim();
      const items = m[2]!.split(",").map((s) => s.trim());
      for (const it of items) {
        if (it === "*") {
          await pushStar(mod);
          continue;
        }
        const am = it.match(/^([A-Za-z_][\w_]*)(?:\s+as\s+([A-Za-z_][\w_]*))?$/);
        if (am) {
          const imported = am[1]!;
          const local = am[2] ?? imported;
          await pushNamed(mod, imported, local);
        }
      }
    }
    const reImp = /^(?:\s*)import\s+([A-Za-z_][\w.]*)\s*(?:as\s+([A-Za-z_][\w_]*))?/gm;
    for (const m of pySrc.matchAll(reImp)) {
      const dotted = m[1]!;
      const local = (m[2] ?? dotted.split(".")[0]) as string;
      await pushDefault(dotted, local);
    }
    return imports;
  }

  let key: "py" | "js" | "ts" = "ts";
  if (resolvedSup.id === "python") {
    key = "py";
  } else if (resolvedSup.id === "js") {
    key = "js";
  }
  const tsCfg =
    resolvedSup.id === "ts" || resolvedSup.id === "tsx"
      ? await loadNearestTsconfigFor(file, opts?.logLevel)
      : undefined;
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);

  const resolveFrom = async (from: string, phpImportType?: "class" | "function" | "const") => {
    const resolutionHints = opts?.graphOptions?.resolutionHints;
    const resolved = await resolveImportSpecifier(projectRoot, file, from, resolvedSup.id, {
      ...(tsCfg?.matchPath ? { matchPath: tsCfg.matchPath } : {}),
      ...(workspaceConfig ? { workspaceConfig } : {}),
      resolveNodeModules: !!opts?.graphOptions?.resolveNodeModules,
      ...(resolutionHints ? { resolutionHints } : {}),
      ...(phpImportType ? { phpImportType } : {}),
    });
    return typeof resolved === "string" ? resolved.replace(/\\/g, "/") : resolved;
  };

  const runFallback = async () => {
    const src =
      resolvedSup.id === "ts" || resolvedSup.id === "tsx" || resolvedSup.id === "js"
        ? stripJsLikeComments(resolvedSource)
        : resolvedSource;
    const typeOnlyImport = /\bimport\s+type\b/;
    const reFrom = /^\s*import\s+([^\n;]*?)\s+from\s+(["'])(?<m>[^"']+)\2/gm;
    for (const m of src.matchAll(reFrom)) {
      const rawClause = m[1]!.trim();
      const inlineTypeOnly = /^type\b/.test(rawClause);
      const clause = inlineTypeOnly ? rawClause.replace(/^type\b\s*/, "") : rawClause;
      const mod = m.groups?.m as string;
      const typeOnly = typeOnlyImport.test(m[0]) || inlineTypeOnly;
      const resolved = await resolveFrom(mod);
      const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (ns) {
        imports.push({
          kind: "namespace",
          localNS: ns[1]!,
          from: mod,
          resolved,
          typeOnly,
        });
        continue;
      }
      const parts = clause.split(",");
      if (parts.length) {
        const first = parts[0]!.trim();
        if (first && !first.startsWith("{"))
          imports.push({
            kind: "default",
            local: first,
            from: mod,
            resolved,
            typeOnly,
          });
        const namedBlock = parts.slice(1).join(",").trim() || (first.startsWith("{") ? first : "");
        const names = namedBlock
          .replace(/[{}]/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const spec of names) {
          const nm = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (!nm) continue;
          const imported = nm[1]!;
          const local = nm[2] ?? imported;
          imports.push({
            kind: "named",
            local,
            imported,
            from: mod,
            resolved,
            typeOnly,
          });
        }
      }
    }
    const reReqDefault = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
    for (const m of src.matchAll(reReqDefault)) {
      const local = m[1]!;
      const mod = m.groups?.m as string;
      const resolved = await resolveFrom(mod);
      imports.push({
        kind: "default",
        local,
        from: mod,
        resolved,
        mechanism: "cjs",
      });
    }
    const reReqNamed = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
    for (const m of src.matchAll(reReqNamed)) {
      const specs = m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const mod = m.groups?.m as string;
      const resolved = await resolveFrom(mod);
      for (const spec of specs) {
        const nm = spec.match(/^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/);
        if (!nm) continue;
        const imported = nm[1]!;
        const local = nm[2] ?? imported;
        imports.push({
          kind: "named",
          local,
          imported,
          from: mod,
          resolved,
          mechanism: "cjs",
        });
      }
    }
    const reImportEquals = /\bimport\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
    for (const m of src.matchAll(reImportEquals)) {
      const local = m[1]!;
      const mod = m.groups?.m as string;
      const resolved = await resolveFrom(mod);
      imports.push({
        kind: "default",
        local,
        from: mod,
        resolved,
        mechanism: "cjs",
      });
    }
  };

  const shouldUseTextImportRecoveryOnly = shouldAvoidJsFallbackForLanguage(resolvedSup.id);
  const hasPotentialTextImportRecovery =
    shouldUseTextImportRecoveryOnly && /\b(import|require|from)\b/.test(resolvedSource);

  if (shouldUseTextImportRecoveryOnly) {
    const importCountBeforeFallback = imports.length;
    if (hasPotentialTextImportRecovery) {
      await runFallback();
    }
    await finalizeLanguageSpecificImports();
    if (imports.length > importCountBeforeFallback && !isJsFallbackAvailable()) {
      reportFallback("js-fallback-unavailable");
    }
    return imports;
  }

  if (resolvedNativeQueries) {
    try {
      for (const match of resolvedNativeQueries.importBindings) {
        const caps = capturesByName(match);
        const stmtText = caps["stmt"]?.text ?? "";
        const typeOnly = resolvedSup.isTypeOnly(stmtText);
        if (await applyStatementImportOverride(stmtText, typeOnly)) {
          continue;
        }
        const from = caps["from"] ? unquote(caps["from"].text) : undefined;
        const patterns = capturesNamed(match, "pattern");

        for (const pattern of patterns) {
          if (pattern.nodeType !== "object_pattern" || !from) continue;
          const resolved = await resolveFrom(from);
          for (const binding of parseObjectPatternBindings(pattern.text)) {
            imports.push({
              kind: "named",
              local: binding.local,
              imported: binding.imported,
              from,
              resolved,
              typeOnly,
            });
          }
        }

        if (!from) continue;
        const resolved = await resolveFrom(from);
        if (caps["def"]) {
          imports.push({
            kind: "default",
            local: caps["def"].text,
            from,
            resolved,
            typeOnly,
          });
        }
        if (caps["ns"]) {
          if (resolvedSup.id === "go") {
            const alias = parseGoImportAlias(stmtText);
            if (alias === ".") {
              imports.push({
                kind: "star",
                from,
                resolved,
                typeOnly,
              });
            } else if (alias !== "_") {
              imports.push({
                kind: "namespace",
                localNS: alias ?? caps["ns"].text,
                from,
                resolved,
                typeOnly,
              });
            }
          } else {
            imports.push({
              kind: "namespace",
              localNS: caps["ns"].text,
              from,
              resolved,
              typeOnly,
            });
          }
        }

        const inames = capturesNamed(match, "iname");
        const aliases = capturesNamed(match, "alias");
        for (let i = 0; i < inames.length; i++) {
          const imported = inames[i]!.text;
          const alias = aliases[i]?.text ?? imported;
          imports.push({
            kind: "named",
            local: alias,
            imported,
            from,
            resolved,
            typeOnly,
          });
        }

        if (!caps["def"] && !caps["ns"] && inames.length === 0 && patterns.length === 0) {
          if (resolvedSup.id === "java") {
            const parts = from.split(".");
            const last = parts[parts.length - 1];
            if (last === "*") {
              imports.push({ kind: "star", from, resolved, typeOnly });
            } else if (last && /^[A-Z]/.test(last)) {
              imports.push({
                kind: "named",
                local: last,
                imported: last,
                from,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "csharp") {
            if (caps["alias"]) {
              const alias = caps["alias"].text;
              const fromParts = from.split(".");
              const imported = fromParts[fromParts.length - 1] ?? alias;
              imports.push({
                kind: "named",
                local: alias,
                imported,
                from,
                resolved,
                typeOnly,
              });
            } else {
              imports.push({ kind: "star", from, resolved, typeOnly });
            }
          } else if (resolvedSup.id === "ruby") {
            imports.push({ kind: "star", from, resolved });
          } else if (resolvedSup.id === "go") {
            if (caps["alias"]) {
              const alias = caps["alias"].text;
              if (alias === ".") {
                imports.push({
                  kind: "star",
                  from,
                  resolved,
                });
                continue;
              }
              if (alias === "_") {
                continue;
              }
              imports.push({
                kind: "namespace",
                localNS: alias,
                from,
                resolved,
              });
            } else {
              const parts = from.replace(/"/g, "").split("/");
              const last = parts[parts.length - 1];
              if (last) {
                imports.push({
                  kind: "namespace",
                  localNS: last,
                  from,
                  resolved,
                });
              }
            }
          } else if (resolvedSup.id === "rust") {
            if (stmtText.startsWith("mod ")) {
              imports.push({
                kind: "namespace",
                localNS: from,
                from,
                resolved,
              });
            } else {
              const parts = from.split("::");
              const last = parts[parts.length - 1];
              if (!last) continue;
              if (last === "*") {
                imports.push({ kind: "star", from, resolved });
              } else {
                imports.push({
                  kind: "named",
                  local: last,
                  imported: last,
                  from,
                  resolved,
                });
              }
            }
          } else if (resolvedSup.id === "kotlin") {
            const wildcard = !!caps["wild"] || from.endsWith(".*");
            if (wildcard) {
              imports.push({ kind: "star", from, resolved, typeOnly });
            } else {
              const parts = from.split(".");
              const imported = parts[parts.length - 1];
              if (!imported) continue;
              imports.push({
                kind: "named",
                local: caps["alias"]?.text ?? imported,
                imported,
                from,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "swift") {
            const parts = from.split(".");
            const last = parts[parts.length - 1];
            if (!last) continue;
            if (parts.length === 1) {
              imports.push({
                kind: "namespace",
                localNS: last,
                from,
                resolved,
                typeOnly,
              });
              imports.push({ kind: "star", from, resolved, typeOnly });
            } else {
              imports.push({
                kind: "named",
                local: last,
                imported: last,
                from,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "zig") {
            const alias = caps["alias"]?.text;
            if (alias) {
              imports.push({
                kind: "namespace",
                localNS: alias,
                from,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "c" || resolvedSup.id === "cpp") {
            imports.push({ kind: "star", from, resolved, typeOnly });
          }
        }
      }
      await finalizeLanguageSpecificImports();
      // Native succeeded -- treat the result as authoritative even if empty,
      // but only when the importBindings query was not modified by
      // normalization. Languages whose importBindings query is normalized
      // or blanked (e.g. Kotlin) may need the JS/text fallback.
      if (imports.length > 0 || isNativeQueryAuthoritative(resolvedSup, "importBindings")) {
        return imports;
      }
    } catch {
      imports.length = 0;
    }
  }

  try {
    let tree: JsSyntaxTree;
    try {
      tree = opts?.tree ?? parseWithJsLanguage(resolvedSource, ensureResolvedLang());
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      if (isJsFallbackUnavailableError(error)) {
        reportFallback("js-fallback-unavailable");
        logWithLevel(
          opts?.logLevel,
          "debug",
          `JS fallback unavailable for ${resolvedSup.id} import-binding recovery; using regex import extraction.`,
        );
        await runFallback();
        await finalizeLanguageSpecificImports();
        return imports;
      }
      throw error;
    }
    let ranFallback = false;
    try {
      const matches = executeJsQueryAsNativeMatches(
        resolvedSource,
        resolvedSup,
        ensureResolvedLang(),
        resolvedSup.queries.importBindings,
        tree,
      );
      for (const match of matches) {
        const caps = Object.fromEntries(match.captures.map((capture) => [capture.name, capture] as const));
        const stmtText = caps["stmt"]?.text ?? "";
        const typeOnly = resolvedSup.isTypeOnly(stmtText);
        if (await applyStatementImportOverride(stmtText, typeOnly)) {
          continue;
        }
        const from: string | undefined = caps["from"] ? unquote(caps["from"].text) : undefined;

        const patterns = match.captures.filter((capture) => capture.name === "pattern");
        for (const pattern of patterns) {
          const patternRange = rangeFromNativeCapture(pattern);
          const patternNode = tree.rootNode.descendantForIndex(
            patternRange.start.index ?? 0,
            patternRange.end.index ?? 0,
          );
          if (patternNode.type === "object_pattern" && from) {
            for (const child of patternNode.namedChildren) {
              if (
                child.type === "shorthand_property_identifier" ||
                child.type === "shorthand_property_identifier_pattern"
              ) {
                const name = sliceText(child, source);
                const resolved = await resolveFrom(from);
                imports.push({
                  kind: "named",
                  local: name,
                  imported: name,
                  from,
                  resolved,
                  typeOnly,
                });
              } else if (child.type === "pair_pattern") {
                const key = child.childForFieldName("key");
                const value = child.childForFieldName("value");
                if (key && value && key.type === "property_identifier" && value.type === "identifier") {
                  const imported = sliceText(key, source);
                  const local = sliceText(value, source);
                  const resolved = await resolveFrom(from);
                  imports.push({
                    kind: "named",
                    local,
                    imported,
                    from,
                    resolved,
                    typeOnly,
                  });
                }
              }
            }
          }
        }

        if (!from) continue;
        const fromValue = from;
        const resolved = await resolveFrom(fromValue);
        if (caps["def"]) {
          imports.push({
            kind: "default",
            local: caps["def"].text,
            from: fromValue,
            resolved,
            typeOnly,
          });
        }
        if (caps["ns"]) {
          const nsName = caps["ns"].text;
          if (resolvedSup.id === "go") {
            const alias = parseGoImportAlias(stmtText);
            if (alias === ".") {
              imports.push({
                kind: "star",
                from: fromValue,
                resolved,
                typeOnly,
              });
            } else if (alias !== "_") {
              imports.push({
                kind: "namespace",
                localNS: alias ?? nsName,
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else {
            imports.push({
              kind: "namespace",
              localNS: nsName,
              from: fromValue,
              resolved,
              typeOnly,
            });
          }
        }
        const inames = match.captures.filter((capture) => capture.name === "iname");
        const aliases = match.captures.filter((capture) => capture.name === "alias");
        for (let i = 0; i < inames.length; i++) {
          const imported = inames[i]!.text;
          const alias = aliases[i]?.text ?? imported;
          imports.push({
            kind: "named",
            local: alias,
            imported,
            from: fromValue,
            resolved,
            typeOnly,
          });
        }

        // Heuristics for languages where we captured @from but no explicit bindings
        if (fromValue && !caps["def"] && !caps["ns"] && inames.length === 0 && patterns.length === 0) {
          if (resolvedSup.id === "java") {
            // import java.util.List; -> local "List"
            const parts = fromValue.split(".");
            const last = parts[parts.length - 1];
            if (last === "*") {
              imports.push({
                kind: "star",
                from: fromValue,
                resolved,
                typeOnly,
              });
            } else if (last && /^[A-Z]/.test(last)) {
              imports.push({
                kind: "named",
                local: last,
                imported: last,
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "csharp") {
            const aliasNode = caps["alias"];
            if (aliasNode) {
              const alias = aliasNode.text;
              // For "using Alias = Type.Path;", try to grab the last part as the imported name
              let imported = alias;
              const fromParts = fromValue.split(".");
              if (fromParts.length > 0) {
                const candidate = fromParts[fromParts.length - 1];
                if (candidate) imported = candidate;
              }

              imports.push({
                kind: "named",
                local: alias,
                imported,
                from: fromValue,
                resolved,
                typeOnly,
              });
            } else {
              // implicit namespace import - treated as star to bring members into scope
              imports.push({
                kind: "star",
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "ruby") {
            // require 'foo' -> star import to bring constants into scope
            imports.push({ kind: "star", from: fromValue, resolved });
          } else if (resolvedSup.id === "go") {
            // import "fmt" -> local "fmt"
            // import "github.com/pkg/foo" -> local "foo"
            const aliasNode = caps["alias"];
            if (aliasNode) {
              const alias = aliasNode.text;
              if (alias === ".") {
                imports.push({
                  kind: "star",
                  from: fromValue,
                  resolved,
                });
                continue;
              }
              if (alias === "_") {
                continue;
              }
              imports.push({
                kind: "namespace",
                localNS: alias,
                from: fromValue,
                resolved,
              });
            } else {
              const parts = fromValue.replace(/"/g, "").split("/");
              const last = parts[parts.length - 1];
              if (!last) continue;
              imports.push({
                kind: "namespace",
                localNS: last,
                from: fromValue,
                resolved,
              });
            }
          } else if (resolvedSup.id === "rust") {
            // mod utils; -> namespace (from="utils")
            // use foo::bar; -> named (from="foo::bar")
            if (stmtText.startsWith("mod ")) {
              // treat 'mod name;' as namespace import pointing to name.rs / name/mod.rs
              imports.push({
                kind: "namespace",
                localNS: fromValue,
                from: fromValue,
                resolved,
              });
            } else {
              const parts = fromValue.split("::");
              const last = parts[parts.length - 1];
              if (!last) continue;
              if (last === "*") {
                imports.push({ kind: "star", from: fromValue, resolved });
              } else {
                imports.push({
                  kind: "named",
                  local: last,
                  imported: last,
                  from: fromValue,
                  resolved,
                });
              }
            }
          } else if (resolvedSup.id === "kotlin") {
            const aliasNode = caps["alias"];
            const wildcard = !!caps["wild"] || fromValue.endsWith(".*");
            if (wildcard) {
              imports.push({
                kind: "star",
                from: fromValue,
                resolved,
                typeOnly,
              });
            } else {
              const parts = fromValue.split(".");
              const imported = parts[parts.length - 1];
              if (!imported) continue;
              const local = aliasNode ? aliasNode.text : imported;
              imports.push({
                kind: "named",
                local,
                imported,
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "swift") {
            const parts = fromValue.split(".");
            const last = parts[parts.length - 1];
            if (!last) continue;
            if (parts.length === 1) {
              imports.push({
                kind: "namespace",
                localNS: last,
                from: fromValue,
                resolved,
                typeOnly,
              });
              imports.push({
                kind: "star",
                from: fromValue,
                resolved,
                typeOnly,
              });
            } else {
              imports.push({
                kind: "named",
                local: last,
                imported: last,
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "zig") {
            const alias = caps["alias"]?.text;
            if (alias) {
              imports.push({
                kind: "namespace",
                localNS: alias,
                from: fromValue,
                resolved,
                typeOnly,
              });
            }
          } else if (resolvedSup.id === "c" || resolvedSup.id === "cpp") {
            imports.push({
              kind: "star",
              from: fromValue,
              resolved,
              typeOnly,
            });
          }
        }
      }
    } catch (error) {
      if (isNativeRequiredUnavailableError(error)) throw error;
      if (isJsFallbackUnavailableError(error)) {
        reportFallback("js-fallback-unavailable");
      }
      await runFallback();
      ranFallback = true;
    }
    await finalizeLanguageSpecificImports();
    // Only run fallback when query path produced no results
    if (!ranFallback && imports.length === 0) {
      await runFallback();
      await finalizeLanguageSpecificImports();
    }
    return imports;
  } finally {
    // No parser cleanup required: JS fallback parsing is delegated to
    // the optional JS fallback loader bridge.
  }
}
