/**
 * F1: every 2026-09-25 audit fixture (except W19, still in progress, and the cache/API
 * items G1, G2, G6) run through `goToDefinition`, `findReferences`, and
 * `buildSymbolGraphDetailed` together.
 *
 * One `it.each` table per language. A checklist item is two rows that share a fixture:
 * the use site, and a same-named unrelated declaration that must not match it. Adding
 * a future case is one more use row plus its decoy row.
 *
 * `provenNonReference` is why an unresolved site (or a decoy) still has `complete`
 * coverage: the use is not a candidate of that declaration. Not_found rows without it
 * must not claim `complete`.
 */
import { afterAll, describe, it } from "vitest";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  type ConsumerAgreementFixture,
  type ConsumerAgreementSite,
} from "./helpers/consumer-agreement.js";

const suite = isNativeTreeSitterAvailable() ? describe : describe.skip;

function src(lines: readonly string[]): string {
  return lines.join("\n");
}

type TokenAt = { file: string; line: number; token: string; occurrence?: number };

type AgreementRow = {
  id: string;
  language: string;
  role: "use" | "decoy";
  files: Readonly<Record<string, string>>;
  site: TokenAt;
  expected: { file: string; line: number } | "not_found";
  /** Set when the site is a call, extends, include/extend, or instantiation. */
  edge?: { label: string; fromFile: string; fromName: string };
  /**
   * Not_found rows: the definition whose references are checked.
   * Decoy rows: the unrelated declaration the site must not match.
   */
  declaration?: TokenAt;
  /**
   * The site is provably not a reference of `declaration`, so coverage must be
   * `complete`. The string is the reason.
   */
  provenNonReference?: string;
  /** Real cross-consumer disagreement. The row is registered with `it.fails`. */
  fails?: string;
};

function address(token: TokenAt): TokenAt {
  return {
    file: token.file,
    line: token.line,
    token: token.token,
    ...(token.occurrence !== undefined ? { occurrence: token.occurrence } : {}),
  };
}

const built = new Map<string, Promise<ConsumerAgreementFixture>>();

function loadFixture(row: AgreementRow): Promise<ConsumerAgreementFixture> {
  const existing = built.get(row.id);
  if (existing) return existing;
  const pending = buildConsumerAgreementFixture(`cg-agree-${row.id}-`, row.files);
  built.set(row.id, pending);
  return pending;
}

afterAll(async () => {
  for (const pending of built.values()) {
    try {
      await disposeConsumerAgreementFixture(await pending);
    } catch {
      // The index build failed before returning a root.
    }
  }
});

async function runAgreementRow(row: AgreementRow): Promise<void> {
  const fixture = await loadFixture(row);
  const site = address(row.site);
  if (row.role === "decoy") {
    if (!row.declaration) throw new Error(`${row.id} decoy row is missing its declaration`);
    const decoy: ConsumerAgreementSite = {
      ...site,
      mustNotMatch: address(row.declaration),
      ...(row.provenNonReference ? { provablyNotAReference: true } : {}),
      ...(row.edge
        ? { absentEdge: { label: row.edge.label, from: { file: row.edge.fromFile, name: row.edge.fromName } } }
        : {}),
    };
    await assertConsumerAgreement(fixture, decoy);
    return;
  }
  if (row.expected === "not_found") {
    if (!row.declaration) throw new Error(`${row.id} not_found row is missing its declaration`);
    const unresolved: ConsumerAgreementSite = {
      ...site,
      expected: "not_found",
      sameNameDeclaration: address(row.declaration),
      ...(row.provenNonReference ? { provablyNotAReference: true } : {}),
      ...(row.edge
        ? {
            edges: [
              {
                label: row.edge.label,
                from: { file: row.edge.fromFile, name: row.edge.fromName },
                absent: true,
              },
            ],
          }
        : {}),
    };
    await assertConsumerAgreement(fixture, unresolved);
    return;
  }
  const resolved: ConsumerAgreementSite = {
    ...site,
    expected: row.expected,
    requireCompleteCoverage: true,
    ...(row.edge
      ? { edges: [{ label: row.edge.label, from: { file: row.edge.fromFile, name: row.edge.fromName } }] }
      : {}),
  };
  await assertConsumerAgreement(fixture, resolved);
}

const w9 = {
  "util.h": src(["#ifndef UTIL_H", "#define UTIL_H", "int compute(void);", "#endif"]),
  "util.c": src(['#include "util.h"', "int compute(void) { return 1; }"]),
  "extra.c": src(["int compute(void) { return 0; }"]),
  "run.c": src(['#include "util.h"', "int run(void) {", "  return compute();", "}"]),
};

const w10 = {
  "tools.hpp": src([
    "namespace tools {",
    "  int add(int left, int right) { return left + right; }",
    "  int add(const char* text) { return 1; }",
    "}",
    "namespace unused {",
    "  int add(int left, int right) { return 9; }",
    "}",
  ]),
  "main.cpp": src(['#include "tools.hpp"', "using namespace tools;", "int main() {", "  return add(1, 2);", "}"]),
};

const h7 = {
  "box.hpp": src(["class Box {", "public:", "  int run();", "};"]),
  "box.cpp": src(['#include "box.hpp"', "int Box::run() { return 1; }"]),
  "widget.hpp": src(["class Widget {", "public:", "  int run();", "};"]),
  "use.cpp": src(['#include "box.hpp"', "int callWithLocal() {", "  Box b;", "  return b.run();", "}"]),
};

const h4 = {
  "n.cs": src([
    "public class Outer {",
    "  public class Inner {",
    "    public int Value() => 42;",
    "  }",
    "}",
    "public class User {",
    "  public int Use() {",
    "    var i = new Outer.Inner();",
    "    return i.Value();",
    "  }",
    "}",
  ]),
  "other.cs": src(["public class Other {", "  public class Nested {", "    public int Value() => 99;", "  }", "}"]),
};

const h5 = {
  "pt.cs": src([
    "using PT = N.Point;",
    "namespace N {",
    "  public class Point {",
    "    public int Sum() => 1;",
    "  }",
    "}",
    "namespace N {",
    "  public class User {",
    "    public int Use() {",
    "      PT p = new PT();",
    "      return p.Sum();",
    "    }",
    "  }",
    "}",
  ]),
  "other.cs": src(["namespace N2 {", "  public class Other {", "    public int Sum() => 2;", "  }", "}"]),
};

const goMod = src(["module example.com/proj", "", "go 1.22"]);

const w11 = {
  "go.mod": goMod,
  "util/util.go": src(["package util", "", "func hidden() int { return 2 }"]),
  "other/other.go": src(["package other", "", "func hidden() int { return 9 }"]),
  "main/main.go": src([
    "package main",
    "",
    'import u "example.com/proj/util"',
    "",
    "func main() {",
    "  _ = u.hidden()",
    "}",
  ]),
};

const g3 = {
  "go.mod": goMod,
  "util/util.go": src(["package util", "", "func Square(x float64) float64 { return x * x }"]),
  "other/other.go": src(["package other", "", "func Square(x float64) float64 { return -1 }"]),
  "main/main.go": src([
    "package main",
    "",
    'import u "example.com/proj/util"',
    "",
    "func main() {",
    "  _ = u.Square(3.0)",
    "}",
  ]),
};

const w5 = {
  "p/Foo.java": src(["package p;", "", "public class Foo {", '  public String hello() { return "hi"; }', "}"]),
  "p/Bar.java": src([
    "package p;",
    "",
    "public class Bar {",
    "  public String direct() {",
    "    return new Foo().hello();",
    "  }",
    "}",
  ]),
  "q/Foo.java": src(["package q;", "", "public class Foo {", '  public String hello() { return "no"; }', "}"]),
};

const h6 = {
  "a/Greeter.java": src(["package a;", "public class Greeter {", '  public String hello() { return "hi"; }', "}"]),
  "b/User.java": src([
    "package b;",
    "import a.Greeter;",
    "public class User {",
    "  public String use(Greeter g) { return g.hello(); }",
    "}",
  ]),
  "decoy/Greeter.java": src(["package decoy;", "public class Greeter {", '  public String hello() { return "no"; }', "}"]),
};

const w3 = {
  "util.js": "exports.helper = function helper() { return 1; };",
  "decoy.js": "exports.helper = function helper() { return 2; };",
  "use.js": src(["const util = require('./util');", "function run() { return util.helper(); }"]),
};

const w20 = {
  "Box.kt": src([
    "package p",
    "",
    "class Box {",
    '  fun instanceHelper(): String = "hi"',
    "  companion object {",
    "    fun create(): Box = Box()",
    "  }",
    "}",
    "",
    "class Decoy {",
    '  fun instanceHelper(): String = "decoy"',
    "}",
    "",
    "fun useInvalid(): String {",
    "  return Box.instanceHelper()",
    "}",
  ]),
};

const h2 = {
  "w.kt": src([
    "class Widget(val id: Int) {",
    "  companion object {",
    "    fun create(): Widget = Widget(0)",
    "  }",
    "}",
    "class Gadget(val id: Int) {",
    "  fun create(): Gadget = this",
    "}",
    "fun use(): Widget = Widget.create()",
  ]),
};

const h3 = {
  "w.kt": src([
    "class Widget(val id: Int)",
    "class Gadget(val id: Int) {",
    '  fun describe(): String = "gadget"',
    "}",
    'fun Widget.describe(): String = "widget"',
    "fun use(): String {",
    "  val w = Widget(0)",
    "  return w.describe()",
    "}",
  ]),
};

const h14 = {
  "G.kt": src([
    "class Gadget(val name: String) {",
    '  fun describe(): String = "x:" + name',
    "}",
    "class Other {",
    '  fun describe(): String = "other"',
    "}",
    "fun use() {",
    '  val g = Gadget("y")',
    "  g.describe()",
    "}",
  ]),
};

const w12 = {
  "Base.php": src(["<?php", "namespace Acme\\App;", "", "class Base", "{", "}"]),
  "Other.php": src(["<?php", "namespace Other\\Ns;", "", "class Base", "{", "}"]),
  "Worker.php": src(["<?php", "namespace Acme\\App;", "", "class Worker extends Base", "{", "}"]),
};

const h8 = {
  "box.php": src([
    "<?php",
    "class ParentDecoy {}",
    "class Base {",
    "  function __construct() {}",
    "}",
    "class Child extends Base {",
    "  function makeSelf() { return new self(); }",
    "}",
  ]),
  "decoy.php": src(["<?php", "class Child {", "  function makeSelf() { return new self(); }", "}"]),
};

const h9 = {
  "box.php": src([
    "<?php",
    "class Box {",
    "  function read() { return $this->x; }",
    "  function __construct(public int $x) {}",
    "}",
    "class Other {",
    "  public $x;",
    "  function read() { return $this->x; }",
    "}",
  ]),
};

const w14 = {
  "pkg/__init__.py": "from .widget import Widget",
  "pkg/widget.py": src(["class Widget:", "    def render(self):", "        return 1"]),
  "decoy_pkg/widget.py": src(["class Widget:", "    def render(self):", "        return 999"]),
  "main.py": src(["from pkg import Widget as W", "", "W().render()"]),
};

const w15 = {
  "pkg/__init__.py": "",
  "pkg/mod.py": src(["def foo():", "    return 42"]),
  "other.py": src(["def foo():", "    return -1"]),
  "main.py": src(["import pkg.mod", "", "def run():", "    return pkg.mod.foo()"]),
};

const w17 = {
  "zzz.py": src(["def helper():", "    return 1"]),
  "aaa.py": src(["def helper():", "    return 2"]),
  "decoy.py": src(["def helper():", "    return 9"]),
  "main.py": src(["from zzz import *", "from aaa import *", "", "def run():", "    helper()"]),
};

const h11 = {
  "a.py": src(["def helper():", "    return 1"]),
  "decoy.py": src(["def helper():", "    return -1"]),
  "b.py": src(["from a import helper as h", "", "def run():", "    return h()"]),
};

const h12 = {
  "unrelated.py": src(["class Unrelated:", "    def greet(self):", "        return 99"]),
  "base.py": src(["class Base:", "    def greet(self):", "        return 1"]),
  "derived.py": src([
    "from base import Base",
    "",
    "class Derived(Base):",
    "    def greet(self):",
    "        return super().greet()",
  ]),
};

const w13 = {
  "widget.rb": src(["class Widget", "  def render", "  end", "end"]),
  "decoy.rb": src(["class Widget", "  def render", "  end", "end"]),
  "use.rb": src(['require_relative "widget"', "def run", "  w = Widget.new", "  w.render", "end"]),
};

const w18 = {
  "outer.rb": src(["module Outer", "  class Base", "  end", "end"]),
  "real_base.rb": src(["class Base", "end"]),
  "worker.rb": src(['require_relative "outer"', 'require_relative "real_base"', "class Worker < Base", "end"]),
};

const g4 = {
  "ruby_base.rb": src(["class RubyBase", "end"]),
  "decoy_base.rb": src(["class RubyBase", "end"]),
  "ruby_worker.rb": src(['require_relative "ruby_base"', "class RubyWorker < RubyBase", "end"]),
};

const h10 = {
  "blocks.rb": src(["def run", "  item = 1", "  [1, 2].each do |item|", "    item", "  end", "end"]),
  "decoy.rb": src(["def other", "  item = 2", "end"]),
};

const rustPackage = '[package]\nname = "demo"\nversion = "0.1.0"\n';

const w7 = {
  "Cargo.toml": rustPackage,
  "src/lib.rs": src([
    "pub struct Circle { pub radius: f64 }",
    "pub mod util {",
    "    pub fn square_radius(c: &super::Circle) -> f64 { c.radius }",
    "}",
    "pub mod decoy;",
  ]),
  "src/decoy.rs": "pub struct Circle { pub radius: f64 }",
};

const w8 = {
  "Cargo.toml": '[workspace]\nmembers = ["crate_a", "crate_b", "crate_c"]\n',
  "crate_a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n',
  "crate_a/src/lib.rs": 'pub fn greet() -> &\'static str { "hi" }\n',
  "crate_b/Cargo.toml":
    '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { path = "../crate_a" }\n',
  "crate_b/src/main.rs": 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n',
  "crate_c/Cargo.toml": '[package]\nname = "crate_c"\nversion = "0.1.0"\n',
  "crate_c/src/lib.rs": 'pub fn greet() -> &\'static str { "decoy" }\n',
};

const g7 = {
  "Cargo.toml": rustPackage,
  "src/lib.rs": src([
    "pub struct Circle { pub radius: f64 }",
    "pub struct Square { pub side: f64 }",
    "impl Circle {",
    "    pub fn area(&self) -> f64 { self.radius * self.radius }",
    "}",
    "impl Square {",
    "    pub fn area(&self) -> f64 { self.side * self.side }",
    "}",
    "pub fn total(c: &Circle) -> f64 { c.area() }",
  ]),
};

const h13 = {
  "Cargo.toml": rustPackage,
  "src/lib.rs": src(["pub mod geometry;", "pub mod decoy;", "pub mod consumer;"]),
  "src/geometry.rs": src(["pub mod util {", "    pub fn square(x: f64) -> f64 { x * x }", "}"]),
  "src/decoy.rs": "pub fn square(x: f64) -> f64 { x + x }",
  "src/consumer.rs": src(["use crate::geometry::util::*;", "pub fn run() -> f64 {", "    square(3.0)", "}"]),
};

const h15 = {
  "Cargo.toml":
    '[workspace]\nmembers = ["crate_a", "crate_b", "crate_c"]\n\n[workspace.dependencies]\ncrate_a = { path = "crate_a" }\n',
  "crate_a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n',
  "crate_a/src/lib.rs": 'pub fn greet() -> &\'static str { "hi" }\n',
  "crate_b/Cargo.toml":
    '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { workspace = true }\n',
  "crate_b/src/main.rs": 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n',
  "crate_c/Cargo.toml": '[package]\nname = "crate_c"\nversion = "0.1.0"\n',
  "crate_c/src/lib.rs": 'pub fn greet() -> &\'static str { "decoy" }\n',
};

const w6 = {
  "Widget.swift": src([
    "class Widget {",
    "    let name: String",
    "    init(name: String) {",
    "        self.name = name",
    "    }",
    "}",
    "class Other {",
    "    let name: String",
    "    init(name: String) {",
    "        self.name = name",
    "    }",
    "}",
  ]),
};

const w1 = {
  "fmt.ts": src([
    "export function format(value: string): string;",
    "export function format(value: number): string;",
    "export function format(value: string | number): string { return String(value); }",
  ]),
  "decoy.ts": "export function format(value: string): string { return value; }",
  "use.ts": src(['import { format } from "./fmt";', 'export function run(): string { return format("hi"); }']),
};

const w2 = {
  "widget.ts": src([
    "export default class Widget {",
    "  static create(): Widget { return new Widget(); }",
    '  render(): string { return "w"; }',
    "}",
  ]),
  "decoy.ts": src([
    "export class Widget {",
    "  static create(): Widget { return new Widget(); }",
    '  render(): string { return "d"; }',
    "}",
  ]),
  "use.ts": src(['import Widget from "./widget";', "export function run(): string {", "  return new Widget().render();", "}"]),
};

const w4 = {
  "lazy.ts": 'export function thing(): string { return "lazy"; }',
  "decoy.ts": 'export function thing(): string { return "decoy"; }',
  "use.ts": src([
    "export async function run(): Promise<string> {",
    '  const mod = await import("./lazy");',
    "  return mod.thing();",
    "}",
  ]),
};

const g5 = {
  "box.ts": src(["export class Box {", "  static create(): Box { return new Box(); }", "}"]),
  "decoy.ts": src(["export class Box {", '  static create(): string { return "decoy"; }', "}"]),
  "use.ts": src(['import { Box } from "./box";', "export function run(): Box {", "  return Box.create();", "}"]),
};

const h1 = {
  "status.ts": src(["export enum Status {", "  Active,", "  Inactive,", "}"]),
  "decoy.ts": src(["export enum Status {", "  Active,", "}"]),
  "use.ts": src([
    'import { Status } from "./status";',
    "export function withParam(s: Status): Status {",
    "  return Status.Active;",
    "}",
  ]),
};

const w16 = {
  "shapes.zig": src([
    "pub const Circle = struct {",
    "    radius: f64,",
    "    pub fn area(self: Circle) f64 { return self.radius * self.radius; }",
    "    pub fn describe(self: Circle) f64 { return self.area() * 2.0; }",
    "};",
  ]),
  "decoy.zig": src([
    "pub const Square = struct {",
    "    side: f64,",
    "    pub fn area(self: Square) f64 { return self.side * self.side; }",
    "};",
  ]),
};

function useRow(
  id: string,
  language: string,
  files: Readonly<Record<string, string>>,
  site: TokenAt,
  expected: AgreementRow["expected"],
  edge?: AgreementRow["edge"],
  extra?: Pick<AgreementRow, "declaration" | "provenNonReference" | "fails">,
): AgreementRow {
  return {
    id,
    language,
    role: "use",
    files,
    site,
    expected,
    ...(edge ? { edge } : {}),
    ...(extra?.declaration ? { declaration: extra.declaration } : {}),
    ...(extra?.provenNonReference ? { provenNonReference: extra.provenNonReference } : {}),
    ...(extra?.fails ? { fails: extra.fails } : {}),
  };
}

function decoyRow(
  id: string,
  language: string,
  files: Readonly<Record<string, string>>,
  site: TokenAt,
  declaration: TokenAt,
  reason: string,
  edge?: AgreementRow["edge"],
): AgreementRow {
  return {
    id,
    language,
    role: "decoy",
    files,
    site,
    expected: { file: declaration.file, line: declaration.line },
    declaration,
    provenNonReference: reason,
    ...(edge ? { edge } : {}),
  };
}

const calls = (fromFile: string, fromName: string): AgreementRow["edge"] => ({
  label: "calls",
  fromFile,
  fromName,
});

/** Imported `use` bindings are recorded as `uses`, not `calls`. */
const uses = (fromFile: string, fromName: string): AgreementRow["edge"] => ({
  label: "uses",
  fromFile,
  fromName,
});

const rows: AgreementRow[] = [
  useRow("W9", "C", w9, { file: "run.c", line: 3, token: "compute" }, { file: "util.h", line: 3 }, calls("run.c", "run")),
  decoyRow(
    "W9",
    "C",
    w9,
    { file: "run.c", line: 3, token: "compute" },
    { file: "extra.c", line: 1, token: "compute" },
    // run.c includes util.h, and the call resolves to that prototype.
    "no include connects run.c to extra.c; the call resolves to util.h",
    calls("run.c", "run"),
  ),

  useRow(
    "W10",
    "C++",
    w10,
    { file: "main.cpp", line: 4, token: "add" },
    { file: "tools.hpp", line: 2 },
    calls("main.cpp", "main"),
  ),
  decoyRow(
    "W10",
    "C++",
    w10,
    { file: "main.cpp", line: 4, token: "add" },
    { file: "tools.hpp", line: 6, token: "add" },
    "using namespace tools does not open namespace unused",
    calls("main.cpp", "main"),
  ),
  useRow(
    "H7",
    "C++",
    h7,
    { file: "use.cpp", line: 4, token: "run" },
    { file: "box.hpp", line: 3 },
    calls("use.cpp", "callWithLocal"),
  ),
  decoyRow(
    "H7",
    "C++",
    h7,
    { file: "use.cpp", line: 4, token: "run" },
    { file: "widget.hpp", line: 3, token: "run" },
    "the local is declared Box, not Widget",
    calls("use.cpp", "callWithLocal"),
  ),

  useRow("H4", "C#", h4, { file: "n.cs", line: 9, token: "Value" }, { file: "n.cs", line: 3 }, calls("n.cs", "Use")),
  decoyRow(
    "H4",
    "C#",
    h4,
    { file: "n.cs", line: 9, token: "Value" },
    { file: "other.cs", line: 3, token: "Value" },
    "the constructed local is Outer.Inner, not Other.Nested",
    calls("n.cs", "Use"),
  ),
  useRow("H5", "C#", h5, { file: "pt.cs", line: 11, token: "Sum" }, { file: "pt.cs", line: 4 }, calls("pt.cs", "Use")),
  decoyRow(
    "H5",
    "C#",
    h5,
    { file: "pt.cs", line: 11, token: "Sum" },
    { file: "other.cs", line: 3, token: "Sum" },
    "using PT = N.Point names N.Point, not N2.Other",
    calls("pt.cs", "Use"),
  ),

  useRow(
    "G3",
    "Go",
    g3,
    { file: "main/main.go", line: 6, token: "Square" },
    { file: "util/util.go", line: 3 },
    calls("main/main.go", "main"),
  ),
  decoyRow(
    "G3",
    "Go",
    g3,
    { file: "main/main.go", line: 6, token: "Square" },
    { file: "other/other.go", line: 3, token: "Square" },
    "import u is example.com/proj/util, not package other",
    calls("main/main.go", "main"),
  ),
  // Go rejects an unexported name from another package, so the call is a proven non-reference
  // of util.hidden and must not be recorded as a calls edge.
  useRow(
    "W11",
    "Go",
    w11,
    { file: "main/main.go", line: 6, token: "hidden" },
    "not_found",
    calls("main/main.go", "main"),
    {
      declaration: { file: "util/util.go", line: 3, token: "hidden" },
      provenNonReference: "Go rejects an unexported name used from another package",
    },
  ),
  decoyRow(
    "W11",
    "Go",
    w11,
    { file: "main/main.go", line: 6, token: "hidden" },
    { file: "other/other.go", line: 3, token: "hidden" },
    "the selector is u.hidden, and u is package util, not other",
    calls("main/main.go", "main"),
  ),

  useRow(
    "W5",
    "Java",
    w5,
    { file: "p/Bar.java", line: 5, token: "hello" },
    { file: "p/Foo.java", line: 4 },
    calls("p/Bar.java", "direct"),
  ),
  decoyRow(
    "W5",
    "Java",
    w5,
    { file: "p/Bar.java", line: 5, token: "hello" },
    { file: "q/Foo.java", line: 4, token: "hello" },
    "Bar and Foo share package p; package q is not in scope",
    calls("p/Bar.java", "direct"),
  ),
  useRow(
    "H6",
    "Java",
    h6,
    { file: "b/User.java", line: 4, token: "hello" },
    { file: "a/Greeter.java", line: 3 },
    calls("b/User.java", "use"),
  ),
  decoyRow(
    "H6",
    "Java",
    h6,
    { file: "b/User.java", line: 4, token: "hello" },
    { file: "decoy/Greeter.java", line: 3, token: "hello" },
    "the parameter type is the imported a.Greeter, not package decoy",
    calls("b/User.java", "use"),
  ),

  useRow("W3", "JavaScript", w3, { file: "use.js", line: 2, token: "helper" }, { file: "util.js", line: 1 }, calls("use.js", "run")),
  decoyRow(
    "W3",
    "JavaScript",
    w3,
    { file: "use.js", line: 2, token: "helper" },
    { file: "decoy.js", line: 1, token: "helper", occurrence: 2 },
    "require('./util') does not bind ./decoy",
    calls("use.js", "run"),
  ),

  // Box resolves to a class whose companion scope has no instanceHelper, so the invalid
  // type-name call is a proven non-reference and must not produce a calls edge.
  useRow(
    "W20",
    "Kotlin",
    w20,
    { file: "Box.kt", line: 15, token: "instanceHelper" },
    "not_found",
    calls("Box.kt", "useInvalid"),
    {
      declaration: { file: "Box.kt", line: 4, token: "instanceHelper" },
      provenNonReference: "Box's companion scope has no instanceHelper, so the type-name call is rejected",
    },
  ),
  decoyRow(
    "W20",
    "Kotlin",
    w20,
    { file: "Box.kt", line: 15, token: "instanceHelper" },
    { file: "Box.kt", line: 11, token: "instanceHelper" },
    "the receiver is class Box, not class Decoy",
    calls("Box.kt", "useInvalid"),
  ),
  useRow("H2", "Kotlin", h2, { file: "w.kt", line: 9, token: "create" }, { file: "w.kt", line: 3 }, calls("w.kt", "use")),
  decoyRow(
    "H2",
    "Kotlin",
    h2,
    { file: "w.kt", line: 9, token: "create" },
    { file: "w.kt", line: 7, token: "create" },
    "Widget.create() is the companion factory, not Gadget's instance method",
    calls("w.kt", "use"),
  ),
  // The call is in the reference list, but coverage stays partial: an applicable reference
  // strategy never runs (strategy_unavailable). Goto still resolves the extension.
  useRow(
    "H3",
    "Kotlin",
    h3,
    { file: "w.kt", line: 8, token: "describe" },
    { file: "w.kt", line: 5 },
    calls("w.kt", "use"),
    {
      fails:
        "extension call is listed by findReferences, but coverage stays partial (strategy_unavailable) instead of complete",
    },
  ),
  decoyRow(
    "H3",
    "Kotlin",
    h3,
    { file: "w.kt", line: 8, token: "describe" },
    { file: "w.kt", line: 3, token: "describe" },
    "w is a Widget, so the call is the extension, not Gadget.describe",
    calls("w.kt", "use"),
  ),
  useRow("H14", "Kotlin", h14, { file: "G.kt", line: 9, token: "describe" }, { file: "G.kt", line: 2 }, calls("G.kt", "use")),
  decoyRow(
    "H14",
    "Kotlin",
    h14,
    { file: "G.kt", line: 9, token: "describe" },
    { file: "G.kt", line: 5, token: "describe" },
    "g is a Gadget, not Other",
    calls("G.kt", "use"),
  ),

  useRow(
    "W12",
    "PHP",
    w12,
    { file: "Worker.php", line: 4, token: "Base" },
    { file: "Base.php", line: 4 },
    { label: "extends", fromFile: "Worker.php", fromName: "Worker" },
  ),
  decoyRow(
    "W12",
    "PHP",
    w12,
    { file: "Worker.php", line: 4, token: "Base" },
    { file: "Other.php", line: 4, token: "Base" },
    "Worker is in Acme\\App; Other\\Ns\\Base is a different namespace",
    { label: "extends", fromFile: "Worker.php", fromName: "Worker" },
  ),
  // new self() resolves to Child and the instantiates edge is recorded, but the class's
  // reference list does not contain the self keyword.
  useRow(
    "H8",
    "PHP",
    h8,
    { file: "box.php", line: 7, token: "self" },
    { file: "box.php", line: 6 },
    { label: "instantiates", fromFile: "box.php", fromName: "makeSelf" },
    {
      fails: "goToDefinition resolves new self() to Child, but findReferences(Child) omits the self keyword",
    },
  ),
  decoyRow(
    "H8",
    "PHP",
    h8,
    { file: "box.php", line: 7, token: "self" },
    { file: "decoy.php", line: 2, token: "Child" },
    "new self() binds the enclosing class in box.php, not the other file's Child",
    { label: "instantiates", fromFile: "box.php", fromName: "makeSelf" },
  ),
  useRow("H9", "PHP", h9, { file: "box.php", line: 3, token: "x" }, { file: "box.php", line: 4 }),
  decoyRow(
    "H9",
    "PHP",
    h9,
    { file: "box.php", line: 3, token: "x" },
    { file: "box.php", line: 7, token: "$x" },
    "$this inside Box reads Box's promoted property, not Other::$x",
  ),

  useRow("W14", "Python", w14, { file: "main.py", line: 3, token: "W" }, { file: "pkg/widget.py", line: 1 }),
  decoyRow(
    "W14",
    "Python",
    w14,
    { file: "main.py", line: 3, token: "W" },
    { file: "decoy_pkg/widget.py", line: 1, token: "Widget" },
    "from pkg import Widget binds pkg.widget.Widget, not decoy_pkg",
  ),
  useRow(
    "W15",
    "Python",
    w15,
    { file: "main.py", line: 4, token: "foo" },
    { file: "pkg/mod.py", line: 1 },
    calls("main.py", "run"),
  ),
  decoyRow(
    "W15",
    "Python",
    w15,
    { file: "main.py", line: 4, token: "foo" },
    { file: "other.py", line: 1, token: "foo" },
    "import pkg.mod does not bind other.py",
    calls("main.py", "run"),
  ),
  useRow(
    "W17",
    "Python",
    w17,
    { file: "main.py", line: 5, token: "helper" },
    { file: "aaa.py", line: 1 },
    calls("main.py", "run"),
  ),
  decoyRow(
    "W17",
    "Python",
    w17,
    { file: "main.py", line: 5, token: "helper" },
    { file: "decoy.py", line: 1, token: "helper" },
    "decoy.py is never star-imported; the later import rebinds helper to aaa",
    calls("main.py", "run"),
  ),
  useRow("H11", "Python", h11, { file: "b.py", line: 1, token: "helper" }, { file: "a.py", line: 1 }),
  decoyRow(
    "H11",
    "Python",
    h11,
    { file: "b.py", line: 1, token: "helper" },
    { file: "decoy.py", line: 1, token: "helper" },
    "from a import helper names module a, not decoy",
  ),
  useRow(
    "H12",
    "Python",
    h12,
    { file: "derived.py", line: 5, token: "greet" },
    { file: "base.py", line: 2 },
    calls("derived.py", "greet"),
  ),
  decoyRow(
    "H12",
    "Python",
    h12,
    { file: "derived.py", line: 5, token: "greet" },
    { file: "unrelated.py", line: 2, token: "greet" },
    "Derived's base is Base, not Unrelated",
    calls("derived.py", "greet"),
  ),

  useRow(
    "W13",
    "Ruby",
    w13,
    { file: "use.rb", line: 4, token: "render" },
    { file: "widget.rb", line: 2 },
    calls("use.rb", "run"),
  ),
  decoyRow(
    "W13",
    "Ruby",
    w13,
    { file: "use.rb", line: 4, token: "render" },
    { file: "decoy.rb", line: 2, token: "render" },
    "use.rb requires widget.rb, not the unrequired decoy",
    calls("use.rb", "run"),
  ),
  useRow(
    "W18",
    "Ruby",
    w18,
    { file: "worker.rb", line: 3, token: "Base" },
    { file: "real_base.rb", line: 1 },
    { label: "extends", fromFile: "worker.rb", fromName: "Worker" },
  ),
  decoyRow(
    "W18",
    "Ruby",
    w18,
    { file: "worker.rb", line: 3, token: "Base" },
    { file: "outer.rb", line: 2, token: "Base" },
    "Outer::Base is nested and is not the bare constant real_base.rb exports",
    { label: "extends", fromFile: "worker.rb", fromName: "Worker" },
  ),
  useRow(
    "G4",
    "Ruby",
    g4,
    { file: "ruby_worker.rb", line: 2, token: "RubyBase" },
    { file: "ruby_base.rb", line: 1 },
    { label: "extends", fromFile: "ruby_worker.rb", fromName: "RubyWorker" },
  ),
  decoyRow(
    "G4",
    "Ruby",
    g4,
    { file: "ruby_worker.rb", line: 2, token: "RubyBase" },
    { file: "decoy_base.rb", line: 1, token: "RubyBase" },
    "ruby_worker.rb requires ruby_base.rb, not decoy_base.rb",
    { label: "extends", fromFile: "ruby_worker.rb", fromName: "RubyWorker" },
  ),
  useRow("H10", "Ruby", h10, { file: "blocks.rb", line: 4, token: "item" }, { file: "blocks.rb", line: 3 }),
  decoyRow(
    "H10",
    "Ruby",
    h10,
    { file: "blocks.rb", line: 4, token: "item" },
    { file: "decoy.rb", line: 2, token: "item" },
    "the block parameter is lexical to blocks.rb; decoy.rb's item is a different binding",
  ),

  useRow("W7", "Rust", w7, { file: "src/lib.rs", line: 3, token: "Circle" }, { file: "src/lib.rs", line: 1 }),
  decoyRow(
    "W7",
    "Rust",
    w7,
    { file: "src/lib.rs", line: 3, token: "Circle" },
    { file: "src/decoy.rs", line: 1, token: "Circle" },
    "super::Circle is the parent module's struct, not decoy::Circle",
  ),
  useRow(
    "W8",
    "Rust",
    w8,
    { file: "crate_b/src/main.rs", line: 2, token: "greet" },
    { file: "crate_a/src/lib.rs", line: 1 },
    uses("crate_b/src/main.rs", "main"),
  ),
  decoyRow(
    "W8",
    "Rust",
    w8,
    { file: "crate_b/src/main.rs", line: 2, token: "greet" },
    { file: "crate_c/src/lib.rs", line: 1, token: "greet" },
    "crate_b depends on crate_a by path, not on crate_c",
    uses("crate_b/src/main.rs", "main"),
  ),
  useRow(
    "G7",
    "Rust",
    g7,
    { file: "src/lib.rs", line: 9, token: "area" },
    { file: "src/lib.rs", line: 4 },
    calls("src/lib.rs", "total"),
  ),
  decoyRow(
    "G7",
    "Rust",
    g7,
    { file: "src/lib.rs", line: 9, token: "area" },
    { file: "src/lib.rs", line: 7, token: "area" },
    "the parameter type is Circle, not Square",
    calls("src/lib.rs", "total"),
  ),
  useRow(
    "H13",
    "Rust",
    h13,
    { file: "src/consumer.rs", line: 3, token: "square" },
    { file: "src/geometry.rs", line: 2 },
    calls("src/consumer.rs", "run"),
  ),
  decoyRow(
    "H13",
    "Rust",
    h13,
    { file: "src/consumer.rs", line: 3, token: "square" },
    { file: "src/decoy.rs", line: 1, token: "square" },
    "use crate::geometry::util::* does not import crate::decoy::square",
    calls("src/consumer.rs", "run"),
  ),
  useRow(
    "H15",
    "Rust",
    h15,
    { file: "crate_b/src/main.rs", line: 2, token: "greet" },
    { file: "crate_a/src/lib.rs", line: 1 },
    uses("crate_b/src/main.rs", "main"),
  ),
  decoyRow(
    "H15",
    "Rust",
    h15,
    { file: "crate_b/src/main.rs", line: 2, token: "greet" },
    { file: "crate_c/src/lib.rs", line: 1, token: "greet" },
    "workspace = true inherits crate_a's path, not crate_c",
    uses("crate_b/src/main.rs", "main"),
  ),

  useRow(
    "W6",
    "Swift",
    w6,
    { file: "Widget.swift", line: 4, token: "name", occurrence: 1 },
    { file: "Widget.swift", line: 2 },
  ),
  decoyRow(
    "W6",
    "Swift",
    w6,
    { file: "Widget.swift", line: 4, token: "name", occurrence: 1 },
    { file: "Widget.swift", line: 8, token: "name" },
    "self in Widget.init is Widget, not Other",
  ),

  useRow(
    "W1",
    "TypeScript",
    w1,
    { file: "use.ts", line: 2, token: "format" },
    { file: "fmt.ts", line: 3 },
    calls("use.ts", "run"),
  ),
  decoyRow(
    "W1",
    "TypeScript",
    w1,
    { file: "use.ts", line: 2, token: "format" },
    { file: "decoy.ts", line: 1, token: "format" },
    "import { format } from './fmt' does not bind decoy.ts",
    calls("use.ts", "run"),
  ),
  useRow(
    "W2",
    "TypeScript",
    w2,
    { file: "use.ts", line: 3, token: "render" },
    { file: "widget.ts", line: 3 },
    calls("use.ts", "run"),
  ),
  decoyRow(
    "W2",
    "TypeScript",
    w2,
    { file: "use.ts", line: 3, token: "render" },
    { file: "decoy.ts", line: 3, token: "render" },
    "the default import binds ./widget, not ./decoy",
    calls("use.ts", "run"),
  ),
  useRow(
    "W4",
    "TypeScript",
    w4,
    { file: "use.ts", line: 3, token: "thing" },
    { file: "lazy.ts", line: 1 },
    calls("use.ts", "run"),
  ),
  decoyRow(
    "W4",
    "TypeScript",
    w4,
    { file: "use.ts", line: 3, token: "thing" },
    { file: "decoy.ts", line: 1, token: "thing" },
    "import('./lazy') does not bind ./decoy",
    calls("use.ts", "run"),
  ),
  useRow(
    "G5",
    "TypeScript",
    g5,
    { file: "use.ts", line: 3, token: "create" },
    { file: "box.ts", line: 2 },
    calls("use.ts", "run"),
  ),
  decoyRow(
    "G5",
    "TypeScript",
    g5,
    { file: "use.ts", line: 3, token: "create" },
    { file: "decoy.ts", line: 2, token: "create" },
    "import { Box } from './box' does not bind ./decoy",
    calls("use.ts", "run"),
  ),
  useRow("H1", "TypeScript", h1, { file: "use.ts", line: 3, token: "Active" }, { file: "status.ts", line: 2 }),
  decoyRow(
    "H1",
    "TypeScript",
    h1,
    { file: "use.ts", line: 3, token: "Active" },
    { file: "decoy.ts", line: 2, token: "Active" },
    "import { Status } from './status' does not bind ./decoy",
  ),

  useRow(
    "W16",
    "Zig",
    w16,
    { file: "shapes.zig", line: 4, token: "area" },
    { file: "shapes.zig", line: 3 },
    calls("shapes.zig", "describe"),
  ),
  decoyRow(
    "W16",
    "Zig",
    w16,
    { file: "shapes.zig", line: 4, token: "area" },
    { file: "decoy.zig", line: 3, token: "area" },
    "self in Circle.describe is Circle, not Square",
    calls("shapes.zig", "describe"),
  ),
];

const languages: string[] = [];
for (const row of rows) {
  if (!languages.includes(row.language)) languages.push(row.language);
}

suite("cross-consumer agreement", () => {
  for (const language of languages) {
    const languageRows = rows.filter((row) => row.language === language);
    describe(language, () => {
      it.each(languageRows.filter((row) => !row.fails))("$id $role", async (row) => {
        await runAgreementRow(row);
      });
      const disagreements = languageRows.filter((row) => row.fails);
      if (disagreements.length > 0) {
        it.fails.each(disagreements)("$id $role ($fails)", async (row) => {
          await runAgreementRow(row);
        });
      }
    });
  }
});
