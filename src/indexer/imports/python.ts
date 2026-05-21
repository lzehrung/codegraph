import fs from "node:fs";
import path from "node:path";
import { resolvePythonModule } from "../../util/resolution.js";
import { stripPythonCommentsAndStrings } from "../../util/comments.js";
import type { ImportBindingSink, ResolvedImportTarget } from "./context.js";

export type PythonImportExtractionContext = ImportBindingSink & {
  file: string;
  projectRoot: string;
  source: string;
};

function splitRelativeModuleSpec(moduleSpec: string): { relDots: number; mod: string | null } {
  const match = moduleSpec.match(/^(\.+)(.*)$/);
  if (!match) return { relDots: 0, mod: moduleSpec };
  return {
    relDots: match[1]!.length,
    mod: match[2] || null,
  };
}

function resolvePythonNamespaceMember(resolved: ResolvedImportTarget, imported: string): string | undefined {
  if (typeof resolved !== "string") return undefined;
  let baseDir = resolved;
  try {
    const stat = fs.statSync(baseDir);
    if (!stat.isDirectory() && baseDir.toLowerCase().endsWith("__init__.py")) {
      baseDir = path.dirname(baseDir);
    }
  } catch {
    return undefined;
  }

  const candidates = [
    path.join(baseDir, `${imported}.py`),
    path.join(baseDir, imported, "__init__.py"),
    path.join(baseDir, imported),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate.replace(/\\/g, "/");
      }
    } catch {
      // Ignore filesystem races and continue trying remaining namespace candidates.
    }
  }
  return undefined;
}

async function pushStarImport(context: PythonImportExtractionContext, moduleSpec: string): Promise<void> {
  const { relDots, mod } = splitRelativeModuleSpec(moduleSpec);
  const resolved = await resolvePythonModule(context.projectRoot, context.file, mod, relDots);
  context.pushBinding({
    kind: "star",
    from: moduleSpec,
    resolved,
    mechanism: "python",
  });
}

async function pushNamedImport(
  context: PythonImportExtractionContext,
  moduleSpec: string,
  imported: string,
  local: string,
): Promise<void> {
  const { relDots, mod } = splitRelativeModuleSpec(moduleSpec);
  const resolved = await resolvePythonModule(context.projectRoot, context.file, mod, relDots);
  const namespaceResolved = resolvePythonNamespaceMember(resolved, imported);
  if (namespaceResolved) {
    context.pushBinding({
      kind: "namespace",
      localNS: local,
      from: moduleSpec,
      resolved: namespaceResolved,
      mechanism: "python",
    });
    return;
  }

  context.pushBinding({
    kind: "named",
    local,
    imported,
    from: moduleSpec,
    resolved,
    mechanism: "python",
  });
}

async function pushDefaultImport(context: PythonImportExtractionContext, dotted: string, local: string): Promise<void> {
  const resolved = await resolvePythonModule(context.projectRoot, context.file, dotted, 0);
  context.pushBinding({
    kind: "namespace",
    localNS: local,
    from: dotted,
    resolved,
    mechanism: "python",
  });
}

export async function collectPythonImportsFromSource(context: PythonImportExtractionContext): Promise<void> {
  const pySrc = stripPythonCommentsAndStrings(context.source);
  const fromLinePattern = /^\s*from\s+([^\s]+)\s+import\s+([^\n#]+)/gm;
  for (const match of pySrc.matchAll(fromLinePattern)) {
    const mod = match[1]!.trim();
    const items = match[2]!.split(",").map((item) => item.trim());
    for (const item of items) {
      if (item === "*") {
        await pushStarImport(context, mod);
        continue;
      }
      const aliasMatch = item.match(/^([A-Za-z_][\w_]*)(?:\s+as\s+([A-Za-z_][\w_]*))?$/);
      if (!aliasMatch) continue;
      const imported = aliasMatch[1]!;
      const local = aliasMatch[2] ?? imported;
      await pushNamedImport(context, mod, imported, local);
    }
  }

  const importPattern = /^(?:\s*)import\s+([A-Za-z_][\w.]*)\s*(?:as\s+([A-Za-z_][\w_]*))?/gm;
  for (const match of pySrc.matchAll(importPattern)) {
    const dotted = match[1]!;
    const local = match[2] ?? dotted.split(".")[0]!;
    await pushDefaultImport(context, dotted, local);
  }
}
