/**
 * #378 cross-language callable consumer fixtures.
 *
 * One row per callable language id. Every row declares a callable target in one compilation
 * unit, an accepted call that must reach it, a same-named decoy in a different unit that must
 * stay separate, and (for languages whose member lookup uses call arity) an arity-incompatible
 * call that must not produce a `calls` edge.
 *
 * The rows are consumed by `callable-consumer-matrix.test.ts` through the public navigation,
 * reference, and detailed-graph consumers. They are data, not assertions: no row may encode a
 * helper's internal shape, and no row is satisfied by registry membership alone.
 *
 * Line numbers are 1-based indexes into the row's own `lines` array. Call columns are located at
 * assertion time from `token`, so the fixture text stays the single source of truth.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "../../src/util/paths.js";

/**
 * Writes fixture files under `root`, creating parent directories, and returns a map from each
 * project-relative fixture path to its normalized absolute path. Shared by the cross-language
 * matrix and the per-language peer regressions so both resolve the same paths the graph does.
 */
export async function writeFixtureFiles(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};
  for (const [relative, source] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fsp.mkdir(path.dirname(absolute), { recursive: true });
    await fsp.writeFile(absolute, source, "utf8");
    paths[relative] = normalizePath(absolute);
  }
  return paths;
}

/** 1-based column of `token`'s first occurrence on a 1-based line. */
export function columnOf(lines: readonly string[], line: number, token: string): number {
  const text = lines[line - 1] ?? "";
  const at = text.indexOf(token);
  if (at < 0) {
    throw new Error(`token ${token} not found on line ${line}: ${text}`);
  }
  return at + 1;
}

export type CallableConsumerFile = {
  /** Project-relative path, including any package/module directory. */
  path: string;
  lines: string[];
};

export type CallableConsumerCall = {
  /** Name of the enclosing callable that performs the call. */
  caller: string;
  /** 1-based line of the call. */
  line: number;
  /** Token to locate on that line; the first occurrence is used. */
  token: string;
  /** Overrides the owner file for calls made from another file in the same unit. */
  file?: string;
};

export type CallableConsumerRow = {
  languageId: string;
  /** Distinguishes multiple capability rows for one language id in test titles. */
  label?: string;
  /** File declaring the accepted target. */
  ownerFile: string;
  files: CallableConsumerFile[];
  target: { name: string; line: number };
  /** Call that must resolve to the owner target and produce a `calls` edge. */
  accepted: CallableConsumerCall;
  /**
   * Arity-incompatible call that must not produce a `calls` edge. Present only for languages
   * whose member lookup already selects by call arity; the other languages reject through the
   * decoy boundary instead.
   */
  arityRejected?: CallableConsumerCall & { targetName: string };
  /** Same-named declaration in a different compilation unit. */
  decoy: { file: string; name: string; line: number; token: string };
};

export const CALLABLE_CONSUMER_ROWS: readonly CallableConsumerRow[] = [
  {
    languageId: "c",
    ownerFile: "box.c",
    files: [
      {
        path: "box.c",
        lines: ["int target(int value) { return value; }", "int accepted(void) { return target(1); }"],
      },
      {
        path: "decoy.c",
        lines: ["int target(int value) { return value + 1; }", "int decoy_use(void) { return target(1); }"],
      },
    ],
    target: { name: "target", line: 1 },
    accepted: { caller: "accepted", line: 2, token: "target" },
    decoy: { file: "decoy.c", name: "target", line: 1, token: "target" },
  },
  {
    languageId: "cpp",
    ownerFile: "box.hpp",
    files: [
      {
        path: "box.hpp",
        lines: [
          "namespace p {",
          "struct Box {",
          "  int target(int value = 1) { return value; }",
          "  int accepted() { return this->target(); }",
          "  int rejected() { return this->target(1, 2); }",
          "};",
          "}",
        ],
      },
      {
        path: "q.hpp",
        lines: [
          "namespace q {",
          "struct Box {",
          "  int target(int value = 1) { return value; }",
          "  int decoy_use() { return this->target(); }",
          "};",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 3 },
    accepted: { caller: "accepted", line: 4, token: "target" },
    arityRejected: { caller: "rejected", line: 5, token: "target", targetName: "target" },
    decoy: { file: "q.hpp", name: "target", line: 3, token: "target" },
  },
  {
    languageId: "csharp",
    ownerFile: "Box.cs",
    files: [
      {
        path: "Box.cs",
        lines: [
          "namespace P;",
          "public class Box {",
          "  public int Target(int value = 1) { return value; }",
          "  public int Accepted() { return this.Target(); }",
          "  public int Rejected() { return this.Target(1, 2); }",
          "}",
        ],
      },
      {
        path: "Decoy.cs",
        lines: [
          "namespace Q;",
          "public class Decoy {",
          "  public int Target(int value = 1) { return value; }",
          "  public int Use() { return this.Target(); }",
          "}",
        ],
      },
    ],
    target: { name: "Target", line: 3 },
    accepted: { caller: "Accepted", line: 4, token: "Target" },
    arityRejected: { caller: "Rejected", line: 5, token: "Target", targetName: "Target" },
    decoy: { file: "Decoy.cs", name: "Target", line: 3, token: "Target" },
  },
  {
    languageId: "go",
    ownerFile: "box.go",
    files: [
      {
        path: "box.go",
        lines: [
          "package p",
          "",
          "func target(values ...int) int { return len(values) }",
          "",
          "func accepted() int { return target(1, 2) }",
        ],
      },
      {
        path: "q/decoy.go",
        lines: [
          "package q",
          "",
          "func target(values ...int) int { return len(values) }",
          "",
          "func decoy_use() int { return target(1) }",
        ],
      },
    ],
    target: { name: "target", line: 3 },
    accepted: { caller: "accepted", line: 5, token: "target" },
    decoy: { file: "q/decoy.go", name: "target", line: 3, token: "target" },
  },
  {
    languageId: "java",
    ownerFile: "Box.java",
    files: [
      {
        path: "Box.java",
        lines: [
          "package p;",
          "public class Box {",
          "  int target(int... values) { return values.length; }",
          "  int fixed(int value) { return value; }",
          "  int accepted() { return this.target(1, 2); }",
          "  int rejected() { return this.fixed(1, 2); }",
          "}",
        ],
      },
      {
        path: "q/Decoy.java",
        lines: [
          "package q;",
          "public class Decoy {",
          "  int target(int... values) { return values.length; }",
          "  int decoy_use() { return this.target(1); }",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 3 },
    accepted: { caller: "accepted", line: 5, token: "target" },
    arityRejected: { caller: "rejected", line: 6, token: "fixed", targetName: "fixed" },
    decoy: { file: "q/Decoy.java", name: "target", line: 3, token: "target" },
  },
  {
    languageId: "java",
    label: "java explicit receiver",
    ownerFile: "Receiver.java",
    files: [
      {
        path: "Receiver.java",
        lines: [
          "package p;",
          "public class Receiver {",
          "  int target(Receiver this, Map<String, Integer> value) { return 0; }",
          "  int accepted() { return this.target(1); }",
          "  int rejected() { return this.target(1, 2); }",
          "}",
        ],
      },
      {
        path: "q/DecoyReceiver.java",
        lines: [
          "package q;",
          "public class DecoyReceiver {",
          "  int target(DecoyReceiver this, Map<String, Integer> value) { return 0; }",
          "  int decoy_use() { return this.target(1); }",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 3 },
    accepted: { caller: "accepted", line: 4, token: "target" },
    arityRejected: { caller: "rejected", line: 5, token: "target", targetName: "target" },
    decoy: { file: "q/DecoyReceiver.java", name: "target", line: 3, token: "target" },
  },
  {
    languageId: "js",
    ownerFile: "box.js",
    files: [
      {
        path: "box.js",
        lines: [
          "export class Box {",
          "  target(value = 1) { return value; }",
          "  accepted() { return this.target(); }",
          "}",
        ],
      },
      {
        path: "decoy.js",
        lines: [
          "export class Decoy {",
          "  target(value = 1) { return value; }",
          "  decoy_use() { return this.target(); }",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 2 },
    accepted: { caller: "accepted", line: 3, token: "target" },
    decoy: { file: "decoy.js", name: "target", line: 2, token: "target" },
  },
  {
    languageId: "kotlin",
    ownerFile: "Box.kt",
    files: [
      {
        path: "Box.kt",
        lines: [
          "package p",
          "class Box {",
          "  fun target(value: Int = 1): Int = value",
          "  fun accepted(): Int = this.target()",
          "  fun rejected(): Int = this.target(1, 2)",
          "}",
        ],
      },
      {
        path: "q/Decoy.kt",
        lines: [
          "package q",
          "class Decoy {",
          "  fun target(value: Int = 1): Int = value",
          "  fun decoyUse(): Int = this.target()",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 3 },
    accepted: { caller: "accepted", line: 4, token: "target" },
    arityRejected: { caller: "rejected", line: 5, token: "target", targetName: "target" },
    decoy: { file: "q/Decoy.kt", name: "target", line: 3, token: "target" },
  },
  {
    languageId: "php",
    ownerFile: "box.php",
    files: [
      {
        path: "box.php",
        lines: [
          "<?php",
          "namespace P;",
          "",
          "class Box {",
          "    public function target($value = 1) { return $value; }",
          "    public function accepted() { return $this->target(); }",
          "}",
        ],
      },
      {
        path: "decoy.php",
        lines: [
          "<?php",
          "namespace Q;",
          "",
          "class Decoy {",
          "    public function target($value = 1) { return $value; }",
          "    public function decoy_use() { return $this->target(); }",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 5 },
    accepted: { caller: "accepted", line: 6, token: "target" },
    decoy: { file: "decoy.php", name: "target", line: 5, token: "target" },
  },
  {
    languageId: "python",
    ownerFile: "box.py",
    files: [
      {
        path: "box.py",
        lines: [
          "class Box:",
          "    @staticmethod",
          "    def target(value):",
          "        return value",
          "",
          "    @staticmethod",
          "    def accepted():",
          "        return Box.target(1)",
        ],
      },
      {
        path: "decoy.py",
        lines: [
          "class Decoy:",
          "    def target(self, value):",
          "        return value",
          "",
          "    def decoy_use(self):",
          "        return self.target(1)",
        ],
      },
    ],
    target: { name: "target", line: 3 },
    accepted: { caller: "accepted", line: 8, token: "target" },
    decoy: { file: "decoy.py", name: "target", line: 2, token: "target" },
  },
  {
    languageId: "ruby",
    ownerFile: "box.rb",
    files: [
      {
        path: "box.rb",
        lines: [
          "class Box",
          "  def target(value = 1)",
          "    value",
          "  end",
          "",
          "  def accepted",
          "    self.target()",
          "  end",
          "end",
        ],
      },
      {
        path: "decoy.rb",
        lines: [
          "class Decoy",
          "  def target(value = 1)",
          "    value",
          "  end",
          "",
          "  def decoy_use",
          "    self.target()",
          "  end",
          "end",
        ],
      },
    ],
    target: { name: "target", line: 2 },
    accepted: { caller: "accepted", line: 7, token: "target" },
    decoy: { file: "decoy.rb", name: "target", line: 2, token: "target" },
  },
  {
    languageId: "rust",
    ownerFile: "box.rs",
    files: [
      {
        path: "box.rs",
        lines: [
          "struct Box;",
          "",
          "impl Box {",
          "    fn target(&self, value: i32) -> i32 {",
          "        value",
          "    }",
          "",
          "    fn accepted(&self) -> i32 {",
          "        self.target(1)",
          "    }",
          "}",
        ],
      },
      {
        path: "decoy.rs",
        lines: [
          "struct Decoy;",
          "",
          "impl Decoy {",
          "    fn target(&self, value: i32) -> i32 {",
          "        value",
          "    }",
          "",
          "    fn decoy_use(&self) -> i32 {",
          "        self.target(1)",
          "    }",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 4 },
    accepted: { caller: "accepted", line: 9, token: "target" },
    decoy: { file: "decoy.rs", name: "target", line: 4, token: "target" },
  },
  {
    languageId: "swift",
    ownerFile: "Box.swift",
    files: [
      {
        path: "Box.swift",
        lines: [
          "class Box {",
          "  func target(_ value: Int = 1) -> Int { return value }",
          "  func accepted() -> Int { return self.target() }",
          "  func rejected() -> Int { return self.target(1, 2) }",
          "}",
        ],
      },
      {
        path: "Decoy.swift",
        lines: [
          "class Decoy {",
          "  func target(_ value: Int = 1) -> Int { return value }",
          "  func decoyUse() -> Int { return self.target() }",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 2 },
    accepted: { caller: "accepted", line: 3, token: "target" },
    arityRejected: { caller: "rejected", line: 4, token: "target", targetName: "target" },
    decoy: { file: "Decoy.swift", name: "target", line: 2, token: "target" },
  },
  {
    languageId: "ts",
    ownerFile: "box.ts",
    files: [
      {
        path: "box.ts",
        lines: [
          "export class Box {",
          "  target(value = 1) { return value; }",
          "  accepted() { return this.target(); }",
          "  rejected() { return this.target(1, 2); }",
          "}",
        ],
      },
      {
        path: "decoy.ts",
        lines: [
          "export class Decoy {",
          "  target(value = 1) { return value; }",
          "  decoyUse() { return this.target(); }",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 2 },
    accepted: { caller: "accepted", line: 3, token: "target" },
    arityRejected: { caller: "rejected", line: 4, token: "target", targetName: "target" },
    decoy: { file: "decoy.ts", name: "target", line: 2, token: "target" },
  },
  {
    languageId: "tsx",
    ownerFile: "box.tsx",
    files: [
      {
        path: "box.tsx",
        lines: [
          "export class Box {",
          "  target(value = 1) { return value; }",
          "  accepted() { return this.target(); }",
          "  rejected() { return this.target(1, 2); }",
          "}",
        ],
      },
      {
        path: "decoy.tsx",
        lines: [
          "export class Decoy {",
          "  target(value = 1) { return value; }",
          "  decoyUse() { return this.target(); }",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 2 },
    accepted: { caller: "accepted", line: 3, token: "target" },
    arityRejected: { caller: "rejected", line: 4, token: "target", targetName: "target" },
    decoy: { file: "decoy.tsx", name: "target", line: 2, token: "target" },
  },
  {
    languageId: "zig",
    ownerFile: "box.zig",
    files: [
      {
        path: "box.zig",
        lines: [
          "pub fn target(value: i32) i32 {",
          "    return value;",
          "}",
          "",
          "pub fn accepted() i32 {",
          "    return target(1);",
          "}",
        ],
      },
      {
        path: "decoy.zig",
        lines: [
          "pub fn target(value: i32) i32 {",
          "    return value;",
          "}",
          "",
          "pub fn decoy_use() i32 {",
          "    return target(1);",
          "}",
        ],
      },
    ],
    target: { name: "target", line: 1 },
    accepted: { caller: "accepted", line: 6, token: "target" },
    decoy: { file: "decoy.zig", name: "target", line: 1, token: "target" },
  },
];
