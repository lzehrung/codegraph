export const CSHARP_ALIAS_ONLY_LINES = [
  "using B = N.Second;",
  "class Use {",
  "  void Visible() { B.Nested.Run(); }",
  "  void Parameter(dynamic B) { B.Nested.Run(); }",
  "  void Unused(dynamic B) {}",
  "  void Local() { dynamic B = null; B.Nested.Run(); }",
  "  void Typed(B B) { B.Act(); }",
  "}",
] as const;

export const CSHARP_ALIAS_ONLY_FILES = {
  "Second.cs":
    "namespace N; public class Second { public class Nested { public static void Run() {} } public void Act() {} }\n",
  "Use.cs": CSHARP_ALIAS_ONLY_LINES.join("\n") + "\n",
} as const;

// All four compile to two calls on Values.Value; verbatim spelling changes no binding identity.
export const CSHARP_ALIAS_VALUE_SPELLINGS = [
  { name: "verbatim local", alias: "B", parameters: "", local: "var @B = new Value();", first: "@B", second: "B" },
  {
    name: "verbatim alias and local",
    alias: "@B",
    parameters: "",
    local: "var B = new Value();",
    first: "B",
    second: "@B",
  },
  {
    name: "verbatim alias and parameter",
    alias: "@B",
    parameters: "Value B",
    local: "",
    first: "@B",
    second: "B",
  },
  { name: "verbatim parameter", alias: "B", parameters: "Value @B", local: "", first: "B", second: "@B" },
] as const;

export function csharpAliasValueFixture(spelling: (typeof CSHARP_ALIAS_VALUE_SPELLINGS)[number]) {
  const lines = [
    `using ${spelling.alias} = N.Second; using Values;`,
    "class Use {",
    `  void M(${spelling.parameters}) {`,
    `    ${spelling.local}`,
    `    ${spelling.first}.Run();`,
    `    ${spelling.second}.Run();`,
    "  }",
    "}",
  ];
  return {
    lines,
    files: {
      "Second.cs": "namespace N; public class Second { public static void Run() {} }\n",
      "Value.cs": "namespace Values; public class Value { public void Run() {} }\n",
      "Use.cs": lines.join("\n") + "\n",
    },
  };
}
