export const CSHARP_ALIAS_SHADOW_LINES = [
  "using B = N.Plain;",
  "class OuterUse { void Outer() { B.Nested.Run(); } }",
  "namespace C {",
  "  using B = N.Second;",
  "  class Use {",
  "    void Visible() { B.Nested.Run(); }",
  "    void Parameter(dynamic B) { B.Nested.Run(); }",
  "    void Unused(dynamic B) {}",
  "    void Local() {",
  "      { dynamic B = null; B.Nested.Run(); }",
  "      B.Nested.Run();",
  "    }",
  "    void Typed(N.Second B) { B.Act(); }",
  "  }",
  "}",
  "namespace Other { class OtherUse { void Outside() { B.Nested.Run(); } } }",
] as const;

export const CSHARP_ALIAS_SHADOW_FILES = {
  "Plain.cs": "namespace N; public class Plain { public class Nested { public static void Run() {} } }\n",
  "Second.cs":
    "namespace N; public class Second { public class Nested { public static void Run() {} } public void Act() {} }\n",
  "Use.cs": CSHARP_ALIAS_SHADOW_LINES.join("\n") + "\n",
} as const;

export const CSHARP_ALIAS_SHADOW_SITES = {
  outer: 2,
  visible: 6,
  parameter: 7,
  unused: 8,
  local: 10,
  restored: 11,
  typed: 13,
  outside: 16,
} as const;
