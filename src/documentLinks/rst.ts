import { type ModuleSpecifier } from "../util/specifiers.js";
import { dedupeModuleSpecifiers, normalizeLinkSpecifier, normalizeReferenceLabel } from "./shared.js";

export function extractRstModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const namedTargets = collectRstTargetDefinitions(source);

  for (const match of source.matchAll(/`[^`<\n]*<([^>\n]+)>`_/g)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  for (const match of source.matchAll(/`([^`\n]+)`_/g)) {
    const label = normalizeReferenceLabel(match[1]);
    if (!label) continue;
    const normalized = namedTargets.get(label);
    if (normalized) out.push(normalized);
  }

  for (const match of source.matchAll(/^\s*\.\.\s+include::\s+([^\s]+)\s*$/gm)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  out.push(...extractRstToctreeSpecifiers(source));

  return dedupeModuleSpecifiers(out);
}

function collectRstTargetDefinitions(source: string): Map<string, ModuleSpecifier> {
  const out = new Map<string, ModuleSpecifier>();
  const definitionRe = /^\s*\.\.\s+_([^:]+):\s*(\S+)\s*$/gm;

  for (const match of source.matchAll(definitionRe)) {
    const label = normalizeReferenceLabel(match[1]);
    const rawSpecifier = match[2];
    if (!label || !rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.set(label, normalized);
  }

  return out;
}

function extractRstToctreeSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const lines = source.split(/\r?\n/);
  let inToctree = false;

  for (const line of lines) {
    if (/^\s*\.\.\s+toctree::\s*$/.test(line)) {
      inToctree = true;
      continue;
    }

    if (!inToctree) continue;

    if (!line.trim()) {
      continue;
    }

    const indentMatch = line.match(/^(\s+)(.+)$/);
    if (!indentMatch) {
      inToctree = false;
      continue;
    }

    const content = indentMatch[2]?.trim();
    if (!content || content.startsWith(":")) {
      continue;
    }

    const titledMatch = content.match(/<([^>]+)>/);
    const rawSpecifier = titledMatch?.[1]?.trim() ?? content;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  return out;
}
