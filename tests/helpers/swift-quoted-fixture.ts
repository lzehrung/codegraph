export const SWIFT_QUOTED_LINES: Record<string, string[]> = {
  "Api.swift": [
    "func `top`() {}",
    "func regular() {}",
    "class `Widget` {",
    "  func `helper`() {}",
    "  func invokeQuoted() { self.helper(); helper(); self.`helper`() }",
    "}",
    "class Plain {",
    "  func helper() {}",
    "  func invokePlain() { self.`helper`() }",
    "}",
    "class Keyword {",
    "  func `class`() {}",
    "  func invokeKeyword() { self.`class`() }",
    "}",
    "func `default`() {}",
    "func invokeDefault() { `default`() }",
    "class Solo {",
    "  func plainOnly() {}",
    "  func invokeSolo() { self.`plainOnly`() }",
    "}",
    "",
  ],
  "Use.swift": [
    "import class Api.Widget",
    "import func Api.top",
    "func useFunctions() {",
    "  top()",
    "  `top`()",
    "  regular()",
    "  `regular`()",
    "}",
    "func useTypes() {",
    "  let w: Widget = Widget()",
    "  w.helper()",
    "  w.`helper`()",
    "  let q: `Widget` = `Widget`()",
    "  q.helper()",
    "  let p = Plain()",
    "  p.`helper`()",
    "}",
    "func useSolo() { let s = Solo(); s.`plainOnly`() }",
    "",
  ],
  "Imports.swift": [
    "import class Api.`Widget`",
    "import func Api.`top`",
    "func imported() { top(); let w = `Widget`(); w.helper() }",
    "",
  ],
  "Extension.swift": [
    "extension Widget {",
    "  func extensionUse() { self.`helper`() }",
    "}",
    "extension `Plain` {",
    "  func extensionPlain() { self.helper() }",
    "}",
    "",
  ],
  "Other.swift": [
    "class Other {",
    "  func `helper`() {}",
    "  func `class`() {}",
    "  func invokeOther() { self.helper(); self.`class`(); self.`default`() }",
    "  func `default`() {}",
    "  func plainOnly() {}",
    "}",
    "func Top() {}",
    "",
  ],
};

export const SWIFT_QUOTED_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(SWIFT_QUOTED_LINES).map(([name, lines]) => [name, lines.join("\n")]),
);

/** 1-based source position, including the backticks when the token is quoted. */
export function swiftQuotedSite(
  paths: Readonly<Record<string, string>>,
  name: string,
  line: number,
  token: string,
  occurrence = 0,
): { file: string; line: number; column: number } {
  const text = SWIFT_QUOTED_LINES[name]?.[line - 1];
  if (text === undefined || !paths[name]) throw new Error(`Missing Swift fixture site ${name}:${line}`);
  let start = 0;
  for (let index = 0; index <= occurrence; index += 1) {
    const at = text.indexOf(token, start);
    if (at < 0) throw new Error(`Missing Swift fixture token ${token} at ${name}:${line}`);
    if (index === occurrence) return { file: paths[name], line, column: at + 1 };
    start = at + token.length;
  }
  throw new Error(`Missing Swift fixture occurrence ${token} at ${name}:${line}`);
}
