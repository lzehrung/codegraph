import fs from "node:fs/promises";
import path from "node:path";
import { findReferences } from "./navigation.js";
import type { ProjectIndex, SymbolDef } from "./types.js";
import type { FileId, Range } from "../types.js";
import { fileIdentityKey, isFilePathWithinRoot, isPhysicalPathWithinRoot } from "../util/paths.js";

export type UnusedExportCandidate = {
  file: FileId;
  name: string;
  exportedAs: string;
  kind: SymbolDef["kind"];
  range: Range;
  reason: "no references found in the indexed project";
};

function entryPointTargets(value: unknown, packageDir: string, root: string, targets: Set<string>): boolean {
  if (typeof value === "string") {
    // A wildcard may expose any indexed file. Omit all claims if its targets cannot be enumerated.
    if (value.includes("*")) return false;
    if (!value || value.includes(":") || value.startsWith("#")) return true;
    const resolved = path.resolve(packageDir, value);
    if (!isFilePathWithinRoot(root, resolved)) return true;
    targets.add(fileIdentityKey(resolved));
    if (!path.extname(resolved)) {
      for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
        targets.add(fileIdentityKey(`${resolved}${extension}`));
      }
    }
    // Source indexes can exclude compiled dist files. Keep their matching source entry points safe.
    const relative = path.relative(packageDir, resolved).replaceAll("\\", "/");
    if (relative.startsWith("dist/") && /\.[cm]?js$/u.test(relative)) {
      const source = path.join(packageDir, "src", relative.slice(5).replace(/\.[cm]?js$/u, ".ts"));
      targets.add(fileIdentityKey(source));
    }
    return true;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!entryPointTargets(item, packageDir, root, targets)) return false;
    }
    return true;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      if (!entryPointTargets(item, packageDir, root, targets)) return false;
    }
  }
  return true;
}

async function packageEntryPoints(index: ProjectIndex): Promise<Set<string> | null> {
  const root = index.projectRoot;
  if (!root) return null;
  const manifests = new Set<string>([path.join(root, "package.json")]);
  for (const info of index.projectFiles ?? []) {
    if (info.kind === "file" && path.basename(info.path) === "package.json") manifests.add(info.path);
  }
  const targets = new Set<string>();
  for (const manifest of manifests) {
    if (!isFilePathWithinRoot(root, manifest)) return null;
    let contents: string;
    try {
      await fs.lstat(manifest);
      if (!(await isPhysicalPathWithinRoot(root, manifest))) return null;
      contents = await fs.readFile(manifest, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return null;
    }
    let metadata: unknown;
    try {
      metadata = JSON.parse(contents);
    } catch {
      return null;
    }
    if (!metadata || typeof metadata !== "object") return null;
    const fields = metadata as Record<string, unknown>;
    const packageDir = path.dirname(manifest);
    // Node also accepts index.js without an explicit main field. Include source forms.
    for (const extension of [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]) {
      targets.add(fileIdentityKey(path.join(packageDir, `index${extension}`)));
    }
    for (const field of ["main", "module", "bin", "exports", "types", "typings"] as const) {
      if (!entryPointTargets(fields[field], packageDir, root, targets)) return null;
    }
  }
  return targets;
}

/** Conservative candidates only: a complete indexed reference scan is necessary, not proof of dead code. */
export async function findUnusedExports(index: ProjectIndex): Promise<UnusedExportCandidate[]> {
  const entryPoints = await packageEntryPoints(index);
  if (!entryPoints) return [];
  const protectedFiles = new Set(entryPoints);
  for (const module of index.byFile.values()) {
    for (const entry of module.exports) {
      if (entry.type !== "local") protectedFiles.add(fileIdentityKey(entry.fromModule));
    }
  }
  for (const edge of index.graph.edges) {
    if (edge.to.type !== "file") continue;
    const target = fileIdentityKey(edge.to.path);
    const importer = index.byFile.get(fileIdentityKey(edge.from));
    let hasBinding = false;
    let hasOpaqueBinding = false;
    for (const binding of importer?.imports ?? []) {
      if (typeof binding.resolved !== "string" || fileIdentityKey(binding.resolved) !== target) continue;
      hasBinding = true;
      if (binding.kind === "star" || binding.kind === "namespace") {
        hasOpaqueBinding = true;
        break;
      }
    }
    if (edge.resolved === "heuristic" || !hasBinding || hasOpaqueBinding) {
      protectedFiles.add(target);
    }
  }

  const candidates: UnusedExportCandidate[] = [];
  const seen = new Set<string>();
  for (const module of index.byFile.values()) {
    if (protectedFiles.has(fileIdentityKey(module.file))) continue;
    for (const entry of module.exports) {
      if (entry.type !== "local") continue;
      const def = entry.target;
      const identity = `${fileIdentityKey(def.file)}:${def.range.start.index ?? `${def.range.start.line}:${def.range.start.column}`}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      const result = await findReferences(index, { def });
      if (result.status !== "ok" || result.referenceCoverage.state !== "complete") continue;
      const definingFile = fileIdentityKey(def.file);
      const hasOtherReference = result.references.some(
        (ref) =>
          fileIdentityKey(ref.file) !== definingFile ||
          ref.range.start.line !== def.range.start.line ||
          ref.range.start.column !== def.range.start.column ||
          ref.range.end.line !== def.range.end.line ||
          ref.range.end.column !== def.range.end.column,
      );
      if (hasOtherReference) continue;
      candidates.push({
        file: def.file,
        name: def.localName,
        exportedAs: entry.exportedAs,
        kind: def.kind,
        range: def.range,
        reason: "no references found in the indexed project",
      });
    }
  }
  return candidates;
}
