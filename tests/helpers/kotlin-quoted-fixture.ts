/** Shared quoted/plain Kotlin identity cases, Java interoperability, and foreign-package decoys. */
export const KOTLIN_QUOTED_FILES = {
  defs: "kquoted/app/Defs.kt",
  boxed: "kqpkg/lib/Boxed.kt",
  use: "kquoted/client/Use.kt",
  quotedPackageUse: "kquoted/client/QuotedPkg.kt",
  java: "kquoted/client/UseFromJava.java",
  decoy: "kquoted/other/Decoy.kt",
} as const;

export const KOTLIN_QUOTED_LINES: Record<string, string[]> = {
  [KOTLIN_QUOTED_FILES.defs]: [
    "package kquoted.app",
    "",
    "class `Widget`(val x: Int)",
    "",
    "fun `quoted name`(v: Int): Int = v + 1",
    "",
    "fun plainName(v: Int): Int = v * 2",
  ],
  [KOTLIN_QUOTED_FILES.boxed]: ["package `kqpkg`.lib", "", "class Boxed(val b: Int)"],
  [KOTLIN_QUOTED_FILES.use]: [
    "package kquoted.client",
    "",
    "import kquoted.app.Widget",
    "import kquoted.app.`quoted name`",
    "import kquoted.app.`plainName`",
    "import kquoted.app.`quoted name` as Alias",
    "import kquoted.app.`Missing Name`",
    "",
    "import kqpkg.lib.Boxed",
    "",
    "fun useType(w: Widget): Int = w.x",
    "",
    "fun useNames(): Int = `quoted name`(1) + plainName(2) + Alias(3) + `Alias`(4)",
    "",
    "fun useBox(b: Boxed): Int = b.b",
  ],
  [KOTLIN_QUOTED_FILES.quotedPackageUse]: [
    "package kquoted.client",
    "",
    "import `kqpkg`.lib.Boxed",
    "",
    "fun useQuotedBox(b: Boxed): Int = b.b",
  ],
  [KOTLIN_QUOTED_FILES.java]: [
    "package kquoted.client;",
    "",
    "import kquoted.app.Widget;",
    "",
    "class UseFromJava {",
    "    int read(Widget w) { return 1; }",
    "}",
  ],
  [KOTLIN_QUOTED_FILES.decoy]: [
    "package kquoted.other",
    "",
    "class `Widget`(val y: Int)",
    "",
    "fun `quoted name`(v: Int): Int = v",
    "",
    "fun plainName(v: Int): Int = v",
    "",
    "fun useDecoys(w: Widget): Int = `quoted name`(w.y) + plainName(1)",
  ],
};

export const KOTLIN_QUOTED_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(KOTLIN_QUOTED_LINES).map(([file, lines]) => [file, `${lines.join("\n")}\n`]),
);
