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
