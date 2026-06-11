import { supportForFile } from "../languages.js";

function driftLanguageId(id: string): string {
  if (id === "ts") return "typescript";
  return id;
}

export function countFilesByLanguage(files: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const support = supportForFile(file);
    if (!support) continue;
    const languageId = driftLanguageId(support.id);
    counts[languageId] = (counts[languageId] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
