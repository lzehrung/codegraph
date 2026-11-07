export const CSHARP_SCOPE_READ_LINES = [
  "using B = N.Second;",
  "class Use {",
  "  const int K = 3;",
  "  const int Match = 7;",
  "  void Catch() {",
  "    try { throw new System.Exception(); }",
  "    catch (System.Exception B) when (B != null) { System.Console.WriteLine(B); }",
  "    B.Ping();",
  "  }",
  "  void For() {",
  "    for (int B = 0; B < 2; B++) { System.Console.WriteLine(B); }",
  "    B.Ping();",
  "  }",
  "  void Lambda() { var f = (int x = K) => x + K; _ = f(); }",
  "  bool Pattern(int value) => value is Match;",
  "  void Deconstruct((dynamic, int)[] rows) {",
  "    foreach (var (B, other) in rows) { B.Nested.Run(); }",
  "    B.Nested.Run();",
  "  }",
  "  void Collection() {",
  "    foreach (var (B, other) in B.Rows) { B.Nested.Run(); }",
  "    B.Nested.Run();",
  "  }",
  "  void Explicit((dynamic, int)[] rows) {",
  "    foreach ((dynamic B, int other) in rows) { B.Nested.Run(); }",
  "    B.Nested.Run();",
  "  }",
  "  bool Declaration(object value, dynamic B) => value is B item;",
  "}",
] as const;

export const CSHARP_SCOPE_READ_FILES = {
  "Second.cs":
    "namespace N; public class Second { public static void Ping() {} " +
    "public static (dynamic, int)[] Rows; public class Nested { public static void Run() {} } }\n",
  "Decoy.cs":
    "namespace Decoy; public class Second { public static void Ping() {} " +
    "public class Nested { public static void Run() {} } } " +
    "class Constants { const int K = 9; const int Match = 8; }\n",
  "Use.cs": CSHARP_SCOPE_READ_LINES.join("\n") + "\n",
} as const;

export const KOTLIN_TYPE_VALUE_LINES = [
  "package client",
  "import lib.Widget",
  "fun use(Widget: Int, item: Widget): Int {",
  "  val copy: Widget = item",
  "  val list: List<Widget> = listOf(copy)",
  "  return Widget",
  "}",
  "fun local(item: Widget): Int {",
  "  val Widget = 2",
  "  val copy: Widget = item",
  "  return Widget",
  "}",
  "fun later(item: Widget): Int {",
  "  val copy: Widget = item",
  "  val Widget = 3",
  "  return Widget",
  "}",
] as const;

export const KOTLIN_TYPE_VALUE_FILES = {
  "Api.kt": "package lib\nclass Widget\n",
  "Decoy.kt": "package decoy\nclass Widget\n",
  "Use.kt": KOTLIN_TYPE_VALUE_LINES.join("\n") + "\n",
} as const;

export const KOTLIN_TYPE_VALUE_TYPE_LINES = [3, 4, 5, 8, 10, 13, 14] as const;

export const KOTLIN_TYPE_PARAMETER_USE_LINES = [
  "package client",
  "import lib.Widget as T",
  "fun <T> identity(value: T): T = value",
  "class Box<T>(val value: T) {",
  "  fun get(): T = value",
  "  fun <T> own(x: T): T = x",
  "}",
] as const;

export const KOTLIN_TYPE_PARAMETER_FILES = {
  "Api.kt": "package lib\nclass Widget\n",
  "Decoy.kt": "package decoy\nclass Widget\n",
  // The imported alias is shadowed by each type parameter inside its own declaration.
  "Use.kt": KOTLIN_TYPE_PARAMETER_USE_LINES.join("\n") + "\n",
  // The same alias with no type parameter in scope still names Widget.
  "Alias.kt": "package client2\nimport lib.Widget as T\nfun plain(w: T): T = w\n",
  // Without any alias, type parameters resolve to their own declaration.
  "Plain.kt":
    "package client3\nfun <T> identity(value: T): T = value\nclass Box<T>(val value: T) {\n  fun get(): T = value\n}\n",
} as const;

export type KotlinTypeParameterSite = {
  file: "Use.kt" | "Plain.kt";
  line: number;
  /** 1-based column of the type-parameter use. */
  column: number;
  /** 1-based line and column of the declaring type parameter. */
  declaration: { line: number; column: number };
};

/** Every `T` use and declaration in the type-parameter fixtures, with the declaration each must resolve to. */
export function kotlinTypeParameterSites(): readonly KotlinTypeParameterSite[] {
  const declarationLines: Record<KotlinTypeParameterSite["file"], Readonly<Record<number, number>>> = {
    "Use.kt": { 3: 3, 4: 4, 5: 4, 6: 6 },
    "Plain.kt": { 2: 2, 3: 3, 4: 3 },
  };
  const sites: KotlinTypeParameterSite[] = [];
  for (const file of ["Use.kt", "Plain.kt"] as const) {
    const lines = KOTLIN_TYPE_PARAMETER_FILES[file].split("\n");
    for (const [line, declarationLine] of Object.entries(declarationLines[file])) {
      const declaredAt = lines[declarationLine - 1]!.search(/\bT\b/) + 1;
      for (const match of lines[Number(line) - 1]!.matchAll(/\bT\b/g)) {
        sites.push({
          file,
          line: Number(line),
          column: match.index + 1,
          declaration: { line: declarationLine, column: declaredAt },
        });
      }
    }
  }
  return sites;
}
