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

// dotnet: values hide dotted aliases; :: reaches only namespace aliases. A local function used as
// a receiver is CS0119, not an alias use. The nested type supplies its own Run declaration.
export const CSHARP_ALIAS_BOUNDARIES = [
  { name: "field", declaration: "dynamic B;", parameters: "", body: "B.Nested.Run();" },
  { name: "property", declaration: "dynamic B { get; set; }", parameters: "", body: "B.Nested.Run();" },
  { name: "static field", declaration: "static dynamic B;", parameters: "", body: "B.Nested.Run();" },
  { name: "parameter", declaration: "", parameters: "dynamic B", body: "B.Nested.Run();" },
  { name: "local", declaration: "", parameters: "", body: "{ dynamic B = null; B.Nested.Run(); }" },
  {
    name: "lambda parameter",
    declaration: "",
    parameters: "",
    body: "System.Action<dynamic> action = B => B.Nested.Run();",
  },
  {
    name: "parenthesized lambda parameter",
    declaration: "",
    parameters: "",
    body: "System.Action<dynamic> action = (B) => B.Nested.Run();",
  },
  {
    name: "foreach variable",
    declaration: "",
    parameters: "dynamic[] values",
    body: "foreach (var B in values) { B.Nested.Run(); }",
  },
  {
    name: "pattern variable",
    declaration: "",
    parameters: "object value",
    body: "{ if (value is Values.Value B) { B.Nested.Run(); } }",
  },
  {
    name: "out variable",
    declaration: "static void Take(out dynamic value) { value = null; }",
    parameters: "",
    body: "{ Take(out var B); B.Nested.Run(); }",
  },
  { name: "local function", declaration: "", parameters: "", body: "{ void B() {} B.Nested.Run(); }" },
  {
    name: "nested type",
    declaration: "class B { public class Nested { public static void Run() {} } }",
    parameters: "",
    body: "B.Nested.Run();",
  },
] as const;

export function csharpAliasBoundaryFixture(boundary: (typeof CSHARP_ALIAS_BOUNDARIES)[number], qualified = false) {
  const body = qualified ? boundary.body.replaceAll("B.Nested.Run()", "B::Second.Nested.Run()") : boundary.body;
  const modifier = boundary.name === "static field" ? "static " : "";
  const lines = [
    qualified ? "using B = N;" : "using B = N.Second;",
    "class Use {",
    `  ${boundary.declaration}`,
    `  ${modifier}void Shadowed(${boundary.parameters}) {`,
    `    ${body}`,
    "  }",
    "}",
    "class Outside { void Visible() { B.Nested.Run(); } }",
  ];
  if (qualified) lines[7] = "class Outside { void Visible() { B::Second.Nested.Run(); } }";
  return {
    lines,
    files: {
      "Second.cs": "namespace N; public class Second { public class Nested { public static void Run() {} } }\n",
      "Value.cs": "namespace Values; public class Value { public dynamic Nested; }\n",
      "Decoy.cs": "namespace Decoy; public class Second { public class Nested { public static void Run() {} } }\n",
      "Use.cs": lines.join("\n") + "\n",
    },
    shadowed: 5,
    visible: 8,
  };
}

export const CSHARP_ALIAS_TYPE_FORMS = [
  { name: "annotation", body: "B item = null;", token: "B", aliasUse: true },
  { name: "construction", body: "_ = new B();", token: "B", aliasUse: true },
  { name: "generic argument", body: "System.Collections.Generic.List<B> values = null;", token: "B", aliasUse: true },
  { name: "typeof", body: "_ = typeof(B);", token: "B", aliasUse: true },
  { name: "nameof", body: "_ = nameof(B);", token: "B", aliasUse: false },
  { name: "cast", body: "_ = (B)value;", token: "B", aliasUse: true },
  { name: "is type", body: "_ = value is B;", token: "B", aliasUse: true },
  { name: "catch type", body: "try {} catch (B error) {}", token: "B", aliasUse: true },
] as const;

export function csharpAliasTypeFixture(form: (typeof CSHARP_ALIAS_TYPE_FORMS)[number], shadowed = true) {
  const lines = [
    "using B = N.Second;",
    "class Use {",
    `  void Types(object value${shadowed ? ", dynamic B" : ""}) {`,
    `    ${form.body}`,
    "  }",
    "}",
  ];
  return {
    lines,
    files: {
      "Second.cs": "namespace N; public class Second : System.Exception {}\n",
      "Decoy.cs": "namespace Decoy; public class Second : System.Exception {}\n",
      "Use.cs": lines.join("\n") + "\n",
    },
    use: 4,
  };
}
