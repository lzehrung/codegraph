import fs from "node:fs";
import path from "node:path";
import { resolvePythonModule } from "../../util/resolution.js";
import { stripPythonCommentsAndStrings } from "../../util/comments.js";
import { PYTHON_IDENTIFIER_SOURCE } from "../../util/identifiers.js";
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
    if (
      !stat.isDirectory() &&
      (baseDir.toLowerCase().endsWith("__init__.py") || baseDir.toLowerCase().endsWith("__init__.pyi"))
    ) {
      baseDir = path.dirname(baseDir);
    }
  } catch {
    return undefined;
  }

  const candidates = [
    path.join(baseDir, `${imported}.py`),
    path.join(baseDir, `${imported}.pyi`),
    path.join(baseDir, imported, "__init__.py"),
    path.join(baseDir, imported, "__init__.pyi"),
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

async function pushStarImport(
  context: PythonImportExtractionContext,
  moduleSpec: string,
  moduleLevel: boolean,
): Promise<void> {
  const { relDots, mod } = splitRelativeModuleSpec(moduleSpec);
  const resolved = await resolvePythonModule(context.projectRoot, context.file, mod, relDots);
  context.pushBinding({
    kind: "star",
    from: moduleSpec,
    resolved,
    mechanism: "python",
    moduleLevel,
  });
}

async function pushNamedImport(
  context: PythonImportExtractionContext,
  moduleSpec: string,
  imported: string,
  local: string,
  moduleLevel: boolean,
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
      moduleLevel,
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
    moduleLevel,
  });
}

async function pushDefaultImport(
  context: PythonImportExtractionContext,
  dotted: string,
  local: string,
  moduleLevel: boolean,
): Promise<void> {
  const resolved = await resolvePythonModule(context.projectRoot, context.file, dotted, 0);
  context.pushBinding({
    kind: "namespace",
    localNS: local,
    from: dotted,
    resolved,
    mechanism: "python",
    moduleLevel,
  });
}

const PYTHON_NAMED_IMPORT_PATTERN = new RegExp(
  String.raw`^(${PYTHON_IDENTIFIER_SOURCE})(?:\s+as\s+(${PYTHON_IDENTIFIER_SOURCE}))?$`,
  "u",
);
const PYTHON_MODULE_IMPORT_PATTERN = new RegExp(
  String.raw`^[\t ]*import\s+(${PYTHON_IDENTIFIER_SOURCE}(?:\.${PYTHON_IDENTIFIER_SOURCE})*)\s*(?:as\s+(${PYTHON_IDENTIFIER_SOURCE}))?`,
  "gmu",
);

export async function collectPythonImportsFromSource(context: PythonImportExtractionContext): Promise<void> {
  const pySrc = stripPythonCommentsAndStrings(context.source);
  const fromLinePattern = /^[\t ]*from\s+([^\s]+)\s+import\s+([^\n#]+)/gm;
  for (const match of pySrc.matchAll(fromLinePattern)) {
    const mod = match[1]!.trim();
    const moduleLevel = !/^[\t ]/.test(match[0]);
    const items = match[2]!.split(",").map((item) => item.trim());
    for (const item of items) {
      if (item === "*") {
        await pushStarImport(context, mod, moduleLevel);
        continue;
      }
      // PEP 3131 permits Unicode identifiers (XID_Start/XID_Continue); an ASCII-only
      // character class here silently drops every non-ASCII imported name's binding.
      const aliasMatch = item.match(PYTHON_NAMED_IMPORT_PATTERN);
      if (!aliasMatch) continue;
      const imported = aliasMatch[1]!;
      const local = aliasMatch[2] ?? imported;
      await pushNamedImport(context, mod, imported, local, moduleLevel);
    }
  }

  const importPattern = PYTHON_MODULE_IMPORT_PATTERN;
  for (const match of pySrc.matchAll(importPattern)) {
    const dotted = match[1]!;
    const local = match[2] ?? dotted.split(".")[0]!;
    await pushDefaultImport(context, dotted, local, !/^[\t ]/.test(match[0]));
  }
}
