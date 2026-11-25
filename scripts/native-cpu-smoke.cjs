const assert = require("node:assert/strict");
const path = require("node:path");

// Run this process under qemu-x86_64 -cpu SandyBridge, not the host Node process.
const binding = require(path.resolve(process.argv[2]));
const cases = [
  ["ts", "export function greet() { return 42; }", "(function_declaration name: (identifier) @name)", "program"],
  ["python", "def greet():\n    return 42\n", "(function_definition name: (identifier) @name)", "module"],
  [
    "go",
    "package main\nfunc greet() int { return 42 }",
    "(function_declaration name: (identifier) @name)",
    "source_file",
  ],
  ["terraform", "locals {\n greet = <<-EOT\nhello\nEOT\n}\n", "(attribute . (identifier) @name)", "config_file"],
];
for (const [language, source, query, rootKind] of cases) {
  const tree = binding.parseSyntaxTree(source, language);
  assert.ok(tree.nodeCount > 1, `${language}: expected a parsed syntax tree`);
  assert.equal(tree.kinds[tree.kindIds[tree.rootId]], rootKind);
  assert.ok(!tree.kinds.includes("ERROR"), `${language}: unexpected parse error`);
  const names = binding
    .runQuery(source, language, query)
    .matches.flatMap((match) => match.captures.map((capture) => capture.text));
  assert.deepEqual(names, ["greet"]);
}
console.log("SandyBridge parse/query OK: TypeScript, Python, Go, HCL heredoc.");
