export function isJsTsLanguage(languageId: string): boolean {
  return (
    languageId === "js" ||
    languageId === "ts" ||
    languageId === "tsx" ||
    languageId === "jsx" ||
    languageId === "javascript" ||
    languageId === "typescript"
  );
}
