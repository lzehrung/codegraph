import { type ModuleSpecifier } from "../util/specifiers.js";
import { dedupeModuleSpecifiers, normalizeLinkSpecifier, normalizeReferenceLabel } from "./shared.js";

// Sphinx `:ref:`/`:term:` roles are deliberately not extracted here: they
// target in-document labels (`.. _label:`) or glossary terms, not files, so
// they aren't file-dependency edges. Only `:doc:` (a document-path role) is
// handled below, alongside this module's other file-targeting patterns.
export function extractRstModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = stripRstCommentsAndLiteralBlocks(source);
  const namedTargets = collectRstTargetDefinitions(cleaned);

  for (const match of cleaned.matchAll(/`[^`<\n]*<([^>\n]+)>`_/g)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  for (const match of cleaned.matchAll(/`([^`\n]+)`_/g)) {
    const label = normalizeReferenceLabel(match[1]);
    if (!label) continue;
    const normalized = namedTargets.get(label);
    if (normalized) out.push(normalized);
  }

  for (const match of cleaned.matchAll(/:doc:`([^`\n]+)`/g)) {
    const body = match[1]?.trim();
    if (!body) continue;
    // Sphinx role syntax: ":doc:`Custom Title <path>`" carries the target inside
    // angle brackets; bare ":doc:`path`" has the target as the whole body.
    const angled = /<([^>\n]+)>\s*$/.exec(body);
    const rawSpecifier = (angled?.[1] ?? body).trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  for (const match of cleaned.matchAll(/^\s*\.\.\s+include::\s+([^\s]+)\s*$/gm)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  for (const match of cleaned.matchAll(/^\s*\.\.\s+literalinclude::\s+([^\s]+)\s*$/gm)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  out.push(...extractRstToctreeSpecifiers(cleaned));

  return dedupeModuleSpecifiers(out);
}

function blankRstLine(line: string): string {
  return line.replace(/[^\r\n]/g, " ");
}

function leadingWhitespaceLength(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function stripRstCommentsAndLiteralBlocks(source: string): string {
  const lines = source.split(/\r?\n/);
  let indentedBlockIndent: number | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    const indent = leadingWhitespaceLength(line);

    if (indentedBlockIndent !== null) {
      if (!trimmed) {
        lines[index] = blankRstLine(line);
        continue;
      }
      if (indent > indentedBlockIndent) {
        lines[index] = blankRstLine(line);
        continue;
      }
      indentedBlockIndent = null;
    }

    const directiveMatch = line.match(/^(\s*)\.\.\s+([A-Za-z][A-Za-z0-9_-]*)::/);
    if (directiveMatch) {
      const directive = directiveMatch[2]?.toLowerCase();
      const directiveIndent = directiveMatch[1]?.length ?? 0;
      if (directive === "comment") {
        lines[index] = blankRstLine(line);
        indentedBlockIndent = directiveIndent;
      } else if (directive === "code" || directive === "code-block" || directive === "sourcecode") {
        indentedBlockIndent = directiveIndent;
      }
      continue;
    }

    if (/^\s*\.\.\s*(?!_[^:]+:)/.test(line)) {
      lines[index] = blankRstLine(line);
      indentedBlockIndent = indent;
      continue;
    }

    if (/::\s*$/.test(line)) {
      indentedBlockIndent = indent;
    }
  }

  return lines.join("\n");
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
    if (/[*?\[\]{}]/.test(rawSpecifier)) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  return out;
}
