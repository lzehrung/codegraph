export const CSHARP_QUALIFIED_RECEIVER_TYPES = ["Values.Value", "global::Values.Value", "X::Value"] as const;

export function csharpQualifiedReceiverFixture(type: string) {
  const lines = [
    "using X = Values;",
    "public class Use {",
    "  public void Declared(object Values) {",
    `    ${type} v = new ${type}();`,
    "    v.Run();",
    "  }",
    "  public void Constructed() {",
    `    var w = new ${type}();`,
    "    w.Run();",
    "  }",
    `  public void Parameter(${type} p) {`,
    "    p.Run();",
    "  }",
    "  public void Decoy(Other.Value p) {",
    "    p.Run();",
    "  }",
    "}",
    "",
  ];
  return {
    files: {
      "Value.cs": "namespace Values; public class Value { public void Run() {} }\n",
      "Other.cs": "namespace Other; public class Value { public void Run() {} }\n",
      "Use.cs": lines.join("\n"),
    },
    lines,
    calls: [5, 9, 12],
    decoyCall: 15,
  };
}

export const CSHARP_QUALIFIED_RECEIVER_BOUNDARY_FILES = {
  "Value.cs": "namespace Values; public class Value { public void Run() {} }\n",
  "Shadow.cs": [
    "namespace Client.Values { public class Value { public void Run() {} } }",
    "namespace Client.X { public class Value { public void Run() {} } }",
    "",
  ].join("\n"),
  "Use.cs": [
    "using X = global::Values;",
    "namespace Client;",
    "public class Use {",
    "  public void Relative(Values.Value p) { p.Run(); }",
    "  public void Global(global::Values.Value p) { p.Run(); }",
    "  public void Alias(object X, X::Value p) { p.Run(); }",
    "  public void Hidden(X.Value p) { p.Run(); }",
    "}",
    "",
  ].join("\n"),
};

export const CSHARP_GENERIC_RECEIVER_FILES = {
  "Generic.cs": "namespace N { public class Outer<T> { public class Inner { public void Run() {} } } }\n",
  "Decoy.cs": "namespace N.Outer { public class Inner { public void Run() {} } }\n",
  "Use.cs": [
    "public class Use {",
    "  public void Parameter(N.Outer<int>.Inner p) { p.Run(); }",
    "  public void Constructed() { var p = new N.Outer<int>.Inner(); p.Run(); }",
    "  public void Declared() { N.Outer<int>.Inner p = new N.Outer<int>.Inner(); p.Run(); }",
    "}",
    "",
  ].join("\n"),
};
