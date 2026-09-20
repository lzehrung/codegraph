import { describe, expect, it } from "vitest";
import {
  maskJsLikeCommentsAndStrings,
  maskPythonCommentsAndStrings,
  stripJsLikeComments,
  stripPythonCommentsAndStrings,
} from "../src/util/comments.js";
import { maskImportBindingTrivia } from "../src/indexer/imports/binding-ranges.js";
import { maskTrivia } from "../src/util/trivia.js";

/** Asserts the masked output keeps every UTF-16 offset (equal length, astral-safe). */
function expectOffsetsPreserved(source: string, masked: string): void {
  expect(masked.length).toBe(source.length);
}

/** Asserts the literal body is blanked and the following statement survives at its exact offset. */
function expectMaskedWithFollowingCode(source: string, masked: string, literalBody: string, following: string): void {
  expectOffsetsPreserved(source, masked);
  const bodyIndex = source.indexOf(literalBody);
  expect(bodyIndex).toBeGreaterThanOrEqual(0);
  for (let i = bodyIndex; i < bodyIndex + literalBody.length; i += 1) {
    if (source[i] === "\n" || source[i] === "\r") continue;
    expect(masked[i], `index ${i} (source ${JSON.stringify(source[i])})`).toBe(" ");
  }
  const followingIndex = source.indexOf(following);
  expect(followingIndex).toBeGreaterThanOrEqual(0);
  expect(masked.slice(followingIndex, followingIndex + following.length)).toBe(following);
}

describe("trivia masking keeps following code visible per language", () => {
  // Every string form must keep its delimiters visible and blank only the body: consumers run
  // regexes like `from\s*(["'])([^"']+)\1` over masked text and need the quote characters.
  const DELIMITER_CASES: Array<{ language: string; source: string; opener: string; closer: string; body: string }> = [
    { language: "js", source: 'const a = "Qx9body";', opener: '"', closer: '"', body: "Qx9body" },
    { language: "python", source: 'x = """Qx9body"""', opener: '"""', closer: '"""', body: "Qx9body" },
    { language: "python", source: "x = f'Qx9body {y}'", opener: "f'", closer: "'", body: "Qx9body" },
    { language: "csharp", source: 'var s = @"Qx9body";', opener: '@"', closer: '"', body: "Qx9body" },
    { language: "csharp", source: 'var s = """\nQx9body\n""";', opener: '"""', closer: '"""', body: "Qx9body" },
    { language: "go", source: "const s = `Qx9body`", opener: "`", closer: "`", body: "Qx9body" },
    { language: "rust", source: 'let s = r#"Qx9body"#;', opener: 'r#"', closer: '"#', body: "Qx9body" },
    { language: "php", source: "$s = <<<EOT\nQx9body\nEOT;", opener: "<<<EOT", closer: "EOT", body: "Qx9body" },
    { language: "ruby", source: "t = <<-EOS\nQx9body\nEOS", opener: "<<-EOS", closer: "EOS", body: "Qx9body" },
    { language: "ruby", source: "a = %w{Qx9body}", opener: "%w{", closer: "}", body: "Qx9body" },
    { language: "swift", source: 'let s = #"Qx9body"#', opener: '#"', closer: '"#', body: "Qx9body" },
    { language: "swift", source: 'let s = """\nQx9body\n"""', opener: '"""', closer: '"""', body: "Qx9body" },
    { language: "kotlin", source: 'val s = """Qx9body"""', opener: '"""', closer: '"""', body: "Qx9body" },
    { language: "zig", source: "const s =\n    \\\\Qx9body", opener: "\\\\", closer: "", body: "Qx9body" },
  ];

  it.each(DELIMITER_CASES)("keeps $language delimiters visible and blanks only the body", (testCase) => {
    const masked = maskTrivia(testCase.source, testCase.language);
    expect(masked.length).toBe(testCase.source.length);
    const openerIndex = masked.indexOf(testCase.opener);
    expect(openerIndex, `opener ${testCase.opener}`).toBeGreaterThanOrEqual(0);
    if (testCase.closer) {
      const closerIndex = masked.indexOf(testCase.closer, openerIndex + testCase.opener.length);
      expect(closerIndex, `closer ${testCase.closer}`).toBeGreaterThanOrEqual(0);
    }
    expect(masked).not.toContain(testCase.body);
  });

  it("does not let a Go raw string ending in a backslash blank the rest of the file", () => {
    const source = 'const s = `C:\\`\nimport "fmt"\nvar x = 1\n';
    const masked = maskImportBindingTrivia(source, "go");
    expectMaskedWithFollowingCode(source, masked, "C:\\", "var x = 1");
    expect(masked).toContain("import ");
  });

  it("does not let a C# verbatim string ending in a backslash blank the rest of the file", () => {
    const source = 'var s = @"C:\\";\nusing A = B.C;\n';
    const masked = maskTrivia(source, "csharp");
    expectMaskedWithFollowingCode(source, masked, "C:\\", "using A = B.C;");
    // The verbatim delimiters stay visible and the body is blanked: the backslash is data.
    expect(masked.slice(8, 14)).toBe('@"   "');
    expect(masked[14]).toBe(";");
  });

  it("does not let an apostrophe in a Python comment open a string literal", () => {
    const source = "# don't\nimport os\nx = 'value'\n";
    const masked = maskPythonCommentsAndStrings(source);
    expectMaskedWithFollowingCode(source, masked, "don't", "import os");
    expect(masked).toContain("import os");
    // The real string literal on a later line is still located and masked on its own.
    expectMaskedWithFollowingCode(source, masked, "value", "import os");
  });

  it("masks a PHP heredoc body containing import-shaped text", () => {
    const source = "$s = <<<EOT\nimport x from \"y\";\nEOT;\nrequire_once 'a.php';\n";
    const masked = maskImportBindingTrivia(source, "php");
    expectOffsetsPreserved(source, masked);
    expect(masked).not.toContain("import x from");
    // The heredoc body including its terminator is masked; the statement separator survives.
    expect(masked).toContain("require_once ");
    expect(masked).toContain(";");
  });

  it("masks Ruby heredoc bodies and keeps the following require visible", () => {
    const source = "text = <<-EOS\nsay \"hi\" or 'bye'\nEOS\nrequire 'x'\n";
    const masked = maskImportBindingTrivia(source, "ruby");
    expectOffsetsPreserved(source, masked);
    expect(masked).not.toContain("say ");
    expect(masked).toContain("require ");
    // A squiggly heredoc with an indented terminator also closes.
    const squiggly = "text = <<~EOS\n  body \"q\"\n  EOS\nrequire 'x'\n";
    const squigglyMasked = maskImportBindingTrivia(squiggly, "ruby");
    expect(squigglyMasked).not.toContain("body ");
    expect(squigglyMasked).toContain("require ");
  });

  it("masks a Swift multiline string whose body contains an inner triple quote", () => {
    const source = 'let s = """\n  body \\""" more\n"""\nlet t = 2\n';
    const masked = maskImportBindingTrivia(source, "swift");
    expectMaskedWithFollowingCode(source, masked, "body", "let t = 2");
  });

  it("keeps scanning a Swift multiline string past an unescaped triple quote that is not alone on its line", () => {
    const source = 'let s = """\n  body """ inside\n"""\nlet t = 2\n';
    const masked = maskTrivia(source, "swift");
    expectMaskedWithFollowingCode(source, masked, "body", "let t = 2");
  });

  it("does not let a Kotlin interpolation with a nested literal close the outer string", () => {
    const source = 'val s = "outer ${if (x) "inner" else "y"} tail"\nimport a.b\n';
    const masked = maskImportBindingTrivia(source, "kotlin");
    expectOffsetsPreserved(source, masked);
    expect(masked).not.toContain("outer ");
    expect(masked).toContain("import a.b");
  });

  it("does not let a Swift interpolation with a nested literal close the outer string", () => {
    const source = 'let s = "a \\(cond ? "x" : "y") b"\nlet t = 3\n';
    const masked = maskTrivia(source, "swift");
    expectOffsetsPreserved(source, masked);
    expect(masked).not.toContain("a \\");
    expect(masked).toContain("let t = 3");
  });

  it("masks Zig multiline string lines and keeps following declarations visible", () => {
    const source = "const s =\n    \\\\line one\n    \\\\line two\n;\nconst t = 1;\n";
    const masked = maskTrivia(source, "zig");
    expectOffsetsPreserved(source, masked);
    expect(masked).not.toContain("line one");
    expect(masked).toContain("const t = 1;");
  });

  it("masks Rust raw strings and leaves lifetimes and chars alone", () => {
    const source = 'let s = r#"a "b" c"#;\nlet r: &\'a str = x;\nlet c = \'y\';\n';
    const masked = maskImportBindingTrivia(source, "rust");
    expectOffsetsPreserved(source, masked);
    expect(masked).not.toContain('a "b"');
    expect(masked).toContain("&'a str");
    expect(masked).toContain("let c = ");
  });

  it("masks Ruby percent literals and =begin blocks without eating neighbors", () => {
    const percent = "a = %w(one two) ; b = 2\n";
    expect(maskTrivia(percent, "ruby")).toContain("; b = 2");
    const block = '=begin\nhidden "code"\n=end\nvisible = 1\n';
    const blockMasked = maskTrivia(block, "ruby");
    expect(blockMasked).not.toContain("hidden");
    expect(blockMasked).toContain("visible = 1");
  });

  it("masks CSS-family block comments and quoted strings but not url(//...) text", () => {
    const source = 'a { background: url(//x/y); } /* c */ d { content: "s"; }\n';
    const masked = maskTrivia(source, "scss");
    expectOffsetsPreserved(source, masked);
    expect(masked).toContain("url(//x/y)");
    expect(masked).not.toContain(" c ");
    expect(masked).toContain(" d { content: ");
  });

  it("preserves offsets across an astral character inside masked trivia", () => {
    const source = "# \u{1F389} don't\nimport os\n";
    const masked = maskPythonCommentsAndStrings(source);
    expectOffsetsPreserved(source, masked);
    expect(source.indexOf("import os")).toBe(masked.indexOf("import os"));
  });

  it("still masks an ordinary Go escaped string while keeping later code visible", () => {
    const source = 's := "a\\"b"\nimport "fmt"\nvar ok = true\n';
    const masked = maskTrivia(source, "go");
    expectOffsetsPreserved(source, masked);
    expect(masked).not.toContain('a\\"');
    expect(masked).toContain("var ok = true");
  });
});

describe("existing entry points keep their contracts", () => {
  it("stripJsLikeComments keeps string content visible, including // inside strings", () => {
    const source = 'const u = "//cdn.example.com/lib.js";\n// real comment\n';
    const stripped = stripJsLikeComments(source);
    expectOffsetsPreserved(source, stripped);
    expect(stripped).toContain('"//cdn.example.com/lib.js"');
    expect(stripped).not.toContain("real comment");
  });

  it("maskJsLikeCommentsAndStrings masks comments and strings at preserved offsets", () => {
    const source = "const a = `t ${x} y`; // c\nkeep();\n";
    const masked = maskJsLikeCommentsAndStrings(source);
    expectOffsetsPreserved(source, masked);
    expect(masked).not.toContain("t ${x}");
    expect(masked).toContain("keep();");
  });

  it("stripPythonCommentsAndStrings deletes comments and strings", () => {
    const source = "# don't\nimport os\nx = 'value'\n";
    const stripped = stripPythonCommentsAndStrings(source);
    expect(stripped).toBe("\nimport os\nx = \n");
  });
});
