export function isRustCfgTestStatement(source: string, statementText: string): boolean {
  const normalizedStatement = statementText.trim();
  if (!normalizedStatement) return false;

  const moduleMatch = /^mod\s+([A-Za-z_][\w]*)\b/.exec(normalizedStatement);
  const moduleName = moduleMatch?.[1];
  if (moduleName) {
    const modulePattern = new RegExp(`#\\s*\\[cfg\\s*\\(\\s*test\\s*\\)\\]\\s*mod\\s+${moduleName}\\s*(?:;|\\{)`);
    if (modulePattern.test(source)) return true;
  }

  const statementIndex = source.indexOf(normalizedStatement);
  if (statementIndex === -1) return false;
  return isInsideRustCfgTestModule(source, statementIndex);
}

function isInsideRustCfgTestModule(source: string, statementIndex: number): boolean {
  const testModulePattern = /#\s*\[cfg\s*\(\s*test\s*\)\]\s*mod\s+[A-Za-z_][\w]*\s*\{/g;
  for (const match of source.matchAll(testModulePattern)) {
    const moduleStart = match.index;
    const openBraceIndex = source.indexOf("{", moduleStart);
    if (openBraceIndex === -1 || statementIndex <= openBraceIndex) continue;
    const closeBraceIndex = findClosingBrace(source, openBraceIndex);
    if (closeBraceIndex === undefined) continue;
    if (statementIndex < closeBraceIndex) return true;
  }
  return false;
}

function findClosingBrace(source: string, openBraceIndex: number): number | undefined {
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character !== "}") continue;
    depth -= 1;
    if (!depth) return index;
  }
  return undefined;
}
