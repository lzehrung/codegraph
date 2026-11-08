/** Cross-file Kotlin extension-body receiver and same-named lexical decoys. */
export const KOTLIN_EXTENSION_RECEIVER_LINES = {
  "model/Box.kt": ["package model", "class Box {", "    fun hit() {}", "}", ""],
  "app/Extensions.kt": ["package app", "import model.Box", "fun Box.extra() {}", ""],
  "app/Use.kt": [
    "package app",
    "import model.Box",
    "fun hit() {}",
    "fun Box.render() { hit() }",
    "class Host {",
    "    fun hit() {}",
    "    fun extra() {}",
    "    fun Box.display() { hit() }",
    "    fun Box.crossFile() { extra() }",
    "}",
    "",
  ],
} as const;

export const KOTLIN_EXTENSION_RECEIVER_SOURCES = Object.fromEntries(
  Object.entries(KOTLIN_EXTENSION_RECEIVER_LINES).map(([file, lines]) => [file, lines.join("\n")]),
);
