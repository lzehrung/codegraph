import type { LanguageDefinition } from "./types.js";

const registry = new Map<string, LanguageDefinition>();

export function registerLanguage(def: LanguageDefinition) {
  registry.set(def.id, def);
}

export function getAllLanguages(): LanguageDefinition[] {
  return Array.from(registry.values());
}

export function getLanguageById(id: string): LanguageDefinition | undefined {
  return registry.get(id);
}
