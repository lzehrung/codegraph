import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import Parser from "tree-sitter";
import crypto from "node:crypto";
import { supportForFile, languageForFile, getCompiledQueries } from "./languages.js";
import {
  listProjectFiles,
  sliceText,
  toRange,
  unquote,
  stripJsLikeComments,
  stripPythonCommentsAndStrings,
  loadNearestTsconfigFor,
  loadWorkspaceConfig,
  resolveSpecifier,
  resolvePythonModule,
  acquireParser,
  releaseParser,
} from "./util.js";
import { collectGraph } from "./graphs.js";
import type { Pos, Range, FileId, Graph } from "./types.js";

export enum SymbolKind {
  Function = "function",
  Class = "class",
  Variable = "variable",
  Interface = "interface",
  TypeAlias = "type",
  Default = "default",
}

// Shared Pos, Range, FileId types imported from ./types

export type SymbolDef = {
  file: FileId;
  localName: string;
  kind: SymbolKind;
  range: Range;
};

export type ExportEntry =
  | { type: "local"; exportedAs: string; target: SymbolDef }
  | {
      type: "reexport";
      exportedAs: string;
      fromModule: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    }
  | {
      type: "exportStar";
      fromModule: string;
      sourceSpecifier: string;
      typeOnly?: boolean;
    };

export type ImportBinding =
  | {
      kind: "default";
      local: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python";
    }
  | {
      kind: "named";
      local: string;
      imported: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python";
    }
  | {
      kind: "namespace";
      localNS: string;
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python";
    }
  | {
      kind: "star";
      from: string;
      resolved?: FileId | { external: string };
      typeOnly?: boolean;
      mechanism?: "es" | "cjs" | "python";
    };

export type ModuleIndex = {
  file: FileId;
  exports: ExportEntry[];
  imports: ImportBinding[];
  locals: SymbolDef[];
};

export type ProjectIndex = {
  graph: Graph;
  modules: Map<FileId, ModuleIndex>;
  byFile: Map<FileId, ModuleIndex>;
  exportCache: Map<string, ResolvedExport | null>;
  parsed?: Map<
    string,
    {
      source: string;
      tree: Parser.Tree;
      sup: ReturnType<typeof supportForFile>;
      lang: Parser.Language;
    }
  >;
};
export type ResolvedExport = { kind: "resolved"; def: SymbolDef };

export type BuildOptions = {
  threads?: number;
  cache?: "off" | "memory" | "disk";
  cacheDir?: string;
  cacheStrict?: boolean;
};

// ---------------- Symbol handles (agent-friendly) ----------------
export type SymbolHandle = string;

export function symbolId(def: SymbolDef): SymbolHandle {
  const idx = (def as any)?.range?.start?.index ?? 0;
  return `${def.file}::${def.localName}::${idx}`;
}

export function defFromSymbolId(
  index: ProjectIndex,
  id: SymbolHandle
): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length < 3) return null;
  const rawFile = parts[0]!;
  const localName = parts[1]!;
  const startStr = parts[2]!;
  const file = rawFile.replace(/\\/g, "/");
  const startIndex = Number(startStr);
  const mod = index.byFile.get(file);
  if (!mod) return null;
  const exact = mod.locals.find(
    (d) => d.localName === localName && ((d as any).range?.start?.index ?? 0) === startIndex
  );
  if (exact) return exact;
  const byName = mod.locals.find((d) => d.localName === localName);
  return byName ?? null;
}

export function resolveSymbolId(
  index: ProjectIndex,
  id: SymbolHandle
): SymbolDef | null {
  if (!id) return null;
  const parts = id.split("::");
  if (parts.length === 3 && parts[2] === "import") {
    const rawFile = parts[0]!;
    const alias = parts[1]!;
    const file = rawFile.replace(/\\/g, "/");
    const mod = index.byFile.get(file);
    if (!mod) return null;

    // Prefer named, then default, then namespace
    const named = mod.imports.find((i) => (i as any).kind === "named" && (i as any).local === alias) as any;
    if (named) {
      const def = resolveImported(index, named, named.imported);
      if (def) return def;
      const target = typeof named.resolved === "string" ? named.resolved : undefined;
      if (target) {
        const hit = resolveExport(index, target, named.imported);
        if (hit?.def) return hit.def;
      }
    }

    const deflt = mod.imports.find((i) => (i as any).kind === "default" && (i as any).local === alias) as any;
    if (deflt) {
      const def = resolveImported(index, deflt, "default");
      if (def) return def;
      const target = typeof deflt.resolved === "string" ? deflt.resolved : undefined;
      if (target) {
        const hit = resolveExport(index, target, "default");
        if (hit?.def) return hit.def;
        const tmod = index.byFile.get(target);
        const first = tmod?.exports.find((e: any) => e.type === "local") as any;
        if (first) return first.target as SymbolDef;
      }
    }

    const ns = mod.imports.find((i) => (i as any).kind === "namespace" && (i as any).localNS === alias) as any;
    if (ns) {
      const target = typeof ns.resolved === "string" ? ns.resolved : undefined;
      if (target) {
        const tmod = index.byFile.get(target);
        const first = tmod?.exports.find((e: any) => e.type === "local") as any;
        if (first) return first.target as SymbolDef;
        const firstLocal = tmod?.locals?.[0];
        if (firstLocal) return firstLocal;
      }
    }

    return null;
  }

  // Otherwise treat as direct definition handle
  return defFromSymbolId(index, id);
}

export async function goToDefinitionById(
  index: ProjectIndex,
  id: SymbolHandle
): Promise<GoToResult> {
  const def = resolveSymbolId(index, id);
  if (def) return { status: "ok", definition: def };
  return { status: "not_found", reason: "No matching definition for handle" };
}

export async function findReferencesById(
  index: ProjectIndex,
  id: SymbolHandle
) {
  const def = resolveSymbolId(index, id);
  if (!def)
    return { status: "not_found", reason: "No matching definition for handle" } as const;
  return await findReferences(index, { def });
}

export type SymbolListItem = {
  id: SymbolHandle;
  file: FileId;
  name: string;
  kind: SymbolKind | "import" | "namespaceImport";
};

export function listSymbols(
  index: ProjectIndex,
  opts?: { file?: FileId; includeImports?: boolean }
): SymbolListItem[] {
  const out: SymbolListItem[] = [];
  const files = opts?.file
    ? [opts.file.replace(/\\/g, "/")] 
    : Array.from(index.byFile.keys());

  for (const f of files) {
    const mod = index.byFile.get(f);
    if (!mod) continue;
    for (const def of mod.locals) {
      out.push({ id: symbolId(def), file: f, name: def.localName, kind: def.kind });
    }
    if (opts?.includeImports) {
      for (const imp of mod.imports) {
        if ((imp as any).kind === "named")
          out.push({ id: `${f}::${(imp as any).local}::import`, file: f, name: (imp as any).local, kind: "import" });
        else if ((imp as any).kind === "default")
          out.push({ id: `${f}::${(imp as any).local}::import`, file: f, name: (imp as any).local, kind: "import" });
        else if ((imp as any).kind === "namespace")
          out.push({ id: `${f}::${(imp as any).localNS}::import`, file: f, name: (imp as any).localNS, kind: "namespaceImport" });
      }
    }
  }

  return out;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  let running = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      if (idx >= items.length && running === 0) {
        resolve(out);
        return;
      }
      while (running < limit && idx < items.length) {
        const cur = idx++;
        running++;
        fn(items[cur]!)
          .then((res) => {
            out[cur] = res;
            running--;
            next();
          })
          .catch(reject);
      }
    };
    next();
  });
}

// ---------------- Incremental cache (memory/disk) ----------------
type ModuleCacheEntry = { sig: string; mod: ModuleIndex };
const memoryCache = new Map<string, ModuleCacheEntry>();

async function fileSignature(file: string, strict?: boolean): Promise<string> {
  try {
    const st = await fsp.stat(file);
    if (!strict) return `${st.mtimeMs}:${st.size}`;
    const buf = await fsp.readFile(file);
    const h = crypto.createHash("sha1");
    h.update(buf);
    return `${st.mtimeMs}:${st.size}:${h.digest("hex")}`;
  } catch {
    return "0:0";
  }
}

function cacheFilePath(
  projectRoot: string,
  file: string,
  opts?: BuildOptions
): string {
  const root =
    opts?.cacheDir || path.join(projectRoot, ".codegraph-cache", "index-v1");
  const hash = crypto
    .createHash("sha1")
    .update(file.replace(/\\/g, "/"))
    .digest("hex");
  return path.join(root, `${hash}.json`);
}

async function tryLoadFromCache(
  projectRoot: string,
  file: string,
  sig: string,
  opts?: BuildOptions
): Promise<ModuleIndex | null> {
  const mode = opts?.cache ?? "off";
  if (mode === "memory") {
    const ent = memoryCache.get(file);
    if (ent && ent.sig === sig) return ent.mod;
    return null;
  }
  if (mode === "disk") {
    try {
      const cf = cacheFilePath(projectRoot, file, opts);
      const raw = await fsp.readFile(cf, "utf8");
      const parsed = JSON.parse(raw) as ModuleCacheEntry;
      if (parsed.sig === sig && parsed.mod && parsed.mod.file)
        return parsed.mod as ModuleIndex;
    } catch {}
  }
  return null;
}

async function writeToCache(
  projectRoot: string,
  file: string,
  sig: string,
  mod: ModuleIndex,
  opts?: BuildOptions
) {
  const mode = opts?.cache ?? "off";
  if (mode === "memory") {
    memoryCache.set(file, { sig, mod });
  } else if (mode === "disk") {
    try {
      const cf = cacheFilePath(projectRoot, file, opts);
      await fsp.mkdir(path.dirname(cf), { recursive: true });
      await fsp.writeFile(cf, JSON.stringify({ sig, mod }), "utf8");
    } catch {}
  }
}

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: {
    id: string;
    queries: any;
    classifyDefinition: (n: Parser.SyntaxNode) => string;
    nodeTypes: any;
    createsFunctionScope: (n: Parser.SyntaxNode) => boolean;
    createsBlockScope: (n: Parser.SyntaxNode) => boolean;
    isDeclarationName: (n: Parser.SyntaxNode) => boolean;
  },
  lang: Parser.Language,
  imports: ImportBinding[] = [],
  opts?: { tree?: Parser.Tree }
): ModuleIndex {
  let tree: Parser.Tree | null = opts?.tree ?? null;
  if (!tree) {
    try {
      const key = (support.id === "python" ? "py" : support.id === "js" ? "js" : "ts") as any;
      const parser = acquireParser(lang, key);
      try {
        parser.setLanguage(lang);
        tree = parser.parse(source);
      } finally {
        releaseParser(parser, key);
      }
    } catch {}
  }

  const locals: SymbolDef[] = [];
  const toKind = (s: string): SymbolKind => {
    if (s === "function") return SymbolKind.Function;
    if (s === "class") return SymbolKind.Class;
    if (s === "interface") return SymbolKind.Interface;
    if (s === "type") return SymbolKind.TypeAlias;
    return SymbolKind.Variable;
  };
  if (tree) {
    if (support.id === "python") {
      try {
        const { locals: q } = getCompiledQueries(lang, support as any);
        for (const m of q.matches(tree.rootNode))
          for (const cap of m.captures) {
            if (cap.name === "name" || cap.name === "tname") {
              locals.push({
                file,
                localName: sliceText(cap.node, source),
                kind: toKind(support.classifyDefinition(cap.node)),
                range: toRange(cap.node),
              });
            }
          }
      } catch (error) {
        console.warn(
          `Warning: Query error in locals for ${support.id}:`,
          error
        );
      }
    } else {
      const scopeIdx = buildScopeIndexFromSource(
        file,
        source,
        support,
        lang,
        imports,
        tree ? { tree } : undefined
      );
      for (const b of scopeIdx.all) {
        if (!b.def) continue;
        let kind: SymbolKind = SymbolKind.Variable;
        if (b.kind === "function") kind = SymbolKind.Function;
        else if (b.kind === "class") kind = SymbolKind.Class;
        else if (b.kind === "type") kind = SymbolKind.TypeAlias;
        locals.push({ file, localName: b.name, kind, range: b.def });
      }
    }
  }

  const exports: ExportEntry[] = [];
  if (support.queries.exports.trim() && tree) {
    try {
      const { exports: q } = getCompiledQueries(lang, support as any);
      for (const m of q.matches(tree.rootNode)) {
        const map = Object.fromEntries(
          m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const)
        );
        const stmtText = map["stmt"] ? sliceText(map["stmt"].node, source) : "";
        const isTypeOnly = /^\s*export\s+type\b/.test(stmtText);

        if (support.id === "python") {
          if (
            map["left"] &&
            sliceText(map["left"].node, source) === "__all__"
          ) {
            const items = m.captures.filter(
              (c: Parser.QueryCapture) => c.name === "all_item"
            );
            for (const it of items) {
              const name = unquote(sliceText(it.node, source));
              const local = locals.find((d) => d.localName === name);
              if (local)
                exports.push({
                  type: "local",
                  exportedAs: name,
                  target: local,
                });
            }
            if (items.length === 0) {
              // Fallback: handle tuples/multiline/concatenations by scanning a small window after assignment
              const assignIdx = map["stmt"]
                ? (map["stmt"].node as any).startIndex
                : source.indexOf("__all__");
              if (assignIdx >= 0) {
                const window = source.slice(assignIdx, assignIdx + 800);
                const strRe = /["']([^"']+)["']/g;
                for (let sm; (sm = strRe.exec(window)); ) {
                  const name = sm[1]!;
                  const local = locals.find((d) => d.localName === name);
                  if (local && !exports.some((e) => (e as any).exportedAs === name))
                    exports.push({
                      type: "local",
                      exportedAs: name,
                      target: local,
                    });
                }
              }
            }
            continue;
          }
          if (map["name"]) {
            const nameText = sliceText(map["name"].node, source);
            const local = locals.find((d) => d.localName === nameText);
            if (local) {
              if (!nameText.startsWith("_")) {
                exports.push({
                  type: "local",
                  exportedAs: nameText,
                  target: local,
                });
              }
            }
            continue;
          }
        }

        if (map["from"]) {
          const from = unquote(sliceText(map["from"].node, source));
          if (map["src"]) {
            const srcName = sliceText(map["src"].node, source);
            const alias = map["alias"]
              ? sliceText(map["alias"].node, source)
              : srcName;
            exports.push({
              type: "reexport",
              exportedAs: alias,
              fromModule: from,
              sourceSpecifier: srcName,
              typeOnly: isTypeOnly,
            });
          } else {
            exports.push({
              type: "exportStar",
              fromModule: from,
              sourceSpecifier: from,
              typeOnly: isTypeOnly,
            });
          }
          continue;
        }
        if (map["cjs_shorthand"]) {
          const nameText = sliceText(map["cjs_shorthand"].node, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local)
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
          continue;
        }
        if (map["cjs_export_name"] && map["cjs_local"]) {
          const exportedAs = sliceText(map["cjs_export_name"].node, source);
          const localName = sliceText(map["cjs_local"].node, source);
          const local = locals.find((d) => d.localName === localName);
          if (local) exports.push({ type: "local", exportedAs, target: local });
          continue;
        }
        // CJS: direct function/arrow assignment to exports/module.exports
        if (map["cjs_export_name"] && map["cjs_fn"]) {
          const exportedAs = sliceText(map["cjs_export_name"].node, source);
          const defRange = toRange(map["cjs_fn"].node);
          const sym: SymbolDef = {
            file,
            localName: exportedAs,
            kind: SymbolKind.Function,
            range: defRange,
          };
          locals.push(sym);
          exports.push({ type: "local", exportedAs, target: sym });
          continue;
        }
        if (map["default"]) {
          const nameText = sliceText(map["default"].node, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          continue;
        }
        if (map["anon_default"]) {
          const sym: SymbolDef = {
            file,
            localName: "__default_export__",
            kind: SymbolKind.Default,
            range: toRange(map["anon_default"].node),
          };
          locals.push(sym);
          exports.push({ type: "local", exportedAs: "default", target: sym });
          continue;
        }
        if (map["ts_export_assign"]) {
          const ident = sliceText(map["ts_export_assign"].node, source);
          const local = locals.find((d) => d.localName === ident);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
          continue;
        }
        if (map["name"]) {
          const nameNode = map["name"].node;
          const nameText = sliceText(nameNode, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local) {
            exports.push({
              type: "local",
              exportedAs: nameText,
              target: local,
            });
            let cur: Parser.SyntaxNode | null = nameNode;
            let exportStmt: Parser.SyntaxNode | null = null;
            while (cur) {
              if (cur.type === "export_statement") {
                exportStmt = cur;
                break;
              }
              cur = cur.parent;
            }
            const exportText = exportStmt
              ? sliceText(exportStmt, source)
              : stmtText;
            if (/^\s*export\s+default\b/.test(exportText)) {
              exports.push({
                type: "local",
                exportedAs: "default",
                target: { ...local, kind: SymbolKind.Default },
              });
            }
          }
          continue;
        }
        if (map["src"]) {
          const srcName = sliceText(map["src"].node, source);
          const alias = map["alias"]
            ? sliceText(map["alias"].node, source)
            : srcName;
          const local = locals.find((d) => d.localName === srcName);
          if (local)
            exports.push({ type: "local", exportedAs: alias, target: local });
        }
      }
      if (
        !exports.some((e) => e.type === "local" && e.exportedAs === "default")
      ) {
        const mDefFn = source.match(
          /\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/
        );
        const mDefCls = source.match(
          /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/
        );
        const name = mDefFn?.[1] ?? mDefCls?.[1];
        if (name) {
          const local = locals.find((d) => d.localName === name);
          if (local)
            exports.push({
              type: "local",
              exportedAs: "default",
              target: { ...local, kind: SymbolKind.Default },
            });
        }
      }
    } catch {
      // fall through to regex fallback below
    }
  }

  // Regex fallback for JS/TS exports when queries miss some patterns (e.g., re-exports)
  if (support.id === "ts" || support.id === "js") {
    const reDecl =
      /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
    const reDefault = /\bexport\s+default\s+([A-Za-z_$][\w$]*)/g;
    const reReexport = /\bexport\s*\{\s*([^}]+)\}\s*from\s*("|')([^"']+)\2/g;
    const reReexportNs =
      /\bexport\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*("|')([^"']+)\2/g;
    const reStar = /\bexport\s*\*\s*from\s*("|')([^"']+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = reDecl.exec(source))) {
      const name = m[1]!;
      if (!exports.some((e) => e.type === "local" && e.exportedAs === name)) {
        const local = locals.find((d) => d.localName === name);
        if (local)
          exports.push({ type: "local", exportedAs: name, target: local });
      }
    }
    while ((m = reDefault.exec(source))) {
      const name = m[1]!;
      if (
        !exports.some((e) => e.type === "local" && e.exportedAs === "default")
      ) {
        const local = locals.find((d) => d.localName === name);
        if (local)
          exports.push({
            type: "local",
            exportedAs: "default",
            target: { ...local, kind: SymbolKind.Default },
          });
      }
    }
    while ((m = reReexport.exec(source))) {
      const list = m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const from = m[3]!;
      for (const spec of list) {
        const mm = spec.match(
          /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/
        );
        if (!mm) continue;
        const srcName = mm[1]!;
        const alias = (mm[2] ?? srcName) as string;
        if (
          !exports.some(
            (e) =>
              e.type === "reexport" &&
              e.exportedAs === alias &&
              e.fromModule === from
          )
        ) {
          exports.push({
            type: "reexport",
            exportedAs: alias,
            fromModule: from,
            sourceSpecifier: srcName,
          });
        }
      }
    }
    while ((m = reReexportNs.exec(source))) {
      const alias = m[1]!;
      const from = m[3]!;
      if (
        !exports.some(
          (e) =>
            e.type === "reexport" &&
            e.exportedAs === alias &&
            e.fromModule === from
        )
      ) {
        exports.push({
          type: "reexport",
          exportedAs: alias,
          fromModule: from,
          sourceSpecifier: "" as any,
        });
      }
    }
    while ((m = reStar.exec(source))) {
      const from = m[2]!;
      if (
        !exports.some((e) => e.type === "exportStar" && e.fromModule === from)
      ) {
        exports.push({
          type: "exportStar",
          fromModule: from,
          sourceSpecifier: from,
        });
      }
    }
    // CommonJS: exports.name = function/arrow, module.exports.name = function/arrow
    const reCjsFn =
      /(?:^|[;\n\r])\s*(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=\s*(function\b|\([^)]*\)\s*=>)/g;
    while ((m = reCjsFn.exec(source))) {
      const exportedAs = m[1]!;
      if (!locals.find((d) => d.localName === exportedAs)) {
        const idx = m.index + m[0]!.indexOf(exportedAs);
        const pos = { line: 1, column: 1, index: idx } as any;
        const sym: SymbolDef = {
          file,
          localName: exportedAs,
          kind: SymbolKind.Function,
          range: { start: pos, end: pos },
        };
        locals.push(sym);
      }
      const local = locals.find((d) => d.localName === exportedAs)!;
      if (
        !exports.some((e) => e.type === "local" && e.exportedAs === exportedAs)
      ) {
        exports.push({ type: "local", exportedAs, target: local });
      }
    }
    // CommonJS: module.exports = { helper: function(){}, ... }
    const reCjsObjFn = /([A-Za-z_$][\w$]*)\s*:\s*(function\b|\([^)]*\)\s*=>)/g;
    const moduleExportsObjMatch = source.match(
      /module\.exports\s*=\s*\{([^}]*)\}/s
    );
    if (moduleExportsObjMatch && moduleExportsObjMatch.index !== undefined) {
      const objContent = moduleExportsObjMatch[1]!;
      let mObj: RegExpExecArray | null;
      while ((mObj = reCjsObjFn.exec(objContent))) {
        const exportedAs = mObj[1]!;
        if (!locals.find((d) => d.localName === exportedAs)) {
          const idx =
            moduleExportsObjMatch.index +
            moduleExportsObjMatch[0]!.indexOf(exportedAs);
          const pos = { line: 1, column: 1, index: idx } as any;
          const sym: SymbolDef = {
            file,
            localName: exportedAs,
            kind: SymbolKind.Function,
            range: { start: pos, end: pos },
          };
          locals.push(sym);
        }
        const local = locals.find((d) => d.localName === exportedAs)!;
        if (
          !exports.some(
            (e) => e.type === "local" && e.exportedAs === exportedAs
          )
        ) {
          exports.push({ type: "local", exportedAs, target: local });
        }
      }
    }
  }

  if (
    (support.id === "ts" || support.id === "js") &&
    !exports.some((e) => e.type === "local" && e.exportedAs === "default")
  ) {
    const defFn = source.match(
      /\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/
    );
    const defCls = source.match(
      /\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/
    );
    const defIdent = source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/);
    const name = defFn?.[1] ?? defCls?.[1] ?? defIdent?.[1];
    if (name) {
      const local = locals.find((d) => d.localName === name);
      if (local)
        exports.push({
          type: "local",
          exportedAs: "default",
          target: { ...local, kind: SymbolKind.Default },
        });
    }
  }

  return { file, exports, imports: [], locals };
}

export async function collectImportsForFile(
  file: string,
  projectRoot: string,
  opts?: { source?: string; tree?: Parser.Tree }
): Promise<ImportBinding[]> {
  const sup = supportForFile(file);
  const lang = languageForFile(file);
  const source = opts?.source ?? (await fsp.readFile(file, "utf8"));
  const imports: ImportBinding[] = [];

  if (sup.id === "python") {
    const pySrc = stripPythonCommentsAndStrings(source);
    const pushStar = async (moduleSpec: string) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? m[2] || null : moduleSpec;
      const resolved = await resolvePythonModule(
        projectRoot,
        file,
        mod as any,
        relDots
      );
      imports.push({
        kind: "star",
        from: moduleSpec,
        resolved,
        mechanism: "python",
      });
    };
    const pushNamed = async (
      moduleSpec: string,
      imported: string,
      local: string
    ) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? m[2] || null : moduleSpec;
      const resolved = await resolvePythonModule(
        projectRoot,
        file,
        mod as any,
        relDots
      );
      let nsResolved: string | undefined;
      if (typeof resolved === "string") {
        let baseDir = resolved;
        try {
          const st = fs.statSync(baseDir);
          if (
            !st.isDirectory() &&
            baseDir.toLowerCase().endsWith("__init__.py")
          )
            baseDir = path.dirname(baseDir);
        } catch {}
        const sub = [
          path.join(baseDir, `${imported}.py`),
          path.join(baseDir, imported, "__init__.py"),
          path.join(baseDir, imported),
        ];
        for (const c of sub) {
          try {
            if (fs.existsSync(c)) {
              nsResolved = fs.statSync(c).isDirectory() ? c : c;
              break;
            }
          } catch {}
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
      const resolved = await resolvePythonModule(
        projectRoot,
        file,
        dotted as any,
        0
      );
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
        const am = it.match(
          /^([A-Za-z_][\w_]*)(?:\s+as\s+([A-Za-z_][\w_]*))?$/
        );
        if (am) {
          const imported = am[1]!;
          const local = (am[2] ?? imported) as string;
          await pushNamed(mod, imported, local);
        }
      }
    }
    const reImp =
      /^(?:\s*)import\s+([A-Za-z_][\w\.]*)\s*(?:as\s+([A-Za-z_][\w_]*))?/gm;
    for (const m of pySrc.matchAll(reImp)) {
      const dotted = m[1]!;
      const local = (m[2] ?? dotted.split(".")[0]) as string;
      await pushDefault(dotted, local);
    }
    return imports;
  }

  const key = (sup.id === "python" ? "py" : sup.id === "js" ? "js" : "ts") as any;
  const parser = acquireParser(lang, key);
  parser.setLanguage(lang);
  const tree = opts?.tree ?? parser.parse(source);
  const tsCfg =
    sup.id === "ts" ? await loadNearestTsconfigFor(file) : undefined;
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);

  const resolveFrom = async (from: string) => {
    const r = await resolveSpecifier(
      file,
      from,
      projectRoot,
      tsCfg?.matchPath,
      workspaceConfig
    );
    return typeof r === "string" ? r.replace(/\\/g, "/") : r;
  };

  const runFallback = async () => {
    const src =
      sup.id === "ts" || sup.id === "js" ? stripJsLikeComments(source) : source;
    const typeOnlyImport = /\bimport\s+type\b/;
    const reFrom = /^\s*import\s+([^\n;]*?)\s+from\s+(["'])(?<m>[^"']+)\2/gm;
    for (const m of src.matchAll(reFrom)) {
      const clause = m[1]!.trim();
      const mod = m.groups?.m as string;
      const typeOnly = typeOnlyImport.test(m[0]!);
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
        const namedBlock =
          parts.slice(1).join(",").trim() ||
          (first.startsWith("{") ? first : "");
        const names = namedBlock
          .replace(/[{}]/g, "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        for (const spec of names) {
          const nm = spec.match(
            /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/
          );
          if (!nm) continue;
          const imported = nm[1]!;
          const local = (nm[2] ?? imported) as string;
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
    const reReqDefault =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
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
    const reReqNamed =
      /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
    for (const m of src.matchAll(reReqNamed)) {
      const specs = m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const mod = m.groups?.m as string;
      const resolved = await resolveFrom(mod);
      for (const spec of specs) {
        const nm = spec.match(
          /^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/
        );
        if (!nm) continue;
        const imported = nm[1]!;
        const local = (nm[2] ?? imported) as string;
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
  };

  let ranFallback = false;
  try {
    const { importBindings: q } = getCompiledQueries(lang, sup as any);
    for (const m of q.matches(tree.rootNode)) {
      const caps = Object.fromEntries(
        m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const)
      );
      const stmtText = caps["stmt"] ? sliceText(caps["stmt"].node, source) : "";
      const typeOnly = sup.id === "ts" && /^\s*import\s+type\b/.test(stmtText);
      const from: string | undefined = caps["from"]
        ? unquote(sliceText(caps["from"].node, source))
        : undefined;

      const patterns = m.captures.filter(
        (c: Parser.QueryCapture) => c.name === "pattern"
      );
      for (const pattern of patterns) {
        const patternNode = pattern.node;
        if (patternNode.type === "object_pattern" && from) {
          for (const child of patternNode.namedChildren) {
            if (child.type === "shorthand_property_identifier") {
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
              if (
                key &&
                value &&
                key.type === "property_identifier" &&
                value.type === "identifier"
              ) {
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
      const resolved = await resolveFrom(from);
      if (caps["def"]) {
        imports.push({
          kind: "default",
          local: sliceText(caps["def"].node, source),
          from,
          resolved,
          typeOnly,
        });
      }
      if (caps["ns"]) {
        const nsName = sliceText(caps["ns"].node, source);
        imports.push({
          kind: "namespace",
          localNS: nsName,
          from,
          resolved,
          typeOnly,
        });
      }
      const inames = m.captures.filter(
        (c: Parser.QueryCapture) => c.name === "iname"
      );
      const aliases = m.captures.filter(
        (c: Parser.QueryCapture) => c.name === "alias"
      );
      for (let i = 0; i < inames.length; i++) {
        const imported = sliceText(inames[i]!.node, source);
        const alias = aliases[i]
          ? sliceText(aliases[i]!.node, source)
          : imported;
        imports.push({
          kind: "named",
          local: alias,
          imported,
          from,
          resolved,
          typeOnly,
        });
      }
    }
  } catch {
    await runFallback();
    ranFallback = true;
  }
  // Only run fallback when query path produced no results
  if (!ranFallback && imports.length === 0) {
    await runFallback();
  }
  return imports;
}

export async function parseFile(
  file: string
): Promise<{
  source: string;
  tree: Parser.Tree;
  sup: ReturnType<typeof supportForFile>;
  lang: Parser.Language;
}> {
  const sup = supportForFile(file);
  const lang = languageForFile(file);
  const source = await fsp.readFile(file, "utf8");
  const key = (sup.id === "python" ? "py" : sup.id === "js" ? "js" : "ts") as any;
  const parser = acquireParser(lang, key);
  try {
    parser.setLanguage(lang);
    const tree = parser.parse(source);
    return { source, tree, sup, lang };
  } finally {
    releaseParser(parser, key);
  }
}

export async function buildProjectIndex(
  projectRoot: string,
  opts?: BuildOptions
): Promise<ProjectIndex> {
  const files = await listProjectFiles(projectRoot);
  if (files.length === 0) {
    console.warn(`Warning: No files found in project root: ${projectRoot}`);
  }
  const modules = new Map<FileId, ModuleIndex>();

  const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 8, 64));
  const parsedMap = new Map<
    string,
    {
      source: string;
      tree: Parser.Tree;
      sup: ReturnType<typeof supportForFile>;
      lang: Parser.Language;
    }
  >();
  const fileResults = await mapLimit(files, conc, async (f) => {
    try {
      const sig = await fileSignature(f, opts?.cacheStrict);
      const cached = await tryLoadFromCache(projectRoot, f, sig, opts);
      if (cached) {
        return [f, cached] as const;
      }
      const parsed = await parseFile(f);
      parsedMap.set(f, parsed);
      const { source: src, sup, lang, tree } = parsed;
      const imports = await collectImportsForFile(f, projectRoot, {
        source: src,
        tree,
      });
      const mod = collectLocalsAndExportsFromSource(
        f,
        src,
        sup,
        lang,
        imports,
        { tree }
      );
      mod.imports = imports;

      if (sup.supportsCrossModuleSymbols) {
        if (sup.id === "ts" || sup.id === "js") {
          const { matchPath } = await loadNearestTsconfigFor(f);
          for (const e of mod.exports)
            if (e.type !== "local") {
              if (e.fromModule.startsWith(".")) {
                const resolved = await resolveSpecifier(
                  f,
                  e.fromModule,
                  projectRoot,
                  matchPath,
                  await loadWorkspaceConfig(projectRoot)
                );
                if (typeof resolved === "string") e.fromModule = resolved;
              } else {
                const ws = await loadWorkspaceConfig(projectRoot);
                const { resolveWorkspacePackage } = await import("./util.js");
                const pkgResolved = await resolveWorkspacePackage(
                  e.fromModule,
                  ws
                );
                if (pkgResolved) e.fromModule = pkgResolved;
              }
            }
        }
      }
      await writeToCache(projectRoot, f, sig, mod, opts);
      return [f, mod] as const;
    } catch (error) {
      console.warn(`Warning: Failed to process file ${f}:`, error);
      const mod: ModuleIndex = {
        file: f,
        exports: [],
        imports: [],
        locals: [],
      };
      return [f, mod] as const;
    }
  });
  for (const [f, mod] of fileResults) {
    modules.set(f.replace(/\\/g, "/"), mod);
  }

  for (const [file, m] of modules) {
    for (const imp of [...m.imports]) {
      if (imp.kind === "star" && typeof imp.resolved === "string") {
        const target = modules.get(imp.resolved);
        if (target) {
          let exported: string[] = [];
          const viaAll = target.exports.filter((e) => e.type === "local");
          if (viaAll.length) exported = viaAll.map((e) => e.exportedAs);
          else
            exported = target.locals
              .map((l) => l.localName)
              .filter((n) => !n.startsWith("_"));
          for (const name of exported)
            m.imports.push({
              kind: "named",
              local: name,
              imported: name,
              from: imp.from,
              resolved: imp.resolved,
            });
        }
      }
    }
  }

  const graph = await collectGraph(projectRoot, files, {
    parsed: parsedMap as any,
  });
  return {
    graph,
    modules,
    byFile: modules,
    exportCache: new Map(),
    parsed: parsedMap as any,
  };
}

export async function buildProjectIndexFromFiles(
  projectRoot: string,
  inputFiles: string[],
  opts?: BuildOptions
): Promise<ProjectIndex> {
  const files = Array.from(
    new Set((inputFiles || []).filter(Boolean).map((f) => path.resolve(f)))
  );
  if (files.length === 0) {
    console.warn(`Warning: No files provided for indexing in ${projectRoot}`);
  }
  const modules = new Map<FileId, ModuleIndex>();

  const conc = Math.max(1, Math.min(Number(opts?.threads || 0) || 8, 64));
  const parsedMap = new Map<
    string,
    {
      source: string;
      tree: Parser.Tree;
      sup: ReturnType<typeof supportForFile>;
      lang: Parser.Language;
    }
  >();
  const fileResults = await mapLimit(files, conc, async (f) => {
    try {
      const sig = await fileSignature(f, opts?.cacheStrict);
      const cached = await tryLoadFromCache(projectRoot, f, sig, opts);
      if (cached) {
        return [f, cached] as const;
      }
      const parsed = await parseFile(f);
      parsedMap.set(f, parsed);
      const { source: src, sup, lang, tree } = parsed;
      const imports = await collectImportsForFile(f, projectRoot, {
        source: src,
        tree,
      });
      const mod = collectLocalsAndExportsFromSource(
        f,
        src,
        sup,
        lang,
        imports,
        { tree }
      );
      mod.imports = imports;

      if (sup.supportsCrossModuleSymbols) {
        if (sup.id === "ts" || sup.id === "js") {
          const { matchPath } = await loadNearestTsconfigFor(f);
          for (const e of mod.exports)
            if (e.type !== "local") {
              if (e.fromModule.startsWith(".")) {
                const resolved = await resolveSpecifier(
                  f,
                  e.fromModule,
                  projectRoot,
                  matchPath,
                  await loadWorkspaceConfig(projectRoot)
                );
                if (typeof resolved === "string") e.fromModule = resolved;
              } else {
                const ws = await loadWorkspaceConfig(projectRoot);
                const { resolveWorkspacePackage } = await import("./util.js");
                const pkgResolved = await resolveWorkspacePackage(
                  e.fromModule,
                  ws
                );
                if (pkgResolved) e.fromModule = pkgResolved;
              }
            }
        }
      }
      await writeToCache(projectRoot, f, sig, mod, opts);
      return [f, mod] as const;
    } catch (error) {
      console.warn(`Warning: Failed to process file ${f}:`, error);
      const mod: ModuleIndex = {
        file: f,
        exports: [],
        imports: [],
        locals: [],
      };
      return [f, mod] as const;
    }
  });
  for (const [f, mod] of fileResults) {
    modules.set(f.replace(/\\/g, "/"), mod);
  }

  for (const [file, m] of modules) {
    for (const imp of [...m.imports]) {
      if (imp.kind === "star" && typeof imp.resolved === "string") {
        const target = modules.get(imp.resolved);
        if (target) {
          let exported: string[] = [];
          const viaAll = target.exports.filter((e) => e.type === "local");
          if (viaAll.length) exported = viaAll.map((e) => e.exportedAs);
          else
            exported = target.locals
              .map((l) => l.localName)
              .filter((n) => !n.startsWith("_"));
          for (const name of exported)
            m.imports.push({
              kind: "named",
              local: name,
              imported: name,
              from: imp.from,
              resolved: imp.resolved,
            });
        }
      }
    }
  }

  const graph = await collectGraph(projectRoot, files, {
    parsed: parsedMap as any,
  });
  return {
    graph,
    modules,
    byFile: modules,
    exportCache: new Map(),
    parsed: parsedMap as any,
  };
}

function cacheKey(file: FileId, name: string) {
  return `${file}::${name}`;
}

export function resolveExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string
): ResolvedExport | null {
  const visited = new Set<string>();
  function _resolve(fileInner: FileId, name: string): ResolvedExport | null {
    const normalizedFile = fileInner.replace(/\\/g, "/");
    const mod = index.byFile.get(normalizedFile);
    if (!mod) return null;
    const key = cacheKey(normalizedFile, name);
    if (index.exportCache.has(key)) return index.exportCache.get(key)!;

    // Detect and break cycles
    const cycleKey = `${normalizedFile}::${name}`;
    if (visited.has(cycleKey)) return null;
    visited.add(cycleKey);

    for (const e of mod.exports)
      if (e.type === "local" && e.exportedAs === name) {
        const res: ResolvedExport = { kind: "resolved", def: e.target };
        index.exportCache.set(key, res);
        return res;
      }
    for (const e of mod.exports)
      if (
        e.type === "reexport" &&
        e.exportedAs === name &&
        typeof e.fromModule === "string"
      ) {
        const down = _resolve(e.fromModule, e.sourceSpecifier || name) || _resolve(e.fromModule, name);
        if (down) {
          index.exportCache.set(key, down);
          return down;
        }
      }
    for (const e of mod.exports)
      if (e.type === "exportStar" && typeof e.fromModule === "string") {
        const down = _resolve(e.fromModule, name);
        if (down) {
          index.exportCache.set(key, down);
          return down;
        }
      }
    index.exportCache.set(key, null);
    return null;
  }
  return _resolve(file, exportedName);
}

export type GoToRequest = { file: FileId; line: number; column: number };
export type GoToResult =
  | {
      status: "ok";
      definition: SymbolDef;
      via?: {
        importedFrom?: string | undefined;
        exportedName?: string | undefined;
      };
    }
  | { status: "not_found"; reason: string };

export async function goToDefinition(
  index: ProjectIndex,
  req: GoToRequest
): Promise<GoToResult> {
  const { file, line, column } = req;
  const mod = index.byFile.get(file);
  if (!mod) return { status: "not_found", reason: "File not indexed" };

  const lang = languageForFile(file);
  const sup = supportForFile(file);
  const parsedEntry = index.parsed?.get(file);
  const key = (sup.id === "python" ? "py" : sup.id === "js" ? "js" : "ts") as any;
  let parser: Parser | null = null;
  let tree: Parser.Tree;
  let source: string;
  if (parsedEntry) {
    source = parsedEntry.source;
    tree = parsedEntry.tree;
  } else {
    parser = acquireParser(lang, key);
    parser.setLanguage(lang);
    source = await fsp.readFile(file, "utf8");
    tree = parser.parse(source);
  }

  const pos = {
    row: Math.max(0, line - 1),
    column: Math.max(0, column - 1),
  } as any;
  let node: Parser.SyntaxNode | null = tree.rootNode.descendantForPosition(
    pos,
    pos
  );

  if (node && node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value && value.type === "call_expression") {
      let callee = value.childForFieldName("function");
      if (!callee) callee = value.childForFieldName("callee");
      if (!callee) callee = value.child(0);
      if (callee && sup.nodeTypes.identifier.includes(callee.type)) {
        node = callee;
      }
    }
  }

  while (node && (node.type === "," || node.type === ".")) node = node.parent;
  if (!node) return { status: "not_found", reason: "No node at position" };

  if (
    sup.supportsCrossModuleSymbols &&
    ((node.type ===
      (sup.nodeTypes.propertyIdentifier?.[0] ?? "property_identifier") &&
      node.parent &&
      node.parent.type ===
        (sup.nodeTypes.memberExpression ?? "member_expression")) ||
      node.type === (sup.nodeTypes.memberExpression ?? "member_expression"))
  ) {
    const memberNode =
      node.type === (sup.nodeTypes.memberExpression ?? "member_expression")
        ? node
        : node.parent!;
    let obj = memberNode.child(0);
    let prop = memberNode.child(2);
    if (sup.id === "python") {
      obj = memberNode.childForFieldName("object") ?? obj;
      prop = memberNode.childForFieldName("attribute") ?? prop;
    }
    if (obj && prop && obj.type === "identifier") {
      const nsName = sliceText(obj, source);
      const member = sliceText(prop, source);
      const nsImport = mod.imports.find(
        (i) => i.kind === "namespace" && i.localNS === nsName
      );
      if (nsImport) {
        const resolved = resolveImported(index, nsImport, member);
        if (resolved)
          return {
            status: "ok",
            definition: resolved,
            via: {
              ...(toModuleRef(nsImport.resolved)
                ? { importedFrom: toModuleRef(nsImport.resolved) }
                : {}),
              exportedName: member,
            },
          };
      }
    }
  }

  const isId = sup.nodeTypes.identifier.includes(node.type);
  let name: string | null = isId ? sliceText(node, source) : null;

  if (!name) {
    const findDeclNameNode = (
      n: Parser.SyntaxNode | null
    ): Parser.SyntaxNode | null => {
      let cur: Parser.SyntaxNode | null = n;
      while (cur) {
        if (
          cur.type === "function_declaration" ||
          cur.type === "class_declaration" ||
          cur.type === "variable_declarator" ||
          cur.type === "interface_declaration" ||
          cur.type === "type_alias_declaration" ||
          cur.type === "function_definition" ||
          cur.type === "class_definition" ||
          cur.type === "assignment"
        ) {
          let named = cur.childForFieldName("name");
          if (!named && cur.type === "assignment") {
            const left = cur.child(0);
            if (left && sup.nodeTypes.identifier.includes(left.type))
              named = left;
          }
          if (named && sup.nodeTypes.identifier.includes(named.type))
            return named;
        }
        cur = cur.parent;
      }
      return null;
    };
    const declNameNode = findDeclNameNode(node);
    if (declNameNode) name = sliceText(declNameNode, source);
  }

  if (name) {
    const local = mod.locals.find((d) => d.localName === name);
    if (local) {
      if (parser) releaseParser(parser, key);
      return { status: "ok", definition: local };
    }

    if (supportForFile(file).supportsCrossModuleSymbols) {
      const hit = resolveExport(index, file, name);
      if (hit) {
        if (parser) releaseParser(parser, key);
        return {
          status: "ok",
          definition: hit.def,
          via: { exportedName: name },
        };
      }

      for (const imp of mod.imports) {
        if (imp.kind === "default" && imp.local === name) {
          const target = resolveImported(index, imp, "default");
          if (target)
            {
              if (parser) releaseParser(parser, key);
            return {
              status: "ok",
              definition: target,
              via: {
                ...(toModuleRef(imp.resolved)
                  ? { importedFrom: toModuleRef(imp.resolved) }
                  : {}),
                exportedName: "default",
              },
            };
            }
        } else if (imp.kind === "named" && imp.local === name) {
          const target = resolveImported(index, imp, imp.imported);
          if (target)
            {
              if (parser) releaseParser(parser, key);
            return {
              status: "ok",
              definition: target,
              via: {
                ...(toModuleRef(imp.resolved)
                  ? { importedFrom: toModuleRef(imp.resolved) }
                  : {}),
                exportedName: imp.imported,
              },
            };
            }
        } else if (imp.kind === "namespace" && imp.localNS === name) {
          const targetFile =
            typeof imp.resolved === "string"
              ? imp.resolved.replace(/\\/g, "/")
              : undefined;
          if (targetFile) {
            const targetMod = index.byFile.get(targetFile);
            if (targetMod) {
              const firstExport = targetMod.exports.find(
                (e) => e.type === "local"
              );
              if (firstExport) {
                if (parser) releaseParser(parser, key);
                return {
                  status: "ok",
                  definition: firstExport.target,
                  via: {
                    ...(toModuleRef(imp.resolved)
                      ? { importedFrom: toModuleRef(imp.resolved) }
                      : {}),
                    exportedName: firstExport.exportedAs,
                  },
                };
              }
            }
          }
        }
      }
    }
  }

  if (parser) releaseParser(parser, key);
  return {
    status: "not_found",
    reason: "No matching local or imported definition",
  };
}

function toModuleRef(resolved?: FileId | { external: string }) {
  if (!resolved) return undefined;
  return typeof resolved === "string" ? resolved : resolved.external;
}
export function resolveImported(
  index: ProjectIndex,
  imp: ImportBinding,
  exportedName: string
): SymbolDef | null {
  const targetFile =
    typeof imp.resolved === "string" ? imp.resolved : undefined;
  if (!targetFile) return null;
  const hit = resolveExport(index, targetFile, exportedName);
  if (hit?.def) return hit.def;
  const sup = supportForFile(targetFile);
  if (sup.id === "python") {
    const base =
      fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory()
        ? targetFile
        : path.dirname(targetFile);
    const subCandidates = [
      path.join(base, `${exportedName}.py`),
      path.join(base, exportedName, "__init__.py"),
      path.join(base, exportedName),
    ];
    for (const c of subCandidates) {
      try {
        if (fs.existsSync(c)) {
          const isDir = fs.statSync(c).isDirectory();
          const filePath = isDir ? c : c;
          return {
            file: filePath.replace(/\\/g, "/"),
            localName: exportedName,
            kind: SymbolKind.Variable,
            range: {
              start: { line: 1, column: 1, index: 0 },
              end: { line: 1, column: 1, index: 0 },
            },
          };
        }
      } catch {}
    }
    return {
      file: targetFile.replace(/\\/g, "/"),
      localName: exportedName,
      kind: SymbolKind.Variable,
      range: {
        start: { line: 1, column: 1, index: 0 },
        end: { line: 1, column: 1, index: 0 },
      },
    };
  }
  return null;
}

export type BindingKind =
  | "local"
  | "param"
  | "function"
  | "class"
  | "type"
  | "importDefault"
  | "importNamed"
  | "namespace";
export type Binding = {
  name: string;
  kind: BindingKind;
  def?: Range;
  occurrences: Range[];
  import?: ImportBinding;
};
export type ScopeIndex = { bindings: Map<string, Binding[]>; all: Binding[] };

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: {
    nodeTypes: any;
    isDeclarationName: (n: Parser.SyntaxNode) => boolean;
    createsFunctionScope: (n: Parser.SyntaxNode) => boolean;
    createsBlockScope: (n: Parser.SyntaxNode) => boolean;
  },
  lang: Parser.Language,
  imports: ImportBinding[] = [],
  opts?: { tree?: Parser.Tree }
): ScopeIndex {
  type Scope = {
    kind: "module" | "function" | "block";
    map: Map<string, Binding>;
  };
  const rootScope: Scope = { kind: "module", map: new Map() };
  const stack: Scope[] = [rootScope];

  for (const imp of imports) {
    if (imp.kind === "default")
      rootScope.map.set(imp.local, {
        name: imp.local,
        kind: "importDefault",
        occurrences: [],
        import: imp,
      });
    if (imp.kind === "named")
      rootScope.map.set(imp.local, {
        name: imp.local,
        kind: "importNamed",
        occurrences: [],
        import: imp,
      });
    if (imp.kind === "namespace")
      rootScope.map.set(imp.localNS, {
        name: imp.localNS,
        kind: "namespace",
        occurrences: [],
        import: imp,
      });
  }

  const key2 = (support.nodeTypes && (support as any).id === "python" ? "py" : (support as any).id === "js" ? "js" : "ts") as any;
  const parser2 = acquireParser(lang, key2);
  parser2.setLanguage(lang);
  const tree = opts?.tree ?? parser2.parse(source);

  const idSet = new Set([
    ...(support.nodeTypes.identifier as string[]),
    ...((support.nodeTypes.shorthandPropertyIdentifier ?? []) as string[]),
  ]);

  const addDecl = (nameNode: Parser.SyntaxNode, kind: BindingKind) => {
    const name = sliceText(nameNode, source);
    let target = stack[stack.length - 1];
    if (kind === "function" || kind === "class") {
      target = rootScope;
    }
    const b: Binding = {
      name,
      kind,
      def: toRange(nameNode as any),
      occurrences: [],
    };
    target?.map.set(name, b);
  };

  const lookup = (name: string): Binding | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const hit = stack[i]!.map.get(name);
      if (hit) return hit;
    }
    return rootScope.map.get(name);
  };

  const walk = (node: Parser.SyntaxNode) => {
    if (support.createsFunctionScope(node))
      stack.push({ kind: "function", map: new Map() });
    else if (support.createsBlockScope(node)) {
      if (node.type !== "program" && node.type !== "module")
        stack.push({ kind: "block", map: new Map() });
    }

    if (
      node.type === "function_declaration" ||
      node.type === "function_definition"
    ) {
      const name = (node as any).childForFieldName("name");
      if (name) {
        addDecl(name, "function");
      }
      const params = (node as any).childForFieldName("parameters");
      if (params) {
        const q: Parser.SyntaxNode[] = [params];
        while (q.length) {
          const n = q.pop()!;
          if ((n as any).type === "identifier") addDecl(n, "param");
          for (const ch of (n as any).namedChildren) q.push(ch);
        }
      }
    }
    if (node.type === "class_declaration" || node.type === "class_definition") {
      const name = (node as any).childForFieldName("name");
      if (name) addDecl(name, "class");
    }
    if (
      node.type === "variable_declaration" ||
      node.type === "lexical_declaration" ||
      node.type === "assignment"
    ) {
      for (const ch of (node as any).namedChildren) {
        if (ch.type === "variable_declarator") {
          const nm = (ch as any).childForFieldName("name");
          if (nm) addDecl(nm, "local");
        } else if (ch.type === "identifier" && node.type === "assignment") {
          addDecl(ch as any, "local");
        }
      }
    }
    if (
      node.type === "interface_declaration" ||
      node.type === "type_alias_declaration"
    ) {
      const name = (node as any).childForFieldName("name");
      if (name) addDecl(name, "type");
    }

    if (idSet.has(node.type) && !support.isDeclarationName(node)) {
      const name = sliceText(node, source);
      const b = lookup(name);
      if (b) {
        b.occurrences.push(toRange(node));
      }
    }

    for (const ch of node.namedChildren) walk(ch);

    if (
      support.createsFunctionScope(node) ||
      (support.createsBlockScope(node) &&
        node.type !== "program" &&
        node.type !== "module")
    )
      stack.pop();
  };

  walk(tree.rootNode);
  releaseParser(parser2, key2);

  const bindings = new Map<string, Binding[]>();
  const all: Binding[] = [];
  const flush = (scope: Scope) => {
    for (const b of scope.map.values()) {
      if (!bindings.has(b.name)) bindings.set(b.name, []);
      bindings.get(b.name)!.push(b);
      all.push(b);
    }
  };
  for (const s of stack) flush(s);
  flush(rootScope);
  return { bindings, all };
}

export type Reference = {
  file: FileId;
  range: Range;
  context?: string;
  via?: { import?: ImportBinding; namespaceMember?: string };
};

function sameDef(a: SymbolDef, b: SymbolDef) {
  return (
    a.file === b.file &&
    a.localName === b.localName &&
    a.range.start.index === b.range.start.index
  );
}

function rangeContains(
  range: Range,
  pos: { row: number; column: number }
): boolean {
  if (pos.row < range.start.line || pos.row > range.end.line) return false;
  if (pos.row === range.start.line && pos.column < range.start.column)
    return false;
  if (pos.row === range.end.line && pos.column > range.end.column) return false;
  return true;
}

export async function findReferences(
  index: ProjectIndex,
  req: { file: FileId; line: number; column: number } | { def: SymbolDef }
): Promise<
  | { status: "ok"; definition: SymbolDef; references: Reference[] }
  | { status: "not_found"; reason: string }
> {
  let def: SymbolDef | null = null;
  if ("def" in req) def = req.def as any;
  else {
    const got = await goToDefinition(index, req as any);
    if (got.status === "ok") def = got.definition;
  }
  if (!def)
    return { status: "not_found", reason: "Could not resolve definition" };

  const definitionFile = def.file;
  const sup = supportForFile(definitionFile);
  const lang = languageForFile(definitionFile);
  const parsedDef = index.parsed?.get(definitionFile);
  const src = parsedDef?.source ?? (await fsp.readFile(definitionFile, "utf8"));
  const scope = buildScopeIndexFromSource(
    definitionFile,
    src,
    sup as any,
    lang,
    index.byFile.get(definitionFile)?.imports as any,
    parsedDef ? { tree: parsedDef.tree } : undefined
  );

  const refs: Reference[] = [];

  const localBindings = scope.bindings.get(def.localName) ?? [];
  const localBinding = localBindings.find(
    (b) => b.def && (b.def as any).start.index === def!.range.start.index
  );
  if (localBinding)
    for (const occ of localBinding.occurrences)
      refs.push({ file: definitionFile, range: occ });
  refs.push({ file: definitionFile, range: def.range });

  const exportedNames: string[] = [];
  const mod = index.byFile.get(definitionFile);
  if (mod)
    for (const e of mod.exports)
      if ((e as any).type === "local" && sameDef((e as any).target, def))
        exportedNames.push((e as any).exportedAs);
  if (!exportedNames.length) exportedNames.push(def.localName);

  for (const [f, m] of index.byFile) {
    if (f === definitionFile) continue;

    let sc: any = null;
    const ensure = async () => {
      if (!sc) {
        const parsedF = index.parsed?.get(f);
        const s = parsedF?.source ?? (await fsp.readFile(f, "utf8"));
        sc = buildScopeIndexFromSource(
          f,
          s,
          supportForFile(f) as any,
          languageForFile(f),
          m.imports as any,
          parsedF ? { tree: parsedF.tree } : undefined
        );
      }
      return sc;
    };

    for (const imp of m.imports) {
      const targetFile =
        typeof (imp as any).resolved === "string"
          ? (imp as any).resolved
          : undefined;
      if (!targetFile) continue;
      for (const name of exportedNames) {
        if ((imp as any).kind === "namespace") {
          const hit = resolveExport(index, targetFile, name);
          if (!hit || !sameDef(hit.def, def)) continue;
          const scopeIdx = await ensure();
          const nsName = (imp as any).localNS;
          const member = name;
          const ranges = await collectNamespaceMemberRefs(f, nsName, member);
          for (const r of ranges)
            refs.push({
              file: f,
              range: r as any,
              via: { import: imp as any, namespaceMember: member },
            });
        } else {
          if ((imp as any).kind === "star") continue;
          const exported =
            (imp as any).kind === "named"
              ? (imp as any).imported
              : (imp as any).kind === "default"
              ? "default"
              : name;
          const hit = resolveExport(index, targetFile, exported);
          if (!hit || !sameDef(hit.def, def)) continue;
          const scopeIdx = await ensure();
          const localName =
            (imp as any).kind === "default"
              ? (imp as any).local
              : (imp as any).local;
          const binds = (scopeIdx.bindings.get(localName) ?? []) as any[];
          for (const b of binds)
            for (const occ of b.occurrences)
              refs.push({ file: f, range: occ, via: { import: imp as any } });
        }
      }
    }
  }

  const seen = new Set<string>();
  const uniqueRefs: typeof refs = [];
  for (const ref of refs) {
    const key = `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueRefs.push(ref);
    }
  }

  uniqueRefs.sort((a, b) =>
    a.file === b.file
      ? a.range.start.index - b.range.start.index
      : a.file.localeCompare(b.file)
  );
  return { status: "ok", definition: def, references: uniqueRefs };
}

// Detailed symbol graph re-export compatibility
export async function __buildSymbolGraphDetailedCompat(
  index: any
): Promise<any> {
  // Defer to original algorithm via barrel import after refactor; this placeholder will be overridden.
  const { buildSymbolGraphDetailed } = await import("./index.js");
  return await buildSymbolGraphDetailed(index);
}

export async function collectNamespaceMemberRefs(
  file: string,
  ns: string,
  member: string
): Promise<Range[]> {
  const sup = supportForFile(file);
  const lang = languageForFile(file);
  const key = (sup.id === "python" ? "py" : sup.id === "js" ? "js" : "ts") as any;
  const parser = acquireParser(lang, key);
  try {
    parser.setLanguage(lang);
    const src = await fsp.readFile(file, "utf8");
    const tree = parser.parse(src);
    const ranges: Range[] = [];
    const isMember = sup.nodeTypes.memberExpression ?? (sup.id === "python" ? "attribute" : "member_expression");
    const isPropId = (t: string) => (sup.nodeTypes.propertyIdentifier || ["property_identifier"]).includes(t) || t === "identifier";
    const walk = (node: Parser.SyntaxNode) => {
      if (node.type === isMember) {
        let obj = node.childForFieldName("object") ?? node.child(0);
        let prop = node.childForFieldName("property") ?? node.childForFieldName("attribute") ?? node.child(2);
        if (obj && prop && obj.type === "identifier" && isPropId(prop.type)) {
          const oname = sliceText(obj, src);
          const pname = sliceText(prop, src);
          if (oname === ns && pname === member) {
            ranges.push(toRange(node as any));
          }
        }
      }
      for (const ch of node.namedChildren) walk(ch);
    };
    walk(tree.rootNode);
    return ranges;
  } finally {
    releaseParser(parser, key);
  }
}
