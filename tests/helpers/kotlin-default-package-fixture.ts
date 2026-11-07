export const KOTLIN_DEFAULT_PACKAGE_SOURCES = {
  "Default.kt": ["class DefaultThing", "fun defaultFn(): Int = 42", ""].join("\n"),
  "Named.kt": ["package decoy", "class DefaultThing", "fun defaultFn(): Int = -1", ""].join("\n"),
  "PackageDecoy.kt": "package DefaultThing\nclass Impostor\n",
  "app/Use.kt": [
    "package app",
    "import DefaultThing",
    "import defaultFn as chosen",
    "class Use {",
    "  fun make(): DefaultThing {",
    "    chosen()",
    "    return DefaultThing()",
    "  }",
    "}",
    "",
  ].join("\n"),
} as const;
