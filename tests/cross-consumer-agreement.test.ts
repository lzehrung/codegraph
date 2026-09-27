/**
 * Every navigation fixture from the 2026-09-25 accuracy checklist
 * (docs/plans/audit-2026-09-25-checklist.md) runs through `goToDefinition`, `findReferences`, and
 * `buildSymbolGraphDetailed` together. Declaration-order cases live in
 * declaration-order-visibility.test.ts, and cache and agent API cases in their own files.
 *
 * One `it.each` table per language. A scenario is two rows that share a fixture:
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
  /**
   * Keyword receiver (`self`, `static`, `this`, `$this`). Goto and edges stay; the class's
   * references omit the keyword and coverage is complete.
   */
  keywordReceiver?: boolean;
};

function address(token: TokenAt): TokenAt {
  return {
    file: token.file,
    line: token.line,
    token: token.token,
    ...(token.occurrence !== undefined ? { occurrence: token.occurrence } : {}),
  };
}

// One build per fixture object: several rows (use and decoy, or two cases with one id) share it.
const built = new Map<Readonly<Record<string, string>>, Promise<ConsumerAgreementFixture>>();

function loadFixture(row: AgreementRow): Promise<ConsumerAgreementFixture> {
  const existing = built.get(row.files);
  if (existing) return existing;
  const pending = buildConsumerAgreementFixture(`cg-agree-${row.id}-`, row.files);
  built.set(row.files, pending);
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
    ...(row.keywordReceiver ? { keywordReceiver: true } : {}),
    ...(row.edge
      ? { edges: [{ label: row.edge.label, from: { file: row.edge.fromFile, name: row.edge.fromName } }] }
      : {}),
  };
  await assertConsumerAgreement(fixture, resolved);
}

const cPrototypeAndDefinition = {
  "util.h": src(["#ifndef UTIL_H", "#define UTIL_H", "int compute(void);", "#endif"]),
  "util.c": src(['#include "util.h"', "int compute(void) { return 1; }"]),
  "extra.c": src(["int compute(void) { return 0; }"]),
  "run.c": src(['#include "util.h"', "int run(void) {", "  return compute();", "}"]),
};

const cppUsingNamespace = {
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

const cppTypedLocalReceiver = {
  "box.hpp": src(["class Box {", "public:", "  int run();", "};"]),
  "box.cpp": src(['#include "box.hpp"', "int Box::run() { return 1; }"]),
  "widget.hpp": src(["class Widget {", "public:", "  int run();", "};"]),
  "use.cpp": src(['#include "box.hpp"', "int callWithLocal() {", "  Box b;", "  return b.run();", "}"]),
};

const csharpConstructedLocal = {
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

const csharpTypeAlias = {
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

const goUnexportedCrossPackage = {
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

const goQualifiedCall = {
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

const samePackageCall = {
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

const typedParameterReceiver = {
  "a/Greeter.java": src(["package a;", "public class Greeter {", '  public String hello() { return "hi"; }', "}"]),
  "b/User.java": src([
    "package b;",
    "import a.Greeter;",
    "public class User {",
    "  public String use(Greeter g) { return g.hello(); }",
    "}",
  ]),
  "decoy/Greeter.java": src([
    "package decoy;",
    "public class Greeter {",
    '  public String hello() { return "no"; }',
    "}",
  ]),
};

const requireModuleMember = {
  "util.js": "exports.helper = function helper() { return 1; };",
  "decoy.js": "exports.helper = function helper() { return 2; };",
  "use.js": src(["const util = require('./util');", "function run() { return util.helper(); }"]),
};

const kotlinTypeNameInstanceCall = {
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

const kotlinCompanionFactory = {
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

const kotlinExtensionFunction = {
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

const kotlinExplicitImport = {
  "app/Foo.kt": src(["package app", "class Foo"]),
  "other/Foo.kt": src(["package other", "class Foo"]),
  "app/Use.kt": src(["package app", "import other.Foo", "fun use() = Foo()"]),
};

/** Valid C++ picks `f(int)` for `f(1)` by parameter type; codegraph does not rank overloads. */
const cppAmbiguousOverload = {
  "api.hpp": src(["int f(int a);", "int f(double a);"]),
  "use.cpp": src(['#include "api.hpp"', "int g() { return f(1); }", "int h() { return f(1.5); }"]),
};

const kotlinConstructorProperty = {
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

const phpSameNamespacePeers = {
  "Base.php": src(["<?php", "namespace Acme\\App;", "", "class Base", "{", "}"]),
  "Other.php": src(["<?php", "namespace Other\\Ns;", "", "class Base", "{", "}"]),
  "Worker.php": src(["<?php", "namespace Acme\\App;", "", "class Worker extends Base", "{", "}"]),
};

const phpNewSelf = {
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

const phpPromotedProperty = {
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

const pythonClassNamedLikeModule = {
  "pkg/__init__.py": "from .widget import Widget",
  "pkg/widget.py": src(["class Widget:", "    def render(self):", "        return 1"]),
  "decoy_pkg/widget.py": src(["class Widget:", "    def render(self):", "        return 999"]),
  "main.py": src(["from pkg import Widget as W", "", "W().render()"]),
};

const pythonDottedModuleImport = {
  "pkg/__init__.py": "",
  "pkg/mod.py": src(["def foo():", "    return 42"]),
  "other.py": src(["def foo():", "    return -1"]),
  "main.py": src(["import pkg.mod", "", "def run():", "    return pkg.mod.foo()"]),
};

/** The receiver `X` follows the same last-star rule as a bare name. */
const w17Receiver = {
  "a.py": src(["class X:", "    @staticmethod", "    def m():", "        return 1"]),
  "b.py": src(["class X:", "    @staticmethod", "    def m():", "        return 2"]),
  "main.py": src(["from a import *", "from b import *", "", "def run():", "    return X.m()"]),
};

const starImportCollision = {
  "zzz.py": src(["def helper():", "    return 1"]),
  "aaa.py": src(["def helper():", "    return 2"]),
  "decoy.py": src(["def helper():", "    return 9"]),
  "main.py": src(["from zzz import *", "from aaa import *", "", "def run():", "    helper()"]),
};

const pythonAliasedImportSource = {
  "a.py": src(["def helper():", "    return 1"]),
  "decoy.py": src(["def helper():", "    return -1"]),
  "b.py": src(["from a import helper as h", "", "def run():", "    return h()"]),
};

const superThroughProvenBase = {
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

const rubyCrossFileNew = {
  "widget.rb": src(["class Widget", "  def render", "  end", "end"]),
  "decoy.rb": src(["class Widget", "  def render", "  end", "end"]),
  "use.rb": src(['require_relative "widget"', "def run", "  w = Widget.new", "  w.render", "end"]),
};

const rubyNestedClassExport = {
  "outer.rb": src(["module Outer", "  class Base", "  end", "end"]),
  "real_base.rb": src(["class Base", "end"]),
  "worker.rb": src(['require_relative "outer"', 'require_relative "real_base"', "class Worker < Base", "end"]),
};

const rubyCrossFileInheritance = {
  "ruby_base.rb": src(["class RubyBase", "end"]),
  "decoy_base.rb": src(["class RubyBase", "end"]),
  "ruby_worker.rb": src(['require_relative "ruby_base"', "class RubyWorker < RubyBase", "end"]),
};

const rubyBlockParameter = {
  "blocks.rb": src(["def run", "  item = 1", "  [1, 2].each do |item|", "    item", "  end", "end"]),
  "decoy.rb": src(["def other", "  item = 2", "end"]),
};

const rustPackage = '[package]\nname = "demo"\nversion = "0.1.0"\n';

const rustSuperType = {
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

const rustWorkspacePathDependency = {
  "Cargo.toml": '[workspace]\nmembers = ["crate_a", "crate_b", "crate_c"]\n',
  "crate_a/Cargo.toml": '[package]\nname = "crate_a"\nversion = "0.1.0"\n',
  "crate_a/src/lib.rs": 'pub fn greet() -> &\'static str { "hi" }\n',
  "crate_b/Cargo.toml":
    '[package]\nname = "crate_b"\nversion = "0.1.0"\n[dependencies]\ncrate_a = { path = "../crate_a" }\n',
  "crate_b/src/main.rs": 'use crate_a::greet;\nfn main() { println!("{}", greet()); }\n',
  "crate_c/Cargo.toml": '[package]\nname = "crate_c"\nversion = "0.1.0"\n',
  "crate_c/src/lib.rs": 'pub fn greet() -> &\'static str { "decoy" }\n',
};

const rustImplMethod = {
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

const rustZigGlobAndStructLiteral = {
  "Cargo.toml": rustPackage,
  "src/lib.rs": src(["pub mod geometry;", "pub mod decoy;", "pub mod consumer;"]),
  "src/geometry.rs": src(["pub mod util {", "    pub fn square(x: f64) -> f64 { x * x }", "}"]),
  "src/decoy.rs": "pub fn square(x: f64) -> f64 { x + x }",
  "src/consumer.rs": src(["use crate::geometry::util::*;", "pub fn run() -> f64 {", "    square(3.0)", "}"]),
};

const rustWorkspaceInheritedDependency = {
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

const swiftShadowedSelfMember = {
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

const tsOverloadCall = {
  "fmt.ts": src([
    "export function format(value: string): string;",
    "export function format(value: number): string;",
    "export function format(value: string | number): string { return String(value); }",
  ]),
  "decoy.ts": "export function format(value: string): string { return value; }",
  "use.ts": src(['import { format } from "./fmt";', 'export function run(): string { return format("hi"); }']),
};

const defaultExportClass = {
  "widget.ts": src([
    "export default class Widget {",
    "  static create(): Widget { return new Widget(); }",
    '  render(): string { return "w"; }',
    "  m(): number { return this.m(); }",
    "}",
  ]),
  "decoy.ts": src([
    "export class Widget {",
    "  static create(): Widget { return new Widget(); }",
    '  render(): string { return "d"; }',
    "}",
  ]),
  "use.ts": src([
    'import Widget from "./widget";',
    "export function run(): string {",
    "  return new Widget().render();",
    "}",
  ]),
};

const dynamicImportMember = {
  "lazy.ts": 'export function thing(): string { return "lazy"; }',
  "decoy.ts": 'export function thing(): string { return "decoy"; }',
  "use.ts": src([
    "export async function run(): Promise<string> {",
    '  const mod = await import("./lazy");',
    "  return mod.thing();",
    "}",
  ]),
};

const tsStaticCall = {
  "box.ts": src(["export class Box {", "  static create(): Box { return new Box(); }", "}"]),
  "decoy.ts": src(["export class Box {", '  static create(): string { return "decoy"; }', "}"]),
  "use.ts": src(['import { Box } from "./box";', "export function run(): Box {", "  return Box.create();", "}"]),
};

const tsEnumMemberByParameterType = {
  "status.ts": src(["export enum Status {", "  Active,", "  Inactive,", "}"]),
  "decoy.ts": src(["export enum Status {", "  Active,", "}"]),
  "use.ts": src([
    'import { Status } from "./status";',
    "export function withParam(s: Status): Status {",
    "  return Status.Active;",
    "}",
  ]),
};

const zigSelfMethod = {
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
  extra?: Pick<AgreementRow, "declaration" | "provenNonReference" | "fails" | "keywordReceiver">,
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
    ...(extra?.keywordReceiver ? { keywordReceiver: true } : {}),
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
  useRow(
    "C header prototype and definition",
    "C",
    cPrototypeAndDefinition,
    { file: "run.c", line: 3, token: "compute" },
    { file: "util.h", line: 3 },
    calls("run.c", "run"),
  ),
  decoyRow(
    "C header prototype and definition",
    "C",
    cPrototypeAndDefinition,
    { file: "run.c", line: 3, token: "compute" },
    { file: "extra.c", line: 1, token: "compute" },
    // run.c includes util.h, and the call resolves to that prototype.
    "no include connects run.c to extra.c; the call resolves to util.h",
    calls("run.c", "run"),
  ),

  useRow(
    "C++ using namespace",
    "C++",
    cppUsingNamespace,
    { file: "main.cpp", line: 4, token: "add" },
    { file: "tools.hpp", line: 2 },
    calls("main.cpp", "main"),
  ),
  decoyRow(
    "C++ using namespace",
    "C++",
    cppUsingNamespace,
    { file: "main.cpp", line: 4, token: "add" },
    { file: "tools.hpp", line: 6, token: "add" },
    "using namespace tools does not open namespace unused",
    calls("main.cpp", "main"),
  ),
  useRow(
    "C++ member call on a typed local",
    "C++",
    cppTypedLocalReceiver,
    { file: "use.cpp", line: 4, token: "run" },
    { file: "box.hpp", line: 3 },
    calls("use.cpp", "callWithLocal"),
  ),
  decoyRow(
    "C++ member call on a typed local",
    "C++",
    cppTypedLocalReceiver,
    { file: "use.cpp", line: 4, token: "run" },
    { file: "widget.hpp", line: 3, token: "run" },
    "the local is declared Box, not Widget",
    calls("use.cpp", "callWithLocal"),
  ),

  useRow(
    "C# member call on a constructed nested or generic local",
    "C#",
    csharpConstructedLocal,
    { file: "n.cs", line: 9, token: "Value" },
    { file: "n.cs", line: 3 },
    calls("n.cs", "Use"),
  ),
  decoyRow(
    "C# member call on a constructed nested or generic local",
    "C#",
    csharpConstructedLocal,
    { file: "n.cs", line: 9, token: "Value" },
    { file: "other.cs", line: 3, token: "Value" },
    "the constructed local is Outer.Inner, not Other.Nested",
    calls("n.cs", "Use"),
  ),
  useRow(
    "C# using alias to a type",
    "C#",
    csharpTypeAlias,
    { file: "pt.cs", line: 11, token: "Sum" },
    { file: "pt.cs", line: 4 },
    calls("pt.cs", "Use"),
  ),
  decoyRow(
    "C# using alias to a type",
    "C#",
    csharpTypeAlias,
    { file: "pt.cs", line: 11, token: "Sum" },
    { file: "other.cs", line: 3, token: "Sum" },
    "using PT = N.Point names N.Point, not N2.Other",
    calls("pt.cs", "Use"),
  ),

  useRow(
    "Go package-qualified call",
    "Go",
    goQualifiedCall,
    { file: "main/main.go", line: 6, token: "Square" },
    { file: "util/util.go", line: 3 },
    calls("main/main.go", "main"),
  ),
  decoyRow(
    "Go package-qualified call",
    "Go",
    goQualifiedCall,
    { file: "main/main.go", line: 6, token: "Square" },
    { file: "other/other.go", line: 3, token: "Square" },
    "import u is example.com/proj/util, not package other",
    calls("main/main.go", "main"),
  ),
  // Go rejects an unexported name from another package, so the call is a proven non-reference
  // of util.hidden and must not be recorded as a calls edge.
  useRow(
    "Go unexported name from another package",
    "Go",
    goUnexportedCrossPackage,
    { file: "main/main.go", line: 6, token: "hidden" },
    "not_found",
    calls("main/main.go", "main"),
    {
      declaration: { file: "util/util.go", line: 3, token: "hidden" },
      provenNonReference: "Go rejects an unexported name used from another package",
    },
  ),
  decoyRow(
    "Go unexported name from another package",
    "Go",
    goUnexportedCrossPackage,
    { file: "main/main.go", line: 6, token: "hidden" },
    { file: "other/other.go", line: 3, token: "hidden" },
    "the selector is u.hidden, and u is package util, not other",
    calls("main/main.go", "main"),
  ),

  useRow(
    "same-package call without an import",
    "Java",
    samePackageCall,
    { file: "p/Bar.java", line: 5, token: "hello" },
    { file: "p/Foo.java", line: 4 },
    calls("p/Bar.java", "direct"),
  ),
  decoyRow(
    "same-package call without an import",
    "Java",
    samePackageCall,
    { file: "p/Bar.java", line: 5, token: "hello" },
    { file: "q/Foo.java", line: 4, token: "hello" },
    "Bar and Foo share package p; package q is not in scope",
    calls("p/Bar.java", "direct"),
  ),
  useRow(
    "member call on a typed parameter",
    "Java",
    typedParameterReceiver,
    { file: "b/User.java", line: 4, token: "hello" },
    { file: "a/Greeter.java", line: 3 },
    calls("b/User.java", "use"),
  ),
  decoyRow(
    "member call on a typed parameter",
    "Java",
    typedParameterReceiver,
    { file: "b/User.java", line: 4, token: "hello" },
    { file: "decoy/Greeter.java", line: 3, token: "hello" },
    "the parameter type is the imported a.Greeter, not package decoy",
    calls("b/User.java", "use"),
  ),

  useRow(
    "require() module member call",
    "JavaScript",
    requireModuleMember,
    { file: "use.js", line: 2, token: "helper" },
    { file: "util.js", line: 1 },
    calls("use.js", "run"),
  ),
  decoyRow(
    "require() module member call",
    "JavaScript",
    requireModuleMember,
    { file: "use.js", line: 2, token: "helper" },
    { file: "decoy.js", line: 1, token: "helper", occurrence: 2 },
    "require('./util') does not bind ./decoy",
    calls("use.js", "run"),
  ),

  // Box resolves to a class whose companion scope has no instanceHelper, so the invalid
  // type-name call is a proven non-reference and must not produce a calls edge.
  useRow(
    "Kotlin instance method through the type name",
    "Kotlin",
    kotlinTypeNameInstanceCall,
    { file: "Box.kt", line: 15, token: "instanceHelper" },
    "not_found",
    calls("Box.kt", "useInvalid"),
    {
      declaration: { file: "Box.kt", line: 4, token: "instanceHelper" },
      provenNonReference: "Box's companion scope has no instanceHelper, so the type-name call is rejected",
    },
  ),
  decoyRow(
    "Kotlin instance method through the type name",
    "Kotlin",
    kotlinTypeNameInstanceCall,
    { file: "Box.kt", line: 15, token: "instanceHelper" },
    { file: "Box.kt", line: 11, token: "instanceHelper" },
    "the receiver is class Box, not class Decoy",
    calls("Box.kt", "useInvalid"),
  ),
  useRow(
    "Kotlin companion-object factory",
    "Kotlin",
    kotlinCompanionFactory,
    { file: "w.kt", line: 9, token: "create" },
    { file: "w.kt", line: 3 },
    calls("w.kt", "use"),
  ),
  decoyRow(
    "Kotlin companion-object factory",
    "Kotlin",
    kotlinCompanionFactory,
    { file: "w.kt", line: 9, token: "create" },
    { file: "w.kt", line: 7, token: "create" },
    "Widget.create() is the companion factory, not Gadget's instance method",
    calls("w.kt", "use"),
  ),
  useRow(
    "Kotlin extension function",
    "Kotlin",
    kotlinExtensionFunction,
    { file: "w.kt", line: 8, token: "describe" },
    { file: "w.kt", line: 5 },
    calls("w.kt", "use"),
  ),
  decoyRow(
    "Kotlin extension function",
    "Kotlin",
    kotlinExtensionFunction,
    { file: "w.kt", line: 8, token: "describe" },
    { file: "w.kt", line: 3, token: "describe" },
    "w is a Widget, so the call is the extension, not Gadget.describe",
    calls("w.kt", "use"),
  ),
  useRow(
    "Kotlin method beside a constructor property",
    "Kotlin",
    kotlinConstructorProperty,
    { file: "G.kt", line: 9, token: "describe" },
    { file: "G.kt", line: 2 },
    calls("G.kt", "use"),
  ),
  decoyRow(
    "Kotlin method beside a constructor property",
    "Kotlin",
    kotlinConstructorProperty,
    { file: "G.kt", line: 9, token: "describe" },
    { file: "G.kt", line: 5, token: "describe" },
    "g is a Gadget, not Other",
    calls("G.kt", "use"),
  ),
  useRow(
    "Kotlin explicit import beside a same-package class",
    "Kotlin",
    kotlinExplicitImport,
    { file: "app/Use.kt", line: 3, token: "Foo" },
    { file: "other/Foo.kt", line: 2 },
    calls("app/Use.kt", "use"),
  ),
  decoyRow(
    "Kotlin explicit import beside a same-package class",
    "Kotlin",
    kotlinExplicitImport,
    { file: "app/Use.kt", line: 3, token: "Foo" },
    { file: "app/Foo.kt", line: 2, token: "Foo" },
    "an explicit import beats a same-package class",
  ),
  useRow(
    "C++ call that fits several overloads",
    "C++",
    cppAmbiguousOverload,
    { file: "use.cpp", line: 2, token: "f" },
    "not_found",
    undefined,
    {
      declaration: { file: "api.hpp", line: 1, token: "f" },
    },
  ),

  useRow(
    "PHP same-namespace extends, trait use, and parent::",
    "PHP",
    phpSameNamespacePeers,
    { file: "Worker.php", line: 4, token: "Base" },
    { file: "Base.php", line: 4 },
    { label: "extends", fromFile: "Worker.php", fromName: "Worker" },
  ),
  decoyRow(
    "PHP same-namespace extends, trait use, and parent::",
    "PHP",
    phpSameNamespacePeers,
    { file: "Worker.php", line: 4, token: "Base" },
    { file: "Other.php", line: 4, token: "Base" },
    "Worker is in Acme\\App; Other\\Ns\\Base is a different namespace",
    { label: "extends", fromFile: "Worker.php", fromName: "Worker" },
  ),
  // `self` is a keyword receiver: goto resolves new self() to Child and the instantiates
  // edge is recorded, but the keyword is not a name reference of the class.
  useRow(
    "PHP new self() and new static()",
    "PHP",
    phpNewSelf,
    { file: "box.php", line: 7, token: "self" },
    { file: "box.php", line: 6 },
    { label: "instantiates", fromFile: "box.php", fromName: "makeSelf" },
    { keywordReceiver: true },
  ),
  decoyRow(
    "PHP new self() and new static()",
    "PHP",
    phpNewSelf,
    { file: "box.php", line: 7, token: "self" },
    { file: "decoy.php", line: 2, token: "Child" },
    "new self() binds the enclosing class in box.php, not the other file's Child",
    { label: "instantiates", fromFile: "box.php", fromName: "makeSelf" },
  ),
  useRow(
    "PHP constructor-promoted property",
    "PHP",
    phpPromotedProperty,
    { file: "box.php", line: 3, token: "x" },
    { file: "box.php", line: 4 },
  ),
  decoyRow(
    "PHP constructor-promoted property",
    "PHP",
    phpPromotedProperty,
    { file: "box.php", line: 3, token: "x" },
    { file: "box.php", line: 7, token: "$x" },
    "$this inside Box reads Box's promoted property, not Other::$x",
  ),

  useRow(
    "Python class named like its module",
    "Python",
    pythonClassNamedLikeModule,
    { file: "main.py", line: 3, token: "W" },
    { file: "pkg/widget.py", line: 1 },
  ),
  decoyRow(
    "Python class named like its module",
    "Python",
    pythonClassNamedLikeModule,
    { file: "main.py", line: 3, token: "W" },
    { file: "decoy_pkg/widget.py", line: 1, token: "Widget" },
    "from pkg import Widget binds pkg.widget.Widget, not decoy_pkg",
  ),
  useRow(
    "Python import pkg.mod then pkg.mod.foo()",
    "Python",
    pythonDottedModuleImport,
    { file: "main.py", line: 4, token: "foo" },
    { file: "pkg/mod.py", line: 1 },
    calls("main.py", "run"),
  ),
  decoyRow(
    "Python import pkg.mod then pkg.mod.foo()",
    "Python",
    pythonDottedModuleImport,
    { file: "main.py", line: 4, token: "foo" },
    { file: "other.py", line: 1, token: "foo" },
    "import pkg.mod does not bind other.py",
    calls("main.py", "run"),
  ),
  useRow(
    "same name through two star imports",
    "Python",
    starImportCollision,
    { file: "main.py", line: 5, token: "helper" },
    { file: "aaa.py", line: 1 },
    calls("main.py", "run"),
  ),
  decoyRow(
    "same name through two star imports",
    "Python",
    starImportCollision,
    { file: "main.py", line: 5, token: "helper" },
    { file: "decoy.py", line: 1, token: "helper" },
    "decoy.py is never star-imported; the later import rebinds helper to aaa",
    calls("main.py", "run"),
  ),
  useRow(
    "same name through two star imports",
    "Python",
    w17Receiver,
    { file: "main.py", line: 5, token: "m" },
    { file: "b.py", line: 3 },
    calls("main.py", "run"),
  ),
  decoyRow(
    "same name through two star imports",
    "Python",
    w17Receiver,
    { file: "main.py", line: 5, token: "m" },
    { file: "a.py", line: 3, token: "m" },
    "the later star import rebinds X to b.X, so the receiver is b's class",
    calls("main.py", "run"),
  ),
  useRow(
    "Python aliased import source name",
    "Python",
    pythonAliasedImportSource,
    { file: "b.py", line: 1, token: "helper" },
    { file: "a.py", line: 1 },
  ),
  decoyRow(
    "Python aliased import source name",
    "Python",
    pythonAliasedImportSource,
    { file: "b.py", line: 1, token: "helper" },
    { file: "decoy.py", line: 1, token: "helper" },
    "from a import helper names module a, not decoy",
  ),
  useRow(
    "super() through a proven base class",
    "Python",
    superThroughProvenBase,
    { file: "derived.py", line: 5, token: "greet" },
    { file: "base.py", line: 2 },
    calls("derived.py", "greet"),
  ),
  decoyRow(
    "super() through a proven base class",
    "Python",
    superThroughProvenBase,
    { file: "derived.py", line: 5, token: "greet" },
    { file: "unrelated.py", line: 2, token: "greet" },
    "Derived's base is Base, not Unrelated",
    calls("derived.py", "greet"),
  ),

  useRow(
    "Ruby Widget.new from another file",
    "Ruby",
    rubyCrossFileNew,
    { file: "use.rb", line: 4, token: "render" },
    { file: "widget.rb", line: 2 },
    calls("use.rb", "run"),
  ),
  decoyRow(
    "Ruby Widget.new from another file",
    "Ruby",
    rubyCrossFileNew,
    { file: "use.rb", line: 4, token: "render" },
    { file: "decoy.rb", line: 2, token: "render" },
    "use.rb requires widget.rb, not the unrequired decoy",
    calls("use.rb", "run"),
  ),
  useRow(
    "Ruby class nested in a module",
    "Ruby",
    rubyNestedClassExport,
    { file: "worker.rb", line: 3, token: "Base" },
    { file: "real_base.rb", line: 1 },
    { label: "extends", fromFile: "worker.rb", fromName: "Worker" },
  ),
  decoyRow(
    "Ruby class nested in a module",
    "Ruby",
    rubyNestedClassExport,
    { file: "worker.rb", line: 3, token: "Base" },
    { file: "outer.rb", line: 2, token: "Base" },
    "Outer::Base is nested and is not the bare constant real_base.rb exports",
    { label: "extends", fromFile: "worker.rb", fromName: "Worker" },
  ),
  useRow(
    "Ruby cross-file extends, include, and extend",
    "Ruby",
    rubyCrossFileInheritance,
    { file: "ruby_worker.rb", line: 2, token: "RubyBase" },
    { file: "ruby_base.rb", line: 1 },
    { label: "extends", fromFile: "ruby_worker.rb", fromName: "RubyWorker" },
  ),
  decoyRow(
    "Ruby cross-file extends, include, and extend",
    "Ruby",
    rubyCrossFileInheritance,
    { file: "ruby_worker.rb", line: 2, token: "RubyBase" },
    { file: "decoy_base.rb", line: 1, token: "RubyBase" },
    "ruby_worker.rb requires ruby_base.rb, not decoy_base.rb",
    { label: "extends", fromFile: "ruby_worker.rb", fromName: "RubyWorker" },
  ),
  useRow(
    "Ruby block parameter",
    "Ruby",
    rubyBlockParameter,
    { file: "blocks.rb", line: 4, token: "item" },
    { file: "blocks.rb", line: 3 },
  ),
  decoyRow(
    "Ruby block parameter",
    "Ruby",
    rubyBlockParameter,
    { file: "blocks.rb", line: 4, token: "item" },
    { file: "decoy.rb", line: 2, token: "item" },
    "the block parameter is lexical to blocks.rb; decoy.rb's item is a different binding",
  ),

  useRow(
    "Rust super::Type in a type position",
    "Rust",
    rustSuperType,
    { file: "src/lib.rs", line: 3, token: "Circle" },
    { file: "src/lib.rs", line: 1 },
  ),
  decoyRow(
    "Rust super::Type in a type position",
    "Rust",
    rustSuperType,
    { file: "src/lib.rs", line: 3, token: "Circle" },
    { file: "src/decoy.rs", line: 1, token: "Circle" },
    "super::Circle is the parent module's struct, not decoy::Circle",
  ),
  useRow(
    "Rust workspace path dependency",
    "Rust",
    rustWorkspacePathDependency,
    { file: "crate_b/src/main.rs", line: 2, token: "greet" },
    { file: "crate_a/src/lib.rs", line: 1 },
    uses("crate_b/src/main.rs", "main"),
  ),
  decoyRow(
    "Rust workspace path dependency",
    "Rust",
    rustWorkspacePathDependency,
    { file: "crate_b/src/main.rs", line: 2, token: "greet" },
    { file: "crate_c/src/lib.rs", line: 1, token: "greet" },
    "crate_b depends on crate_a by path, not on crate_c",
    uses("crate_b/src/main.rs", "main"),
  ),
  useRow(
    "Rust impl method call",
    "Rust",
    rustImplMethod,
    { file: "src/lib.rs", line: 9, token: "area" },
    { file: "src/lib.rs", line: 4 },
    calls("src/lib.rs", "total"),
  ),
  decoyRow(
    "Rust impl method call",
    "Rust",
    rustImplMethod,
    { file: "src/lib.rs", line: 9, token: "area" },
    { file: "src/lib.rs", line: 7, token: "area" },
    "the parameter type is Circle, not Square",
    calls("src/lib.rs", "total"),
  ),
  useRow(
    "Rust glob import and struct-literal receiver",
    "Rust",
    rustZigGlobAndStructLiteral,
    { file: "src/consumer.rs", line: 3, token: "square" },
    { file: "src/geometry.rs", line: 2 },
    calls("src/consumer.rs", "run"),
  ),
  decoyRow(
    "Rust glob import and struct-literal receiver",
    "Rust",
    rustZigGlobAndStructLiteral,
    { file: "src/consumer.rs", line: 3, token: "square" },
    { file: "src/decoy.rs", line: 1, token: "square" },
    "use crate::geometry::util::* does not import crate::decoy::square",
    calls("src/consumer.rs", "run"),
  ),
  useRow(
    "Rust workspace-inherited dependency",
    "Rust",
    rustWorkspaceInheritedDependency,
    { file: "crate_b/src/main.rs", line: 2, token: "greet" },
    { file: "crate_a/src/lib.rs", line: 1 },
    uses("crate_b/src/main.rs", "main"),
  ),
  decoyRow(
    "Rust workspace-inherited dependency",
    "Rust",
    rustWorkspaceInheritedDependency,
    { file: "crate_b/src/main.rs", line: 2, token: "greet" },
    { file: "crate_c/src/lib.rs", line: 1, token: "greet" },
    "workspace = true inherits crate_a's path, not crate_c",
    uses("crate_b/src/main.rs", "main"),
  ),

  useRow(
    "Swift self member behind a shadowing parameter",
    "Swift",
    swiftShadowedSelfMember,
    { file: "Widget.swift", line: 4, token: "name", occurrence: 1 },
    { file: "Widget.swift", line: 2 },
  ),
  decoyRow(
    "Swift self member behind a shadowing parameter",
    "Swift",
    swiftShadowedSelfMember,
    { file: "Widget.swift", line: 4, token: "name", occurrence: 1 },
    { file: "Widget.swift", line: 8, token: "name" },
    "self in Widget.init is Widget, not Other",
  ),

  useRow(
    "TypeScript overload called from another file",
    "TypeScript",
    tsOverloadCall,
    { file: "use.ts", line: 2, token: "format" },
    { file: "fmt.ts", line: 3 },
    calls("use.ts", "run"),
  ),
  decoyRow(
    "TypeScript overload called from another file",
    "TypeScript",
    tsOverloadCall,
    { file: "use.ts", line: 2, token: "format" },
    { file: "decoy.ts", line: 1, token: "format" },
    "import { format } from './fmt' does not bind decoy.ts",
    calls("use.ts", "run"),
  ),
  useRow(
    "default-exported class member call",
    "TypeScript",
    defaultExportClass,
    { file: "use.ts", line: 3, token: "render" },
    { file: "widget.ts", line: 3 },
    calls("use.ts", "run"),
  ),
  // `this` in this.m() resolves to Widget, and it is not a name reference of the class.
  useRow(
    "this-m",
    "TypeScript",
    defaultExportClass,
    { file: "widget.ts", line: 4, token: "this" },
    { file: "widget.ts", line: 1 },
    undefined,
    { keywordReceiver: true },
  ),
  decoyRow(
    "default-exported class member call",
    "TypeScript",
    defaultExportClass,
    { file: "use.ts", line: 3, token: "render" },
    { file: "decoy.ts", line: 3, token: "render" },
    "the default import binds ./widget, not ./decoy",
    calls("use.ts", "run"),
  ),
  useRow(
    "dynamic import() member call",
    "TypeScript",
    dynamicImportMember,
    { file: "use.ts", line: 3, token: "thing" },
    { file: "lazy.ts", line: 1 },
    calls("use.ts", "run"),
  ),
  decoyRow(
    "dynamic import() member call",
    "TypeScript",
    dynamicImportMember,
    { file: "use.ts", line: 3, token: "thing" },
    { file: "decoy.ts", line: 1, token: "thing" },
    "import('./lazy') does not bind ./decoy",
    calls("use.ts", "run"),
  ),
  useRow(
    "TypeScript static method call",
    "TypeScript",
    tsStaticCall,
    { file: "use.ts", line: 3, token: "create" },
    { file: "box.ts", line: 2 },
    calls("use.ts", "run"),
  ),
  decoyRow(
    "TypeScript static method call",
    "TypeScript",
    tsStaticCall,
    { file: "use.ts", line: 3, token: "create" },
    { file: "decoy.ts", line: 2, token: "create" },
    "import { Box } from './box' does not bind ./decoy",
    calls("use.ts", "run"),
  ),
  useRow(
    "TypeScript enum member through a parameter type",
    "TypeScript",
    tsEnumMemberByParameterType,
    { file: "use.ts", line: 3, token: "Active" },
    { file: "status.ts", line: 2 },
  ),
  decoyRow(
    "TypeScript enum member through a parameter type",
    "TypeScript",
    tsEnumMemberByParameterType,
    { file: "use.ts", line: 3, token: "Active" },
    { file: "decoy.ts", line: 2, token: "Active" },
    "import { Status } from './status' does not bind ./decoy",
  ),

  useRow(
    "Zig self.method() inside the struct",
    "Zig",
    zigSelfMethod,
    { file: "shapes.zig", line: 4, token: "area" },
    { file: "shapes.zig", line: 3 },
    calls("shapes.zig", "describe"),
  ),
  decoyRow(
    "Zig self.method() inside the struct",
    "Zig",
    zigSelfMethod,
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
