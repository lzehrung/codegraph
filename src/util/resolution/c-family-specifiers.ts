import path from "node:path";
import { isFilePathWithinRoot, normalizeResolutionHints } from "../paths.js";
import { isCppNamedModuleSpecifier, resolveCppImportPath } from "./cpp.js";
import type {
  ImportSpecifierDeps,
  ImportSpecifierOptions,
  ResolvedSpecifier,
  SpecifierTargetPolicy,
} from "./language-policy-types.js";

function isQuotedInclude(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"');
}

async function resolveExactIncludeFromHints(
  projectRoot: string,
  innerPath: string,
  resolutionHints: string[] | undefined,
  deps: ImportSpecifierDeps,
): Promise<string | null> {
  const inner = innerPath.trim();
  if (!inner) return null;
  for (const hint of normalizeResolutionHints(resolutionHints)) {
    const baseDir = path.isAbsolute(hint) ? hint : path.resolve(projectRoot, hint);
    if (!isFilePathWithinRoot(projectRoot, baseDir)) continue;
    const base = path.resolve(baseDir, inner);
    if (!isFilePathWithinRoot(projectRoot, base)) continue;
    const hit = await deps.acceptFirstPartyFile(projectRoot, base);
    if (hit) return hit;
  }
  return null;
}

/** Literal includes never reach extension, index, package, or path-alias guessing. */
async function resolveInclude(
  projectRoot: string,
  fromFile: string,
  spec: string,
  options: ImportSpecifierOptions,
  deps: ImportSpecifierDeps,
): Promise<ResolvedSpecifier | undefined> {
  const form = options.includeForm;
  const angle = form === "angle" || (form === undefined && spec.startsWith("<") && spec.endsWith(">"));
  if (angle) {
    const inner = spec.startsWith("<") && spec.endsWith(">") ? spec.slice(1, -1).trim() : spec.trim();
    return (
      (await resolveExactIncludeFromHints(projectRoot, inner, options.resolutionHints, deps)) ?? { external: spec }
    );
  }
  const quoted = form === "literal" || (form === undefined && isQuotedInclude(spec));
  if (quoted) {
    const inner = isQuotedInclude(spec) ? spec.trim().slice(1, -1) : spec;
    const sibling = await deps.acceptFirstPartyFile(projectRoot, path.resolve(path.dirname(fromFile), inner));
    if (sibling) return sibling;
    const hint = await resolveExactIncludeFromHints(projectRoot, inner, options.resolutionHints, deps);
    return hint ?? { external: spec };
  }
  if (form === "macro") return { external: spec };
  return undefined;
}

export const C_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  resolveImport: resolveInclude,
  resolve: (file, specifier, metadata, deps, policy) =>
    deps.resolveLanguageImportTargets(file, specifier, "c", metadata, policy),
};

export const CPP_SPECIFIER_POLICY: SpecifierTargetPolicy = {
  async resolveImport(projectRoot, fromFile, spec, options, deps) {
    const include = await resolveInclude(projectRoot, fromFile, spec, options, deps);
    if (include !== undefined) return include;
    const hit = await deps.confineLanguageHit(projectRoot, await resolveCppImportPath(projectRoot, spec), spec);
    if (hit) return hit;
    if (isCppNamedModuleSpecifier(spec)) return { external: spec };
    return undefined;
  },
  resolve: (file, specifier, metadata, deps, policy) =>
    deps.resolveLanguageImportTargets(file, specifier, "cpp", metadata, policy),
};
