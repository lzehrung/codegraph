import { stripHashInlineComment } from "../comments.js";
import { isPlainRecord } from "../guards.js";

export function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseJsonName(raw: string): string | null {
  try {
    const data: unknown = JSON.parse(raw);
    if (!isPlainRecord(data)) return null;
    const name = data.name;
    if (typeof name !== "string") return null;
    return trimToNull(name);
  } catch {
    return null;
  }
}

export function parseTomlName(raw: string, sections: string[]): string | null {
  const lines = raw.split(/\r?\n/);
  let currentSection = "";
  for (const rawLine of lines) {
    const line = stripHashInlineComment(rawLine, "preserve").trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentSection = (sectionMatch[1] ?? "").trim();
      continue;
    }
    if (!sections.includes(currentSection)) continue;
    const nameMatch = line.match(/^name\s*=\s*("([^"]*)"|'([^']*)')/);
    if (!nameMatch) continue;
    return trimToNull(nameMatch[2] ?? nameMatch[3] ?? "");
  }
  return null;
}

export function parseIniName(raw: string, section: string, key: string): string | null {
  const lines = raw.split(/\r?\n/);
  let currentSection = "";
  const targetSection = section.toLowerCase();
  const targetKey = key.toLowerCase();
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      currentSection = (sectionMatch[1] ?? "").trim().toLowerCase();
      continue;
    }
    if (currentSection !== targetSection) continue;
    const keyMatch = trimmed.match(/^([^=]+)=(.+)$/);
    if (!keyMatch) continue;
    const foundKey = (keyMatch[1] ?? "").trim().toLowerCase();
    if (foundKey !== targetKey) continue;
    const value = (keyMatch[2] ?? "").trim();
    return trimToNull(value.replace(/^['"]|['"]$/g, ""));
  }
  return null;
}

export function parseSetupPyName(raw: string): string | null {
  return parseAssignedStringName(raw);
}

export function parsePomName(raw: string): string | null {
  const withoutParent = raw.replace(/<parent>[\s\S]*?<\/parent>/gi, "");
  const nameMatch = withoutParent.match(/<name>\s*([^<]+)\s*<\/name>/i);
  if (nameMatch) return trimToNull(nameMatch[1]);
  const artifactMatch = withoutParent.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/i);
  if (artifactMatch) return trimToNull(artifactMatch[1]);
  return null;
}

export function parseGradleName(raw: string): string | null {
  const match = raw.match(/\brootProject\.name\s*=\s*["']([^"']+)["']/);
  return trimToNull(match?.[1]);
}

export function parseGradlePropertiesName(raw: string): string | null {
  const match = raw.match(/^\s*rootProject\.name\s*=\s*["']([^"']+)["']/m);
  return trimToNull(match?.[1]);
}

export function parseDotnetName(raw: string): string | null {
  const tags = ["AssemblyName", "PackageId", "RootNamespace"];
  for (const tag of tags) {
    const match = raw.match(new RegExp(`<${tag}>\\s*([^<]+)\\s*</${tag}>`, "i"));
    if (match) return trimToNull(match[1]);
  }
  return null;
}

export function parseGoModuleName(raw: string): string | null {
  const lines = raw.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = stripHashInlineComment(rawLine, "trim");
    if (!line) continue;
    const match = line.match(/^module\s+(.+)$/);
    if (match) return trimToNull(match[1]);
  }
  return null;
}

export function parseGemspecName(raw: string): string | null {
  return parseAssignedStringName(raw);
}

function parseAssignedStringName(raw: string): string | null {
  const match = raw.match(/\bname\s*=\s*["']([^"']+)["']/);
  return trimToNull(match?.[1]);
}

export function parseSwiftPackageName(raw: string): string | null {
  const match = raw.match(/\bname\s*:\s*["']([^"']+)["']/);
  return trimToNull(match?.[1]);
}
