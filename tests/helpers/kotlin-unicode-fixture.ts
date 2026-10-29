/**
 * Kotlin names written with CJK ideographs, Hangul syllables, and a supplementary-plane ideograph, as one cross-package
 * fixture. The shared navigation suites (`goto.test.ts`, `references.test.ts`, and `native-semantic-parity.test.ts`)
 * read the same source, and `languages/kotlin.test.ts` reads the names.
 *
 * `kunicode/app` declares a class (`cls`), a function (`fn`), and a second function (`astral`). `kunicode/client`
 * imports all three, constructs the class, and calls both functions. `kunicode/other` declares the same three names in
 * a package the client does not import and uses its own, so a lookup that reaches the wrong package shows up as a wrong
 * target, a foreign reference, or a foreign call edge.
 *
 * The names are escapes, which keeps this file ASCII. `cls` is two CJK ideographs (U+540D U+524D), `fn` two Hangul
 * syllables (U+D55C U+AE00), and `astral` starts with U+20BB7, a CJK ideograph above the basic plane that takes two
 * UTF-16 code units, followed by two ideographs (U+91CE U+5BB6). A grammar whose lexer does not read these letters
 * parses each file with an ERROR, so no name is indexed. Each use line puts `astral` before the other names, so the
 * exact columns that `references.test.ts` compares also prove that a column counts the two code units of U+20BB7.
 */

export const KOTLIN_UNICODE_NAMES = {
  cls: "\u540d\u524d",
  fn: "\ud55c\uae00",
  astral: "\ud842\udfb7\u91ce\u5bb6",
} as const;

const { cls, fn, astral } = KOTLIN_UNICODE_NAMES;

/** Project-relative paths of the fixture files. */
export const KOTLIN_UNICODE_FILES = {
  defs: "kunicode/app/Defs.kt",
  use: "kunicode/client/Use.kt",
  decoy: "kunicode/other/Decoy.kt",
} as const;

/**
 * The source lines of each file, 1-based in the tests that read them:
 * - `Defs.kt` declares the class on line 3, `fn` on line 5, and `astral` on line 7.
 * - `Use.kt` imports the three names on lines 3 to 5, constructs the class on line 8 in `useNames`, and on line 9
 *   calls `astral` and then `fn`.
 * - `Decoy.kt` declares the three names on lines 3, 5, and 7 and, in `useDecoys` on line 9, constructs the class and
 *   calls `astral` and then `fn`.
 */
export const KOTLIN_UNICODE_LINES: Record<string, string[]> = {
  [KOTLIN_UNICODE_FILES.defs]: [
    "package kunicode.app",
    "",
    `class ${cls}(val x: Int)`,
    "",
    `fun ${fn}(v: Int): Int = v + 1`,
    "",
    `fun ${astral}(v: Int): Int = v * 2`,
  ],
  [KOTLIN_UNICODE_FILES.use]: [
    "package kunicode.client",
    "",
    `import kunicode.app.${cls}`,
    `import kunicode.app.${fn}`,
    `import kunicode.app.${astral}`,
    "",
    "fun useNames(): Int {",
    `    val made = ${cls}(1)`,
    `    return ${astral}(2) + ${fn}(made.x)`,
    "}",
  ],
  [KOTLIN_UNICODE_FILES.decoy]: [
    "package kunicode.other",
    "",
    `class ${cls}(val y: Int)`,
    "",
    `fun ${fn}(v: Int): Int = v`,
    "",
    `fun ${astral}(v: Int): Int = v`,
    "",
    `fun useDecoys(): Int = ${astral}(3) + ${fn}(${cls}(1).y)`,
  ],
};

/** The fixture as project-relative path to source text, for writing to disk. */
export const KOTLIN_UNICODE_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(KOTLIN_UNICODE_LINES).map(([file, lines]) => [file, `${lines.join("\n")}\n`]),
);
