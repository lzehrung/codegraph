/**
 * Generates one "elsewhere" decoy file per language: ordinary code declaring a callable or a
 * type under the given name, placed where nothing else in a cell's project reaches it. Used by
 * the "unrelated decoy elsewhere" and "warm disk cache vs. cold build" metamorphic checks in
 * `harness.ts`. Every project this returns is additive: callers union the result into a cell's
 * own `files` map.
 *
 * Each declaration lives inside its own namespace, package, module, or crate (never the bare
 * global/file scope that a cell's own fixtures use), so it never collides with any name a cell
 * author chose, and it can share a bare name with the cell's real answer without creating a
 * duplicate fully-qualified declaration.
 */
import type { DecoyKind, Language } from "./types.js";

const RETURN_VALUE = -1;

export function elsewhereDecoyFiles(language: Language, name: string, kind: DecoyKind): Record<string, string> {
  switch (language) {
    case "ts":
    case "tsx": {
      const ext = language === "tsx" ? "tsx" : "ts";
      const source =
        kind === "type"
          ? `export class ${name} {\n  run(): number {\n    return ${RETURN_VALUE};\n  }\n}\n`
          : `export function ${name}(): number {\n  return ${RETURN_VALUE};\n}\n`;
      return { [`zz-elsewhere/decoy.${ext}`]: source };
    }
    case "js": {
      const source =
        kind === "type"
          ? `export class ${name} {\n  run() {\n    return ${RETURN_VALUE};\n  }\n}\n`
          : `export function ${name}() {\n  return ${RETURN_VALUE};\n}\n`;
      return { "zz-elsewhere/decoy.js": source };
    }
    case "python": {
      const source =
        kind === "type"
          ? `class ${name}:\n    def run(self):\n        return ${RETURN_VALUE}\n`
          : `def ${name}():\n    return ${RETURN_VALUE}\n`;
      return { "zz_elsewhere/decoy.py": source };
    }
    case "php": {
      const body =
        kind === "type"
          ? `class ${name}\n{\n    public function run()\n    {\n        return ${RETURN_VALUE};\n    }\n}\n`
          : `function ${name}()\n{\n    return ${RETURN_VALUE};\n}\n`;
      return { "zz-elsewhere/decoy.php": `<?php\n\nnamespace Zz\\Elsewhere;\n\n${body}` };
    }
    case "go": {
      const body =
        kind === "type"
          ? `type ${name} struct{}\n\nfunc (${name}) Run() int {\n\treturn ${RETURN_VALUE}\n}\n`
          : `func ${name}() int {\n\treturn ${RETURN_VALUE}\n}\n`;
      return { "zzelsewhere/decoy.go": `package zzelsewhere\n\n${body}` };
    }
    case "java": {
      if (kind === "type") {
        return {
          [`zzelsewhere/${name}.java`]: `package zzelsewhere;\n\npublic class ${name} {\n  public int run() {\n    return ${RETURN_VALUE};\n  }\n}\n`,
        };
      }
      return {
        "zzelsewhere/ZzDecoy.java": `package zzelsewhere;\n\npublic class ZzDecoy {\n  public static int ${name}() {\n    return ${RETURN_VALUE};\n  }\n}\n`,
      };
    }
    case "csharp": {
      const source =
        kind === "type"
          ? `namespace ZzElsewhere {\n  public class ${name} {\n    public int Run() => ${RETURN_VALUE};\n  }\n}\n`
          : `namespace ZzElsewhere {\n  public class ZzDecoy {\n    public static int ${name}() => ${RETURN_VALUE};\n  }\n}\n`;
      return { "zzelsewhere/Decoy.cs": source };
    }
    case "kotlin": {
      const body =
        kind === "type"
          ? `class ${name} {\n    fun run(): Int = ${RETURN_VALUE}\n}\n`
          : `fun ${name}(): Int = ${RETURN_VALUE}\n`;
      return { "zzelsewhere/Decoy.kt": `package zzelsewhere\n\n${body}` };
    }
    case "ruby": {
      const source =
        kind === "type"
          ? `module ZzElsewhere\n  class ${name}\n    def run\n      ${RETURN_VALUE}\n    end\n  end\nend\n`
          : `module ZzElsewhere\n  def self.${name}\n    ${RETURN_VALUE}\n  end\nend\n`;
      return { "zz_elsewhere/decoy.rb": source };
    }
    case "rust": {
      const body =
        kind === "type"
          ? `pub struct ${name};\n\nimpl ${name} {\n    pub fn run(&self) -> i32 {\n        ${RETURN_VALUE}\n    }\n}\n`
          : `pub fn ${name}() -> i32 {\n    ${RETURN_VALUE}\n}\n`;
      // Rust only indexes a file as part of a crate's module tree, so the decoy gets its own,
      // otherwise unreferenced crate rather than an orphan file under the existing one.
      return {
        "zzelsewhere/Cargo.toml": '[package]\nname = "zzelsewhere"\nversion = "0.1.0"\n',
        "zzelsewhere/src/lib.rs": body,
      };
    }
    case "swift": {
      const source =
        kind === "type"
          ? `class ${name} {\n    func run() -> Int {\n        return ${RETURN_VALUE}\n    }\n}\n`
          : `func ${name}() -> Int {\n    return ${RETURN_VALUE}\n}\n`;
      return { "zz-elsewhere/Decoy.swift": source };
    }
    case "zig": {
      const source =
        kind === "type"
          ? `pub const ${name} = struct {\n    pub fn run(self: ${name}) i32 {\n        _ = self;\n        return ${RETURN_VALUE};\n    }\n};\n`
          : `pub fn ${name}() i32 {\n    return ${RETURN_VALUE};\n}\n`;
      return { "zz-elsewhere/decoy.zig": source };
    }
    case "c": {
      const source =
        kind === "type"
          ? `struct ${name} {\n  int unused;\n};\n`
          : `int ${name}(void) {\n  return ${RETURN_VALUE};\n}\n`;
      return { "zz_elsewhere/decoy.c": source };
    }
    case "cpp": {
      const body =
        kind === "type"
          ? `class ${name} {\npublic:\n  int run() { return ${RETURN_VALUE}; }\n};\n`
          : `int ${name}() {\n  return ${RETURN_VALUE};\n}\n`;
      return { "zz_elsewhere/decoy.cpp": `namespace zz_elsewhere {\n${body}}\n` };
    }
    default: {
      const exhaustive: never = language;
      throw new Error(`no elsewhere-decoy template for language "${String(exhaustive)}"`);
    }
  }
}
