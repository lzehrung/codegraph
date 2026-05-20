import path from "node:path";
import { builtinModules } from "node:module";

const NODE_BUILTIN_MODULES = new Set<string>([
  ...builtinModules,
  ...builtinModules.filter((name) => !name.startsWith("node:")).map((name) => `node:${name}`),
]);

const PYTHON_STDLIB_MODULES = new Set([
  "__future__",
  "abc",
  "argparse",
  "asyncio",
  "collections",
  "contextlib",
  "dataclasses",
  "datetime",
  "decimal",
  "functools",
  "itertools",
  "json",
  "logging",
  "math",
  "os",
  "pathlib",
  "re",
  "shutil",
  "sqlite3",
  "statistics",
  "string",
  "subprocess",
  "sys",
  "tempfile",
  "time",
  "typing",
  "unittest",
  "urllib",
]);

const RUBY_STDLIB_MODULES = new Set([
  "date",
  "digest",
  "fileutils",
  "json",
  "logger",
  "pathname",
  "set",
  "time",
  "uri",
  "yaml",
]);

const GO_STDLIB_IMPORTS = new Set([
  "bufio",
  "bytes",
  "context",
  "crypto",
  "database",
  "encoding",
  "errors",
  "fmt",
  "io",
  "log",
  "math",
  "net",
  "net/http",
  "os",
  "path",
  "path/filepath",
  "reflect",
  "regexp",
  "sort",
  "strconv",
  "strings",
  "sync",
  "testing",
  "time",
]);

const CPP_STDLIB_HEADERS = new Set([
  "algorithm",
  "array",
  "chrono",
  "cstdint",
  "cstdio",
  "cstdlib",
  "exception",
  "filesystem",
  "fstream",
  "functional",
  "iostream",
  "map",
  "memory",
  "optional",
  "set",
  "sstream",
  "stdexcept",
  "string",
  "string_view",
  "tuple",
  "type_traits",
  "unordered_map",
  "unordered_set",
  "utility",
  "vector",
]);

const C_STDLIB_HEADERS = new Set([
  "assert.h",
  "ctype.h",
  "errno.h",
  "float.h",
  "limits.h",
  "math.h",
  "setjmp.h",
  "signal.h",
  "stdarg.h",
  "stdbool.h",
  "stddef.h",
  "stdint.h",
  "stdio.h",
  "stdlib.h",
  "string.h",
  "time.h",
]);

const SWIFT_SDK_MODULES = new Set(["Foundation", "Dispatch", "Darwin", "Glibc", "SwiftUI", "UIKit"]);

export function isUrlSpecifier(specifier: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(specifier) || specifier.startsWith("data:");
}

function extensionForFile(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function isSupportedStdlib(specifier: string, importerFile: string): boolean {
  const ext = extensionForFile(importerFile);
  const firstSegment = specifier.split(/[.:/]/)[0] ?? specifier;
  if (NODE_BUILTIN_MODULES.has(specifier)) return true;
  if ([".py", ".pyw"].includes(ext)) return PYTHON_STDLIB_MODULES.has(firstSegment);
  if ([".rb"].includes(ext)) return RUBY_STDLIB_MODULES.has(specifier) || RUBY_STDLIB_MODULES.has(firstSegment);
  if (ext === ".zig") return specifier === "std";
  if (ext === ".go") return GO_STDLIB_IMPORTS.has(specifier) || GO_STDLIB_IMPORTS.has(firstSegment);
  if (ext === ".rs") {
    return (
      specifier === "std" ||
      specifier.startsWith("std::") ||
      specifier.startsWith("core::") ||
      specifier.startsWith("alloc::")
    );
  }
  if ([".java"].includes(ext)) {
    return (
      specifier.startsWith("java.") ||
      specifier.startsWith("javax.") ||
      specifier.startsWith("org.w3c.") ||
      specifier.startsWith("org.xml.")
    );
  }
  if ([".kt", ".kts"].includes(ext)) return specifier === "kotlin" || specifier.startsWith("kotlin.");
  if (ext === ".cs") {
    return specifier === "System" || specifier.startsWith("System.") || specifier.startsWith("Microsoft.");
  }
  if (ext === ".swift") return SWIFT_SDK_MODULES.has(firstSegment);
  if ([".c", ".h", ".i"].includes(ext)) return C_STDLIB_HEADERS.has(specifier);
  if ([".cc", ".cpp", ".cxx", ".c++", ".hpp", ".hh", ".hxx", ".ipp", ".tpp", ".inl"].includes(ext)) {
    return CPP_STDLIB_HEADERS.has(specifier) || C_STDLIB_HEADERS.has(specifier);
  }
  return false;
}
