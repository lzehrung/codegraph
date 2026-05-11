const reservedWords: Record<string, Set<string>> = {
  csharp: new Set(["class", "namespace", "return", "using", "void"]),
  go: new Set(["break", "func", "package", "return", "type", "var"]),
  java: new Set(["class", "interface", "package", "return", "void"]),
  js: new Set(["class", "const", "default", "export", "function", "import", "let", "return", "var"]),
  jsx: new Set(["class", "const", "default", "export", "function", "import", "let", "return", "var"]),
  python: new Set(["class", "def", "from", "import", "lambda", "return"]),
  rust: new Set(["fn", "let", "mod", "pub", "return", "struct", "trait", "use"]),
  ts: new Set(["class", "const", "default", "export", "function", "import", "interface", "let", "return", "type", "var"]),
  tsx: new Set(["class", "const", "default", "export", "function", "import", "interface", "let", "return", "type", "var"]),
};

export function isValidIdentifier(languageId: string, name: string): { ok: true } | { ok: false; reason: string } {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return { ok: false, reason: `"${name}" is not a valid ASCII identifier` };
  }
  if (reservedWords[languageId]?.has(name)) {
    return { ok: false, reason: `"${name}" is a reserved word` };
  }
  return { ok: true };
}
