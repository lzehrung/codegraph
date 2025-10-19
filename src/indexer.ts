import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import Parser from "tree-sitter";
import {
  supportForFile,
  languageForFile,
} from "./languages.js";
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
} from "./util.js";
import { type Graph, collectGraph } from "./graphs.js";

export enum SymbolKind {
  Function = "function",
  Class = "class",
  Variable = "variable",
  Interface = "interface",
  TypeAlias = "type",
  Default = "default",
}

export type Pos = { line: number; column: number; index: number };
export type Range = { start: Pos; end: Pos };
export type FileId = string;

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
};
export type ResolvedExport = { kind: "resolved"; def: SymbolDef };

export function collectLocalsAndExportsFromSource(
  file: string,
  source: string,
  support: any,
  lang: Parser.Language,
  imports: ImportBinding[] = []
): ModuleIndex {
  let tree: Parser.Tree | null = null;
  try {
    const parser = new Parser();
    parser.setLanguage(lang);
    tree = parser.parse(source);
  } catch {}

  const locals: SymbolDef[] = [];
  if (tree) {
    if (support.id === "python") {
      try {
        const q = new Parser.Query(lang, support.queries.locals);
        for (const m of q.matches(tree.rootNode))
          for (const cap of m.captures) {
            if (cap.name === "name" || cap.name === "tname") {
              locals.push({
                file,
                localName: sliceText(cap.node, source),
                kind: (support.classifyDefinition(cap.node) as any) as SymbolKind,
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
        imports
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
      const q = new Parser.Query(lang, support.queries.exports);
      for (const m of q.matches(tree.rootNode)) {
        const map = Object.fromEntries(
          m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const)
        );
        const stmtText = map["stmt"] ? sliceText(map["stmt"].node, source) : "";
        const isTypeOnly = /^\s*export\s+type\b/.test(stmtText);

        if (support.id === "python") {
          if (map["left"] && sliceText(map["left"].node, source) === "__all__") {
            const items = m.captures.filter((c: Parser.QueryCapture) => c.name === "all_item");
            for (const it of items) {
              const name = unquote(sliceText(it.node, source));
              const local = locals.find((d) => d.localName === name);
              if (local) exports.push({ type: "local", exportedAs: name, target: local });
            }
            continue;
          }
          if (map["name"]) {
            const nameText = sliceText(map["name"].node, source);
            const local = locals.find((d) => d.localName === nameText);
            if (local) {
              if (!nameText.startsWith("_")) {
                exports.push({ type: "local", exportedAs: nameText, target: local });
              }
            }
            continue;
          }
        }

        if (map["from"]) {
          const from = unquote(sliceText(map["from"].node, source));
          if (map["src"]) {
            const srcName = sliceText(map["src"].node, source);
            const alias = map["alias"] ? sliceText(map["alias"].node, source) : srcName;
            exports.push({ type: "reexport", exportedAs: alias, fromModule: from, sourceSpecifier: srcName, typeOnly: isTypeOnly });
          } else {
            exports.push({ type: "exportStar", fromModule: from, sourceSpecifier: from, typeOnly: isTypeOnly });
          }
          continue;
        }
        if (map["cjs_shorthand"]) {
          const nameText = sliceText(map["cjs_shorthand"].node, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local) exports.push({ type: "local", exportedAs: nameText, target: local });
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
          const sym: SymbolDef = { file, localName: exportedAs, kind: SymbolKind.Function, range: defRange };
          locals.push(sym);
          exports.push({ type: "local", exportedAs, target: sym });
          continue;
        }
        if (map["default"]) {
          const nameText = sliceText(map["default"].node, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local) exports.push({ type: "local", exportedAs: "default", target: { ...local, kind: SymbolKind.Default } });
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
          if (local) exports.push({ type: "local", exportedAs: "default", target: { ...local, kind: SymbolKind.Default } });
          continue;
        }
        if (map["name"]) {
          const nameNode = map["name"].node;
          const nameText = sliceText(nameNode, source);
          const local = locals.find((d) => d.localName === nameText);
          if (local) {
            exports.push({ type: "local", exportedAs: nameText, target: local });
            let cur: Parser.SyntaxNode | null = nameNode;
            let exportStmt: Parser.SyntaxNode | null = null;
            while (cur) {
              if (cur.type === "export_statement") { exportStmt = cur; break; }
              cur = cur.parent;
            }
            const exportText = exportStmt ? sliceText(exportStmt, source) : stmtText;
            if (/^\s*export\s+default\b/.test(exportText)) {
              exports.push({ type: "local", exportedAs: "default", target: { ...local, kind: SymbolKind.Default } });
            }
          }
          continue;
        }
        if (map["src"]) {
          const srcName = sliceText(map["src"].node, source);
          const alias = map["alias"] ? sliceText(map["alias"].node, source) : srcName;
          const local = locals.find((d) => d.localName === srcName);
          if (local) exports.push({ type: "local", exportedAs: alias, target: local });
        }
      }
      if (!exports.some((e) => e.type === "local" && e.exportedAs === "default")) {
        const mDefFn = source.match(/\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
        const mDefCls = source.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
        const name = mDefFn?.[1] ?? mDefCls?.[1];
        if (name) {
          const local = locals.find((d) => d.localName === name);
          if (local) exports.push({ type: "local", exportedAs: "default", target: { ...local, kind: SymbolKind.Default } });
        }
      }
    } catch {
      // fall through to regex fallback below
    }
  }

  // Regex fallback for JS/TS exports when queries miss some patterns (e.g., re-exports)
  if (support.id === "ts" || support.id === "js") {
    const reDecl = /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
    const reDefault = /\bexport\s+default\s+([A-Za-z_$][\w$]*)/g;
    const reReexport = /\bexport\s*\{\s*([^}]+)\}\s*from\s*("|')([^"']+)\2/g;
    const reReexportNs = /\bexport\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*("|')([^"']+)\2/g;
    const reStar = /\bexport\s*\*\s*from\s*("|')([^"']+)\1/g;
    let m: RegExpExecArray | null;
    while ((m = reDecl.exec(source))) {
      const name = m[1]!;
      if (!exports.some((e: any) => e.type === "local" && (e as any).exportedAs === name)) {
        const local = locals.find((d) => d.localName === name);
        if (local) exports.push({ type: "local", exportedAs: name, target: local });
      }
    }
    while ((m = reDefault.exec(source))) {
      const name = m[1]!;
      if (!exports.some((e: any) => e.type === "local" && (e as any).exportedAs === "default")) {
        const local = locals.find((d) => d.localName === name);
        if (local) exports.push({ type: "local", exportedAs: "default", target: { ...local, kind: SymbolKind.Default } });
      }
    }
    while ((m = reReexport.exec(source))) {
      const list = m[1]!.split(",").map(s => s.trim()).filter(Boolean);
      const from = m[3]!;
      for (const spec of list) {
        const mm = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!mm) continue;
        const srcName = mm[1]!;
        const alias = (mm[2] ?? srcName) as string;
        if (!exports.some((e: any) => e.type === "reexport" && (e as any).exportedAs === alias && (e as any).fromModule === from)) {
          exports.push({ type: "reexport", exportedAs: alias, fromModule: from, sourceSpecifier: srcName });
        }
      }
    }
    while ((m = reReexportNs.exec(source))) {
      const alias = m[1]!;
      const from = m[3]!;
      if (!exports.some((e: any) => e.type === "reexport" && (e as any).exportedAs === alias && (e as any).fromModule === from)) {
        exports.push({ type: "reexport", exportedAs: alias, fromModule: from, sourceSpecifier: "" as any });
      }
    }
    while ((m = reStar.exec(source))) {
      const from = m[2]!;
      if (!exports.some((e: any) => e.type === "exportStar" && (e as any).fromModule === from)) {
        exports.push({ type: "exportStar", fromModule: from, sourceSpecifier: from });
      }
    }
    // CommonJS: exports.name = function/arrow, module.exports.name = function/arrow
    const reCjsFn = /(?:^|[;\n\r])\s*(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=\s*(function\b|\([^)]*\)\s*=>)/g;
    while ((m = reCjsFn.exec(source))) {
      const exportedAs = m[1]!;
      if (!locals.find((d) => d.localName === exportedAs)) {
        const idx = m.index + m[0]!.indexOf(exportedAs);
        const pos = { line: 1, column: 1, index: idx } as any;
        const sym: SymbolDef = { file, localName: exportedAs, kind: SymbolKind.Function, range: { start: pos, end: pos } };
        locals.push(sym);
      }
      const local = locals.find((d) => d.localName === exportedAs)!;
      if (!exports.some((e: any) => e.type === "local" && (e as any).exportedAs === exportedAs)) {
        exports.push({ type: "local", exportedAs, target: local });
      }
    }
    // CommonJS: module.exports = { helper: function(){}, ... }
    const reCjsObjFn = /([A-Za-z_$][\w$]*)\s*:\s*(function\b|\([^)]*\)\s*=>)/g;
    const moduleExportsObjMatch = source.match(/module\.exports\s*=\s*\{([^}]*)\}/s);
    if (moduleExportsObjMatch && moduleExportsObjMatch.index !== undefined) {
      const objContent = moduleExportsObjMatch[1]!;
      let mObj: RegExpExecArray | null;
      while ((mObj = reCjsObjFn.exec(objContent))) {
        const exportedAs = mObj[1]!;
        if (!locals.find((d) => d.localName === exportedAs)) {
          const idx = moduleExportsObjMatch.index + moduleExportsObjMatch[0]!.indexOf(exportedAs);
          const pos = { line: 1, column: 1, index: idx } as any;
          const sym: SymbolDef = { file, localName: exportedAs, kind: SymbolKind.Function, range: { start: pos, end: pos } };
          locals.push(sym);
        }
        const local = locals.find((d) => d.localName === exportedAs)!;
        if (!exports.some((e: any) => e.type === "local" && (e as any).exportedAs === exportedAs)) {
          exports.push({ type: "local", exportedAs, target: local });
        }
      }
    }
  }

  if ((support.id === "ts" || support.id === "js") && !exports.some((e) => e.type === "local" && e.exportedAs === "default")) {
    const defFn = source.match(/\bexport\s+default\s+function\s+([A-Za-z_$][\w$]*)/);
    const defCls = source.match(/\bexport\s+default\s+class\s+([A-Za-z_$][\w$]*)/);
    const defIdent = source.match(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\b/);
    const name = defFn?.[1] ?? defCls?.[1] ?? defIdent?.[1];
    if (name) {
      const local = locals.find((d) => d.localName === name);
      if (local) exports.push({ type: "local", exportedAs: "default", target: { ...local, kind: SymbolKind.Default } });
    }
  }

  return { file, exports, imports: [], locals };
}

export async function collectImportsForFile(
  file: string,
  projectRoot: string
): Promise<ImportBinding[]> {
  const sup = supportForFile(file);
  const lang = languageForFile(file);
  const source = await fsp.readFile(file, "utf8");
  const imports: ImportBinding[] = [];

  if (sup.id === "python") {
    const pySrc = stripPythonCommentsAndStrings(source);
    const pushStar = async (moduleSpec: string) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? (m[2] || null) : moduleSpec;
      const resolved = await resolvePythonModule(projectRoot, file, mod as any, relDots);
      imports.push({ kind: "star", from: moduleSpec, resolved, mechanism: "python" });
    };
    const pushNamed = async (moduleSpec: string, imported: string, local: string) => {
      const m = moduleSpec.match(/^(\.+)(.*)$/);
      const relDots = m ? m[1]!.length : 0;
      const mod = m ? (m[2] || null) : moduleSpec;
      const resolved = await resolvePythonModule(projectRoot, file, mod as any, relDots);
      let nsResolved: string | undefined;
      if (typeof resolved === "string") {
        let baseDir = resolved;
        try {
          const st = fs.statSync(baseDir);
          if (!st.isDirectory() && baseDir.toLowerCase().endsWith("__init__.py")) baseDir = path.dirname(baseDir);
        } catch {}
        const sub = [path.join(baseDir, `${imported}.py`), path.join(baseDir, imported, "__init__.py"), path.join(baseDir, imported)];
        for (const c of sub) {
          try {
            if (fs.existsSync(c)) { nsResolved = fs.statSync(c).isDirectory() ? c : c; break; }
          } catch {}
        }
      }
      if (nsResolved) {
        imports.push({ kind: "namespace", localNS: local, from: moduleSpec, resolved: nsResolved, mechanism: "python" });
      } else {
        imports.push({ kind: "named", local, imported, from: moduleSpec, resolved, mechanism: "python" });
      }
    };
    const pushDefault = async (dotted: string, local: string) => {
      const resolved = await resolvePythonModule(projectRoot, file, dotted as any, 0);
      imports.push({ kind: "namespace", localNS: local, from: dotted, resolved, mechanism: "python" });
    };

    const reFromLine = /^\s*from\s+([^\s]+)\s+import\s+([^\n#]+)/gm;
    for (const m of pySrc.matchAll(reFromLine)) {
      const mod = m[1]!.trim();
      const items = m[2]!.split(",").map((s) => s.trim());
      for (const it of items) {
        if (it === "*") { await pushStar(mod); continue; }
        const am = it.match(/^([A-Za-z_][\w_]*)(?:\s+as\s+([A-Za-z_][\w_]*))?$/);
        if (am) {
          const imported = am[1]!;
          const local = (am[2] ?? imported) as string;
          await pushNamed(mod, imported, local);
        }
      }
    }
    const reImp = /^(?:\s*)import\s+([A-Za-z_][\w\.]*)\s*(?:as\s+([A-Za-z_][\w_]*))?/gm;
    for (const m of pySrc.matchAll(reImp)) {
      const dotted = m[1]!;
      const local = (m[2] ?? dotted.split(".")[0]) as string;
      await pushDefault(dotted, local);
    }
    return imports;
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  const tsCfg = sup.id === "ts" ? await loadNearestTsconfigFor(file) : {} as any;
  const workspaceConfig = await loadWorkspaceConfig(projectRoot);

  const resolveFrom = async (from: string) =>
    await resolveSpecifier(file, from, projectRoot, tsCfg.matchPath, workspaceConfig);

  const runFallback = async () => {
    const src = sup.id === "ts" || sup.id === "js" ? stripJsLikeComments(source) : source;
    const typeOnlyImport = /\bimport\s+type\b/;
    const reFrom = /^\s*import\s+([^\n;]*?)\s+from\s+(["'])(?<m>[^"']+)\2/gm;
    for (const m of src.matchAll(reFrom)) {
      const clause = m[1]!.trim();
      const mod = (m.groups as any).m as string;
      const typeOnly = typeOnlyImport.test(m[0]!);
      const resolved = await resolveFrom(mod);
      const ns = clause.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (ns) {
        imports.push({ kind: "namespace", localNS: ns[1]!, from: mod, resolved, typeOnly });
        continue;
      }
      const parts = clause.split(",");
      if (parts.length) {
        const first = parts[0]!.trim();
        if (first && !first.startsWith("{")) imports.push({ kind: "default", local: first, from: mod, resolved, typeOnly });
        const namedBlock = parts.slice(1).join(",").trim() || (first.startsWith("{") ? first : "");
        const names = namedBlock.replace(/[{}]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
        for (const spec of names) {
          const nm = spec.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
          if (!nm) continue;
          const imported = nm[1]!;
          const local = (nm[2] ?? imported) as string;
          imports.push({ kind: "named", local, imported, from: mod, resolved, typeOnly });
        }
      }
    }
    const reReqDefault = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
    for (const m of src.matchAll(reReqDefault)) {
      const local = m[1]!;
      const mod = (m.groups as any).m as string;
      const resolved = await resolveFrom(mod);
      imports.push({ kind: "default", local, from: mod, resolved, mechanism: "cjs" });
    }
    const reReqNamed = /\b(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(\s*(["'])(?<m>[^"']+)\2\s*\)/g;
    for (const m of src.matchAll(reReqNamed)) {
      const specs = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
      const mod = (m.groups as any).m as string;
      const resolved = await resolveFrom(mod);
      for (const spec of specs) {
        const nm = spec.match(/^([A-Za-z_$][\w$]*)(?::\s*([A-Za-z_$][\w$]*))?$/);
        if (!nm) continue;
        const imported = nm[1]!;
        const local = (nm[2] ?? imported) as string;
        imports.push({ kind: "named", local, imported, from: mod, resolved, mechanism: "cjs" });
      }
    }
  };

  let ranFallback = false;
  try {
    const q = new Parser.Query(lang, sup.queries.importBindings);
    for (const m of q.matches(tree.rootNode)) {
      const caps = Object.fromEntries(m.captures.map((x: Parser.QueryCapture) => [x.name, x] as const));
      const stmtText = caps["stmt"] ? sliceText(caps["stmt"].node, source) : "";
      const typeOnly = sup.id === "ts" && /^\s*import\s+type\b/.test(stmtText);
      const from = caps["from"] ? unquote(sliceText(caps["from"].node, source)) : undefined as any;

      const patterns = m.captures.filter((c: Parser.QueryCapture) => c.name === "pattern");
      for (const pattern of patterns) {
        const patternNode = pattern.node;
        if (patternNode.type === "object_pattern") {
          for (const child of (patternNode as any).namedChildren) {
            if (child.type === "shorthand_property_identifier") {
              const name = sliceText(child, source);
              imports.push({ kind: "named", local: name, imported: name, from: from || "", resolved: from ? await resolveFrom(from) : { external: "" }, typeOnly });
            } else if (child.type === "pair_pattern") {
              const key = child.childForFieldName("key");
              const value = child.childForFieldName("value");
              if (key && value && key.type === "property_identifier" && value.type === "identifier") {
                const imported = sliceText(key, source);
                const local = sliceText(value, source);
                imports.push({ kind: "named", local, imported, from: from || "", resolved: from ? await resolveFrom(from) : { external: "" }, typeOnly });
              }
            }
          }
        }
      }

      if (!from) continue;
      const resolved = await resolveFrom(from);
      if (caps["def"]) {
        imports.push({ kind: "default", local: sliceText(caps["def"].node, source), from, resolved, typeOnly });
      }
      if (caps["ns"]) {
        const nsName = sliceText(caps["ns"].node, source);
        imports.push({ kind: "namespace", localNS: nsName, from, resolved, typeOnly });
      }
      const inames = m.captures.filter((c: Parser.QueryCapture) => c.name === "iname");
      const aliases = m.captures.filter((c: Parser.QueryCapture) => c.name === "alias");
      for (let i = 0; i < inames.length; i++) {
        const imported = sliceText(inames[i]!.node, source);
        const alias = aliases[i] ? sliceText(aliases[i]!.node, source) : imported;
        imports.push({ kind: "named", local: alias, imported, from, resolved, typeOnly });
      }
    }
  } catch {
    await runFallback();
    ranFallback = true;
  }
  if (!ranFallback) {
    const before = imports.length;
    await runFallback();
    if (imports.length > before) {
      const seen = new Set<string>();
      const out: ImportBinding[] = [];
      for (const imp of imports) {
        let key = imp.kind;
        if (imp.kind === "named") key += `|${(imp as any).local}|${(imp as any).from}`;
        else if (imp.kind === "default") key += `|${(imp as any).local}|${(imp as any).from}`;
        else if (imp.kind === "namespace") key += `|${(imp as any).localNS}|${(imp as any).from}`;
        else if (imp.kind === "star") key += `|${(imp as any).from}`;
        if (!seen.has(key)) { seen.add(key); out.push(imp); }
      }
      imports.splice(0, imports.length, ...out);
    }
  }
  return imports;
}

export async function buildProjectIndex(
  projectRoot: string
): Promise<ProjectIndex> {
  const files = await listProjectFiles(projectRoot);
  if (files.length === 0) {
    console.warn(`Warning: No files found in project root: ${projectRoot}`);
  }
  const modules = new Map<FileId, ModuleIndex>();

  const filePromises = files.map(async (f) => {
    try {
      const sup = supportForFile(f);
      const lang = languageForFile(f);
      const src = await fsp.readFile(f, "utf8");
      const imports = await collectImportsForFile(f, projectRoot);
      const mod = collectLocalsAndExportsFromSource(f, src, sup, lang, imports);
      mod.imports = imports;

      if (sup.supportsCrossModuleSymbols) {
        if (sup.id === "ts" || sup.id === "js") {
          const { matchPath } = await loadNearestTsconfigFor(f);
          for (const e of mod.exports) if ((e as any).type !== "local") {
            const ee: any = e;
            if (ee.fromModule.startsWith(".")) {
              const resolved = await resolveSpecifier(f, ee.fromModule, projectRoot, matchPath, await loadWorkspaceConfig(projectRoot));
              if (typeof resolved === "string") ee.fromModule = resolved;
            } else {
              const ws = await loadWorkspaceConfig(projectRoot);
              const pkgResolved = await (await import("./util.js")).resolveWorkspacePackage(ee.fromModule, ws);
              if (pkgResolved) ee.fromModule = pkgResolved;
            }
          }
        }
      }
      return [f, mod] as const;
    } catch (error) {
      console.warn(`Warning: Failed to process file ${f}:`, error);
      const mod: ModuleIndex = { file: f, exports: [], imports: [], locals: [] };
      return [f, mod] as const;
    }
  });

  const fileResults = await Promise.all(filePromises);
  for (const [f, mod] of fileResults) {
    modules.set(f.replace(/\\/g, "/"), mod);
  }

  for (const [file, m] of modules) {
    for (const imp of [...m.imports]) {
      if (imp.kind === "star" && typeof imp.resolved === "string") {
        const target = modules.get(imp.resolved);
        if (target) {
          let exported: string[] = [];
          const viaAll = target.exports.filter((e) => (e as any).type === "local");
          if (viaAll.length) exported = (viaAll as any).map((e: any) => e.exportedAs);
          else exported = target.locals.map((l) => l.localName).filter((n) => !n.startsWith("_"));
          for (const name of exported) {
            m.imports.push({ kind: "named", local: name, imported: name, from: (imp as any).from, resolved: imp.resolved });
          }
        }
      }
    }
  }

  const graph = await collectGraph(projectRoot, files);
  return { graph, modules, byFile: modules, exportCache: new Map() };
}

export async function buildProjectIndexFromFiles(
  projectRoot: string,
  inputFiles: string[]
): Promise<ProjectIndex> {
  const files = Array.from(new Set((inputFiles || []).filter(Boolean).map((f) => path.resolve(f))));
  if (files.length === 0) {
    console.warn(`Warning: No files provided for indexing in ${projectRoot}`);
  }
  const modules = new Map<FileId, ModuleIndex>();

  const filePromises = files.map(async (f) => {
    try {
      const sup = supportForFile(f);
      const lang = languageForFile(f);
      const src = await fsp.readFile(f, "utf8");
      const imports = await collectImportsForFile(f, projectRoot);
      const mod = collectLocalsAndExportsFromSource(f, src, sup, lang, imports);
      mod.imports = imports;

      if (sup.supportsCrossModuleSymbols) {
        if (sup.id === "ts" || sup.id === "js") {
          const { matchPath } = await loadNearestTsconfigFor(f);
          for (const e of mod.exports) if ((e as any).type !== "local") {
            const ee: any = e;
            if (ee.fromModule.startsWith(".")) {
              const resolved = await resolveSpecifier(f, ee.fromModule, projectRoot, matchPath, await loadWorkspaceConfig(projectRoot));
              if (typeof resolved === "string") ee.fromModule = resolved;
            } else {
              const ws = await loadWorkspaceConfig(projectRoot);
              const pkgResolved = await (await import("./util.js")).resolveWorkspacePackage(ee.fromModule, ws);
              if (pkgResolved) ee.fromModule = pkgResolved;
            }
          }
        }
      }
      return [f, mod] as const;
    } catch (error) {
      console.warn(`Warning: Failed to process file ${f}:`, error);
      const mod: ModuleIndex = { file: f, exports: [], imports: [], locals: [] };
      return [f, mod] as const;
    }
  });

  const fileResults = await Promise.all(filePromises);
  for (const [f, mod] of fileResults) {
    modules.set(f.replace(/\\/g, "/"), mod);
  }

  for (const [file, m] of modules) {
    for (const imp of [...m.imports]) {
      if (imp.kind === "star" && typeof imp.resolved === "string") {
        const target = modules.get(imp.resolved);
        if (target) {
          let exported: string[] = [];
          const viaAll = target.exports.filter((e) => (e as any).type === "local");
          if (viaAll.length) exported = (viaAll as any).map((e: any) => e.exportedAs);
          else exported = target.locals.map((l) => l.localName).filter((n) => !n.startsWith("_"));
          for (const name of exported) {
            m.imports.push({ kind: "named", local: name, imported: name, from: (imp as any).from, resolved: imp.resolved });
          }
        }
      }
    }
  }

  const graph = await collectGraph(projectRoot, files);
  return { graph, modules, byFile: modules, exportCache: new Map() };
}

function cacheKey(file: FileId, name: string) {
  return `${file}::${name}`;
}

export function resolveExport(
  index: ProjectIndex,
  file: FileId,
  exportedName: string
): ResolvedExport | null {
  const normalizedFile = file.replace(/\\/g, "/");
  const mod = index.byFile.get(normalizedFile);
  if (!mod) return null;
  const key = cacheKey(normalizedFile, exportedName);
  if (index.exportCache.has(key)) return index.exportCache.get(key)!;

  for (const e of mod.exports) if ((e as any).type === "local" && (e as any).exportedAs === exportedName) {
    const res: ResolvedExport = { kind: "resolved", def: (e as any).target };
    index.exportCache.set(key, res);
    return res;
  }
  for (const e of mod.exports) if ((e as any).type === "reexport" && (e as any).exportedAs === exportedName && typeof (e as any).fromModule === "string") {
    const down = resolveExport(index, (e as any).fromModule, (e as any).sourceSpecifier || exportedName) || resolveExport(index, (e as any).fromModule, exportedName);
    if (down) { index.exportCache.set(key, down); return down; }
  }
  for (const e of mod.exports) if ((e as any).type === "exportStar" && typeof (e as any).fromModule === "string") {
    const down = resolveExport(index, (e as any).fromModule, exportedName);
    if (down) { index.exportCache.set(key, down); return down; }
  }
  index.exportCache.set(key, null);
  return null;
}

export type GoToRequest = { file: FileId; line: number; column: number };
export type GoToResult =
  | { status: "ok"; definition: SymbolDef; via?: { importedFrom?: string | undefined; exportedName?: string | undefined } }
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
  const parser = new Parser();
  parser.setLanguage(lang);
  const source = await fsp.readFile(file, "utf8");
  const tree = parser.parse(source);

  const pos = { row: Math.max(0, line - 1), column: Math.max(0, column - 1) } as any;
  let node: Parser.SyntaxNode | null = (tree as any).rootNode.descendantForPosition(pos, pos);

  if (node && node.type === "variable_declarator") {
    const value = (node as any).childForFieldName("value");
    if (value && value.type === "call_expression") {
      let callee = (value as any).childForFieldName("function");
      if (!callee) callee = (value as any).childForFieldName("callee");
      if (!callee) callee = (value as any).child(0);
      if (callee && (sup.nodeTypes.identifier as any).includes(callee.type)) {
        node = callee;
      }
    }
  }

  while (node && (node.type === "," || node.type === ".")) node = node.parent;
  if (!node) return { status: "not_found", reason: "No node at position" };

  if (
    sup.supportsCrossModuleSymbols &&
    ((node.type === (sup.nodeTypes.propertyIdentifier?.[0] ?? "property_identifier") && node.parent && node.parent.type === (sup.nodeTypes.memberExpression ?? "member_expression")) ||
      node.type === (sup.nodeTypes.memberExpression ?? "member_expression"))
  ) {
    const memberNode = node.type === (sup.nodeTypes.memberExpression ?? "member_expression") ? node : node.parent!;
    let obj = memberNode.child(0);
    let prop = memberNode.child(2);
    if (sup.id === "python") {
      obj = (memberNode as any).childForFieldName("object") ?? obj;
      prop = (memberNode as any).childForFieldName("attribute") ?? prop;
    }
    if (obj && prop && obj.type === "identifier") {
      const nsName = sliceText(obj as any, source);
      const member = sliceText(prop as any, source);
      const nsImport = mod.imports.find((i) => (i as any).kind === "namespace" && (i as any).localNS === nsName);
      if (nsImport) {
        const resolved = resolveImported(index, nsImport as any, member);
        if (resolved) return { status: "ok", definition: resolved, via: { ...(toModuleRef((nsImport as any).resolved) ? { importedFrom: toModuleRef((nsImport as any).resolved) } : {}), exportedName: member } };
      }
    }
  }

  const isId = (sup.nodeTypes.identifier as any).includes((node as any).type);
  let name: string | null = isId ? sliceText(node as any, source) : null;

  if (!name) {
    const findDeclNameNode = (n: Parser.SyntaxNode | null): Parser.SyntaxNode | null => {
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
          let named = (cur as any).childForFieldName("name");
          if (!named && cur.type === "assignment") {
            const left = cur.child(0);
            if (left && (sup.nodeTypes.identifier as any).includes(left.type)) named = left;
          }
          if (named && (sup.nodeTypes.identifier as any).includes(named.type)) return named;
        }
        cur = cur.parent;
      }
      return null;
    };
    const declNameNode = findDeclNameNode(node);
    if (declNameNode) name = sliceText(declNameNode as any, source);
  }

  if (name) {
    const local = mod.locals.find((d) => d.localName === name);
    if (local) {
      return { status: "ok", definition: local };
    }

    if (supportForFile(file).supportsCrossModuleSymbols) {
      const hit = resolveExport(index, file, name);
      if (hit) {
        return { status: "ok", definition: hit.def, via: { exportedName: name } };
      }

      for (const imp of mod.imports) {
        if ((imp as any).kind === "default" && (imp as any).local === name) {
          const target = resolveImported(index, imp as any, "default");
          if (target) return { status: "ok", definition: target, via: { ...(toModuleRef((imp as any).resolved) ? { importedFrom: toModuleRef((imp as any).resolved) } : {}), exportedName: "default" } };
        } else if ((imp as any).kind === "named" && (imp as any).local === name) {
          const target = resolveImported(index, imp as any, (imp as any).imported);
          if (target) return { status: "ok", definition: target, via: { ...(toModuleRef((imp as any).resolved) ? { importedFrom: toModuleRef((imp as any).resolved) } : {}), exportedName: (imp as any).imported } };
        } else if ((imp as any).kind === "namespace" && (imp as any).localNS === name) {
          const targetFile = typeof (imp as any).resolved === "string" ? (imp as any).resolved.replace(/\\/g, "/") : undefined;
          if (targetFile) {
            const targetMod = index.byFile.get(targetFile);
            if (targetMod) {
              const firstExport = targetMod.exports.find((e: any) => e.type === "local");
              if (firstExport) {
                return { status: "ok", definition: (firstExport as any).target, via: { ...(toModuleRef((imp as any).resolved) ? { importedFrom: toModuleRef((imp as any).resolved) } : {}), exportedName: (firstExport as any).exportedAs } };
              }
            }
          }
        }
      }
    }
  }

  return { status: "not_found", reason: "No matching local or imported definition" };
}

function toModuleRef(resolved?: FileId | { external: string }) {
  return !resolved ? undefined : typeof resolved === "string" ? resolved : (resolved as any).external;
}
export function resolveImported(
  index: ProjectIndex,
  imp: ImportBinding,
  exportedName: string
): SymbolDef | null {
  const targetFile = typeof imp.resolved === "string" ? (imp.resolved as string) : undefined;
  if (!targetFile) return null;
  const hit = resolveExport(index, targetFile, exportedName);
  if (hit?.def) return hit.def;
  const sup = supportForFile(targetFile);
  if ((sup as any).id === "python") {
    const base = fs.existsSync(targetFile) && fs.statSync(targetFile).isDirectory() ? targetFile : path.dirname(targetFile);
    const subCandidates = [path.join(base, `${exportedName}.py`), path.join(base, exportedName, "__init__.py"), path.join(base, exportedName)];
    for (const c of subCandidates) {
      try {
        if (fs.existsSync(c)) {
          const isDir = fs.statSync(c).isDirectory();
          const filePath = isDir ? c : c;
          return {
            file: filePath.replace(/\\/g, "/"),
            localName: exportedName,
            kind: SymbolKind.Variable,
            range: { start: { line: 1, column: 1, index: 0 }, end: { line: 1, column: 1, index: 0 } },
          };
        }
      } catch {}
    }
    return { file: (targetFile as any).replace(/\\/g, "/"), localName: exportedName, kind: SymbolKind.Variable, range: { start: { line: 1, column: 1, index: 0 }, end: { line: 1, column: 1, index: 0 } } } as any;
  }
  return null;
}

export type BindingKind = "local" | "param" | "function" | "class" | "type" | "importDefault" | "importNamed" | "namespace";
export type Binding = { name: string; kind: BindingKind; def?: Range; occurrences: Range[]; import?: ImportBinding };
export type ScopeIndex = { bindings: Map<string, Binding[]>; all: Binding[] };

export function buildScopeIndexFromSource(
  file: string,
  source: string,
  support: any,
  lang: Parser.Language,
  imports: ImportBinding[] = []
): ScopeIndex {
  type Scope = { kind: "module" | "function" | "block"; map: Map<string, Binding> };
  const rootScope: Scope = { kind: "module", map: new Map() };
  const stack: Scope[] = [rootScope];

  for (const imp of imports) {
    if ((imp as any).kind === "default") rootScope.map.set((imp as any).local, { name: (imp as any).local, kind: "importDefault", occurrences: [], import: imp });
    if ((imp as any).kind === "named") rootScope.map.set((imp as any).local, { name: (imp as any).local, kind: "importNamed", occurrences: [], import: imp });
    if ((imp as any).kind === "namespace") rootScope.map.set((imp as any).localNS, { name: (imp as any).localNS, kind: "namespace", occurrences: [], import: imp });
  }

  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);

  const idSet = new Set([...(support.nodeTypes.identifier as string[]), ...(((support.nodeTypes.shorthandPropertyIdentifier ?? []) as string[]))]);

  const addDecl = (nameNode: Parser.SyntaxNode, kind: BindingKind) => {
    const name = sliceText(nameNode as any, source);
    let target = stack[stack.length - 1];
    if (kind === "function" || kind === "class") {
      target = rootScope;
    }
    const b: Binding = { name, kind, def: toRange(nameNode as any), occurrences: [] };
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
    if (support.createsFunctionScope(node)) stack.push({ kind: "function", map: new Map() });
    else if (support.createsBlockScope(node)) {
      if (node.type !== "program" && node.type !== "module") stack.push({ kind: "block", map: new Map() });
    }

    if (node.type === "function_declaration" || node.type === "function_definition") {
      const name = (node as any).childForFieldName("name");
      if (name) { addDecl(name, "function"); }
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
    if (node.type === "variable_declaration" || node.type === "lexical_declaration" || node.type === "assignment") {
      for (const ch of (node as any).namedChildren) {
        if (ch.type === "variable_declarator") {
          const nm = (ch as any).childForFieldName("name");
          if (nm) addDecl(nm, "local");
        } else if (ch.type === "identifier" && node.type === "assignment") {
          addDecl(ch as any, "local");
        }
      }
    }
    if (node.type === "interface_declaration" || node.type === "type_alias_declaration") {
      const name = (node as any).childForFieldName("name");
      if (name) addDecl(name, "type");
    }

    if (idSet.has(node.type) && !((support as any).isDeclarationName(node))) {
      const name = sliceText(node as any, source);
      const b = lookup(name);
      if (b) {
        b.occurrences.push(toRange(node as any));
      }
    }

    for (const ch of (node as any).namedChildren) walk(ch);

    if (support.createsFunctionScope(node) || (support.createsBlockScope(node) && node.type !== "program" && node.type !== "module")) stack.pop();
  };

  walk((tree as any).rootNode);

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
  return a.file === b.file && a.localName === b.localName && a.range.start.index === b.range.start.index;
}

function rangeContains(range: Range, pos: { row: number; column: number }): boolean {
  if (pos.row < range.start.line || pos.row > range.end.line) return false;
  if (pos.row === range.start.line && pos.column < range.start.column) return false;
  if (pos.row === range.end.line && pos.column > range.end.column) return false;
  return true;
}

export async function findReferences(
  index: ProjectIndex,
  req: { file: FileId; line: number; column: number } | { def: SymbolDef }
): Promise<{ status: "ok"; definition: SymbolDef; references: Reference[] } | { status: "not_found"; reason: string }> {
  let def: SymbolDef | null = null;
  if ("def" in req) def = req.def as any;
  else {
    const got = await goToDefinition(index, req as any);
    if (got.status === "ok") def = got.definition;
  }
  if (!def) return { status: "not_found", reason: "Could not resolve definition" };

  const definitionFile = def.file;
  const sup = supportForFile(definitionFile);
  const lang = languageForFile(definitionFile);
  const src = await fsp.readFile(definitionFile, "utf8");
  const scope = buildScopeIndexFromSource(definitionFile, src, sup as any, lang, index.byFile.get(definitionFile)?.imports as any);

  const refs: Reference[] = [];

  const localBindings = scope.bindings.get(def.localName) ?? [];
  const localBinding = localBindings.find((b) => b.def && (b.def as any).start.index === def!.range.start.index);
  if (localBinding) for (const occ of localBinding.occurrences) refs.push({ file: definitionFile, range: occ });
  refs.push({ file: definitionFile, range: def.range });

  const exportedNames: string[] = [];
  const mod = index.byFile.get(definitionFile);
  if (mod) for (const e of mod.exports) if ((e as any).type === "local" && sameDef((e as any).target, def)) exportedNames.push((e as any).exportedAs);
  if (!exportedNames.length) exportedNames.push(def.localName);

  for (const [f, m] of index.byFile) {
    if (f === definitionFile) continue;

    let sc: any = null;
    const ensure = async () => {
      if (!sc) {
        const s = await fsp.readFile(f, "utf8");
        sc = buildScopeIndexFromSource(f, s, supportForFile(f) as any, languageForFile(f), (m.imports as any));
      }
      return sc;
    };

    for (const imp of m.imports) {
      const targetFile = typeof (imp as any).resolved === "string" ? (imp as any).resolved : undefined;
      if (!targetFile) continue;
      for (const name of exportedNames) {
        if ((imp as any).kind === "namespace") {
          const hit = resolveExport(index, targetFile, name);
          if (!hit || !sameDef(hit.def, def)) continue;
          const scopeIdx = await ensure();
          const nsName = (imp as any).localNS;
          const member = name;
          const ranges = await collectNamespaceMemberRefs(f, nsName, member);
          for (const r of ranges) refs.push({ file: f, range: r as any, via: { import: imp as any, namespaceMember: member } });
        } else {
          if ((imp as any).kind === "star") continue;
          const exported = (imp as any).kind === "named" ? (imp as any).imported : (imp as any).kind === "default" ? "default" : name;
          const hit = resolveExport(index, targetFile, exported);
          if (!hit || !sameDef(hit.def, def)) continue;
          const scopeIdx = await ensure();
          const localName = (imp as any).kind === "default" ? (imp as any).local : (imp as any).local;
          const binds = (scopeIdx.bindings.get(localName) ?? []) as any[];
          for (const b of binds) for (const occ of b.occurrences) refs.push({ file: f, range: occ, via: { import: imp as any } });
        }
      }
    }
  }

  const seen = new Set<string>();
  const uniqueRefs: typeof refs = [];
  for (const ref of refs) {
    const key = `${ref.file}:${ref.range.start.line}:${ref.range.start.column}`;
    if (!seen.has(key)) { seen.add(key); uniqueRefs.push(ref); }
  }

  uniqueRefs.sort((a, b) => (a.file === b.file ? a.range.start.index - b.range.start.index : a.file.localeCompare(b.file)));
  return { status: "ok", definition: def, references: uniqueRefs };
}

// Detailed symbol graph re-export compatibility
export async function __buildSymbolGraphDetailedCompat(index: any): Promise<any> {
  // Defer to original algorithm via barrel import after refactor; this placeholder will be overridden.
  const { buildSymbolGraphDetailed } = await import("./index.js");
  return await buildSymbolGraphDetailed(index);
}

export async function collectNamespaceMemberRefs(file: string, ns: string, member: string): Promise<Range[]> {
  const src = await fsp.readFile(file, "utf8");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${esc(ns)}\\s*\\.\\s*${esc(member)}\\b`, "g");
  const posAt = (i: number): Pos => {
    const pre = src.slice(0, i);
    const line = pre.split("\n").length;
    const col = i - pre.lastIndexOf("\n");
    return { line, column: col, index: i };
  };
  const ranges: Range[] = [];
  for (let m; (m = re.exec(src)); ) ranges.push({ start: posAt(m.index), end: posAt(m.index + m[0].length) });
  return ranges;
}
