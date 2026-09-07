import path from "node:path";
import { type ModuleSpecifier } from "../util/specifiers.js";
import { extractHtmlAttributeSpecifiers } from "./html.js";
import { dedupeModuleSpecifiers, normalizeLinkSpecifier } from "./shared.js";

function blankAsciidocLine(line: string): string {
  return line.replace(/[^\r\n]/g, " ");
}

function stripAsciidocCommentsAndLiteralBlocks(source: string): string {
  const lines = source.split(/\r?\n/);
  let blockDelimiter: "----" | "...." | "////" | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();

    if (blockDelimiter) {
      lines[index] = blankAsciidocLine(line);
      if (trimmed === blockDelimiter) blockDelimiter = null;
      continue;
    }

    if (trimmed === "----" || trimmed === "...." || trimmed === "////") {
      blockDelimiter = trimmed;
      lines[index] = blankAsciidocLine(line);
      continue;
    }

    if (/^\s*\/\//.test(line)) {
      lines[index] = blankAsciidocLine(line);
    }
  }

  return lines.join("\n");
}

export function extractAsciidocModuleSpecifiers(source: string): ModuleSpecifier[] {
  const out: ModuleSpecifier[] = [];
  const cleaned = stripAsciidocCommentsAndLiteralBlocks(source);

  for (const match of cleaned.matchAll(/\b(xref|link):([^\[\s]+)\[[^\]]*]/g)) {
    const directive = (match[1] ?? "").toLowerCase();
    const rawSpecifier = match[2]?.trim();
    if (!rawSpecifier) continue;
    const fileLikeTarget =
      directive === "xref" ? isLikelyAsciidocXrefTarget(rawSpecifier) : isLikelyAsciidocFileTarget(rawSpecifier);
    if (!fileLikeTarget) continue;
    const ambiguousXrefTarget = directive === "xref" && isAmbiguousAsciidocXrefTarget(rawSpecifier);
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) {
      out.push(ambiguousXrefTarget ? { ...normalized, dropIfUnresolved: true } : normalized);
    }
  }

  for (const match of cleaned.matchAll(/^\s*include::([^\[\n]+)\[[^\]]*]/gm)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  for (const match of cleaned.matchAll(/<<([^>,]+)(?:,[^>]*)?>>/g)) {
    const rawSpecifier = match[1]?.trim();
    if (!rawSpecifier) continue;
    if (!isLikelyAsciidocFileTarget(rawSpecifier)) continue;
    const normalized = normalizeLinkSpecifier(rawSpecifier, {
      preferRelative: true,
      resolutionKind: "document",
      forceRelative: true,
    });
    if (normalized) out.push(normalized);
  }

  out.push(
    ...extractHtmlAttributeSpecifiers(cleaned, {
      a: ["href"],
    }),
  );

  return dedupeModuleSpecifiers(out);
}

function isLikelyAsciidocXrefTarget(rawSpecifier: string): boolean {
  if (isLikelyAsciidocFileTarget(rawSpecifier)) return true;

  const withoutFragment = rawSpecifier.trim().split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
  if (!withoutFragment) return false;
  return /^[A-Za-z0-9._-]+$/.test(withoutFragment);
}

function isAmbiguousAsciidocXrefTarget(rawSpecifier: string): boolean {
  return isLikelyAsciidocXrefTarget(rawSpecifier) && !isLikelyAsciidocFileTarget(rawSpecifier);
}

function isLikelyAsciidocFileTarget(rawSpecifier: string): boolean {
  const trimmed = rawSpecifier.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return true;
  if (trimmed.startsWith("//")) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;

  const withoutFragment = trimmed.split("#", 1)[0]?.split("?", 1)[0]?.trim() ?? "";
  if (!withoutFragment) return false;
  if (withoutFragment.startsWith("./") || withoutFragment.startsWith("../") || withoutFragment.startsWith("/")) {
    return true;
  }
  if (withoutFragment.includes("/") || withoutFragment.includes("\\")) {
    return true;
  }
  return !!path.extname(withoutFragment).length;
}
