import path from "node:path";
import { expect } from "vitest";
import type { SymbolGraph } from "../../src/graphs/symbol-graph.js";
import { findReferences, goToDefinition } from "../../src/indexer/navigation.js";
import { findTypeHierarchy } from "../../src/indexer/type-hierarchy.js";
import type { ProjectIndex } from "../../src/indexer/types.js";
import { normalizePath } from "../../src/util/paths.js";

/** A spelling in a fixture file: the `occurrence`th `marker`, moved `offset` characters right. */
export type Site = { file: string; marker: string; occurrence?: number; offset?: number };
/** Where go-to-definition lands as `name@file`, or `null` for `not_found`. */
type GotoCase = Site & { expect: string | null };
/** `includes` and `excludes` are `file:line` entries; `coverage` is the state `findReferences` must report. */
type ReferencesCase = Site & {
  includes: readonly string[];
  excludes: readonly string[];
  coverage: "complete" | "partial";
};

/**
 * One language's qualified bases beside same-named decoys: a base reached through its qualifier, an ordinary
 * unqualified base, and a qualifier no project file declares. The sources ran or compiled on each language's toolchain:
 * CPython 3.13 and Ruby 3.3 (the superclass of each class), Node (the prototype chain; `ext.js` imports an unresolvable
 * package on purpose and was not run), kotlinc and javac (compiled and run, superclass by reflection), the Swift 5.10
 * type checker (the nested base and its members compile; `Empty.Base` and a decoy-only member do not), and the Go 1.23
 * compiler (a method is promoted only through the embedded `other.Base`). `UIKit.UIView` needs an Apple platform, so it
 * was only checked to name no project type.
 */
export type QualifiedBaseFixture = {
  language: string;
  files: Readonly<Record<string, string>>;
  /** Every heritage edge, `Child@file -label-> Base@file`. */
  edges: readonly string[];
  /** Subtypes of a base, `Base@file` mapped to the `Child@file` entries one level down. */
  subtypes: Readonly<Record<string, readonly string[]>>;
  gotos: readonly GotoCase[];
  references: readonly ReferencesCase[];
};

export const lines = (...rows: string[]): string => [...rows, ""].join("\n");

export const QUALIFIED_BASE_FIXTURES: readonly QualifiedBaseFixture[] = [
  {
    language: "Python",
    files: {
      // `Helper` is the module's first export: a module name must never stand for it.
      "other.py": lines(
        "class Helper:",
        "    pass",
        "",
        "",
        "class Base:",
        "    def shared(self):",
        '        return "other"',
        "",
        "    def real_only(self):",
        '        return "other"',
        "",
        "",
        "def make_base(base):",
        "    return base",
      ),
      "decoy.py": lines(
        "class Base:",
        "    def shared(self):",
        '        return "decoy"',
        "",
        "    def decoy_only(self):",
        '        return "decoy"',
        "",
        "",
        "class Model:",
        "    def save(self):",
        '        return "decoy"',
      ),
      "use_module.py": lines(
        "import other",
        "",
        "",
        "class W(other.Base):",
        "    def run(self):",
        "        self.real_only()",
        "        self.shared()",
        "        return self.decoy_only()",
      ),
      "use_both.py": lines(
        "import other",
        "from decoy import Base",
        "",
        "",
        "class W(other.Base):",
        "    def run(self):",
        "        self.real_only()",
        "        self.shared()",
        "        return self.decoy_only()",
        "",
        "",
        "class D(Base):",
        "    def run(self):",
        "        return self.decoy_only()",
      ),
      "use_local.py": lines(
        "import other",
        "",
        "",
        "class Base:",
        "    def local_only(self):",
        '        return "local"',
        "",
        "",
        "class L(other.Base):",
        "    def run(self):",
        "        return self.local_only()",
      ),
      "use_alias.py": lines("import other as o", "", "", "class A(o.Base):", "    pass"),
      // `import pkg.mod` binds the package `pkg`: its `Base` is this one, never the leaf module's.
      "pkg/__init__.py": lines("class Base:", "    def init_only(self):", '        return "init"'),
      "pkg/mod.py": lines("class Base:", "    def pkg_only(self):", '        return "pkg"'),
      "use_pkg.py": lines(
        "import pkg.mod",
        "from pkg import mod",
        "",
        "",
        "class V(pkg.mod.Base):",
        "    def run(self):",
        "        return self.pkg_only()",
        "",
        "",
        "class U(mod.Base):",
        "    def run(self):",
        "        return self.pkg_only()",
      ),
      "pkg/use_rel.py": lines(
        "from . import mod",
        "",
        "",
        "class R(mod.Base):",
        "    def run(self):",
        "        return self.pkg_only()",
      ),
      "pkg/sub/__init__.py": "",
      "pkg/sub/mod.py": lines("class Base:", "    def deep_only(self):", '        return "deep"'),
      "use_deep.py": lines(
        "from pkg.sub import mod",
        "",
        "",
        "class G(mod.Base):",
        "    def run(self):",
        "        return self.deep_only()",
      ),
      "use_pkg_attr.py": lines(
        "import pkg.mod",
        "",
        "",
        "class K(pkg.Base):",
        "    def run(self):",
        "        self.init_only()",
        "        return self.pkg_only()",
      ),
      "use_call.py": lines(
        "import other",
        "from decoy import Base",
        "from other import make_base",
        "",
        "",
        "class C(make_base(Base)):",
        "    def run(self):",
        "        return self.decoy_only()",
        "",
        "",
        "class D(make_base(other.Base)):",
        "    def run(self):",
        "        return self.real_only()",
        "",
        "",
        "class F(other.make_base(Base), other.Base):",
        "    def run(self):",
        "        return self.real_only()",
      ),
      "use_pkg_both.py": lines(
        "import pkg",
        "import pkg.mod",
        "",
        "",
        "class B(pkg.Base):",
        "    def run(self):",
        "        self.init_only()",
        "        return self.pkg_only()",
      ),
      "use_plain.py": lines("from other import Base", "", "", "class P(Base):", "    pass"),
      "use_external.py": lines(
        "import django.db.models",
        "from django.db import models",
        "",
        "",
        "class M(models.Model):",
        "    pass",
        "",
        "",
        "class N(django.db.models.Model):",
        "    pass",
      ),
    },
    edges: [
      "A@use_alias.py -extends-> Base@other.py",
      "B@use_pkg_both.py -extends-> Base@pkg/__init__.py",
      "D@use_both.py -extends-> Base@decoy.py",
      "F@use_call.py -extends-> Base@other.py",
      "G@use_deep.py -extends-> Base@pkg/sub/mod.py",
      "K@use_pkg_attr.py -extends-> Base@pkg/__init__.py",
      "L@use_local.py -extends-> Base@other.py",
      "P@use_plain.py -extends-> Base@other.py",
      "R@pkg/use_rel.py -extends-> Base@pkg/mod.py",
      "U@use_pkg.py -extends-> Base@pkg/mod.py",
      "V@use_pkg.py -extends-> Base@pkg/mod.py",
      "W@use_both.py -extends-> Base@other.py",
      "W@use_module.py -extends-> Base@other.py",
    ],
    subtypes: {
      "Base@other.py": [
        "A@use_alias.py",
        "F@use_call.py",
        "L@use_local.py",
        "P@use_plain.py",
        "W@use_both.py",
        "W@use_module.py",
      ],
      "Base@decoy.py": ["D@use_both.py"],
      // `import pkg.mod` binds the package, so `K` reads `pkg.Base` from `pkg/__init__.py`, never from the submodule.
      "Base@pkg/mod.py": ["R@pkg/use_rel.py", "U@use_pkg.py", "V@use_pkg.py"],
      "Base@pkg/__init__.py": ["B@use_pkg_both.py", "K@use_pkg_attr.py"],
      "Base@pkg/sub/mod.py": ["G@use_deep.py"],
    },
    gotos: [
      { file: "use_module.py", marker: "real_only()", expect: "real_only@other.py" },
      { file: "use_module.py", marker: "shared()", expect: "shared@other.py" },
      { file: "use_module.py", marker: "decoy_only()", expect: null },
      { file: "use_both.py", marker: "decoy_only()", occurrence: 0, expect: null },
      { file: "use_both.py", marker: "decoy_only()", occurrence: 1, expect: "decoy_only@decoy.py" },
      { file: "use_pkg.py", marker: "pkg_only()", occurrence: 0, expect: "pkg_only@pkg/mod.py" },
      { file: "use_pkg.py", marker: "pkg_only()", occurrence: 1, expect: "pkg_only@pkg/mod.py" },
      { file: "pkg/use_rel.py", marker: "pkg_only()", expect: "pkg_only@pkg/mod.py" },
      { file: "use_deep.py", marker: "deep_only()", expect: "deep_only@pkg/sub/mod.py" },
      { file: "use_pkg_attr.py", marker: "init_only()", expect: "init_only@pkg/__init__.py" },
      { file: "use_pkg_attr.py", marker: "pkg_only()", expect: null },
      // A base a call computes proves no class: neither the callee chain nor its arguments is one.
      { file: "use_call.py", marker: "decoy_only()", expect: null },
      { file: "use_call.py", marker: "real_only()", occurrence: 0, expect: null },
      { file: "use_call.py", marker: "real_only()", occurrence: 1, expect: "real_only@other.py" },
      { file: "use_pkg_both.py", marker: "init_only()", expect: "init_only@pkg/__init__.py" },
      { file: "use_pkg_both.py", marker: "pkg_only()", expect: null },
      { file: "use_module.py", marker: "other.Base", offset: 6, expect: "Base@other.py" },
    ],
    references: [
      {
        file: "other.py",
        marker: "shared(self)",
        includes: ["use_module.py:7", "use_both.py:8"],
        excludes: [],
        coverage: "complete",
      },
      {
        file: "decoy.py",
        marker: "shared(self)",
        includes: [],
        excludes: ["use_module.py:7", "use_both.py:8"],
        coverage: "complete",
      },
      {
        file: "pkg/mod.py",
        marker: "pkg_only",
        includes: ["use_pkg.py:7", "use_pkg.py:12", "pkg/use_rel.py:6"],
        excludes: ["use_pkg_attr.py:7", "use_pkg_both.py:8"],
        coverage: "complete",
      },
      {
        file: "pkg/__init__.py",
        marker: "init_only",
        includes: ["use_pkg_both.py:7", "use_pkg_attr.py:6"],
        excludes: [],
        coverage: "complete",
      },
    ],
  },
  {
    language: "Ruby",
    files: {
      "other.rb": lines(
        "module Other",
        "  class Base",
        "    def shared",
        '      "other"',
        "    end",
        "",
        "    def real_only",
        '      "other"',
        "    end",
        "  end",
        "end",
      ),
      "decoy.rb": lines(
        "class Base",
        "  def shared",
        '    "decoy"',
        "  end",
        "",
        "  def decoy_only",
        '    "decoy"',
        "  end",
        "end",
      ),
      "use.rb": lines(
        'require_relative "other"',
        'require_relative "decoy"',
        "",
        "class W < Other::Base",
        "  def run",
        "    self.real_only",
        "    self.shared",
        "    self.decoy_only",
        "  end",
        "end",
        "",
        "class P < Base",
        "  def run",
        "    self.decoy_only",
        "  end",
        "end",
        "",
        "class M < ActiveRecord::Base",
        "  def run",
        "    self.decoy_only",
        "  end",
        "end",
      ),
      "local.rb": lines(
        'require_relative "other"',
        "",
        "class Base",
        "  def local_only",
        '    "local"',
        "  end",
        "end",
        "",
        "class L < Other::Base",
        "  def run",
        "    self.real_only",
        "  end",
        "end",
      ),
      // `Inner::Base` is searched through the namespaces around it: `Outer::Inner::Base`, never the top-level `Base`.
      "nested.rb": lines(
        'require_relative "decoy"',
        "",
        "module Outer",
        "  module Inner",
        "    class Base",
        "      def inner_only",
        '        "inner"',
        "      end",
        "    end",
        "  end",
        "",
        "  class Child < Inner::Base",
        "    def run",
        "      self.inner_only",
        "      self.decoy_only",
        "    end",
        "  end",
        "end",
      ),
      "nested_use.rb": lines(
        'require_relative "nested"',
        "",
        "module Outer",
        "  class Late < Inner::Base",
        "    def run",
        "      self.inner_only",
        "    end",
        "  end",
        "end",
      ),
      // `::Base` is the top-level class, not the `Ns::Base` beside it; `self::Base` is `Ns::Base`.
      "absolute.rb": lines(
        'require_relative "decoy"',
        "",
        "module Ns",
        "  class Base",
        "    def ns_only",
        '      "ns"',
        "    end",
        "  end",
        "",
        "  class Top < ::Base",
        "    def run",
        "      self.decoy_only",
        "      self.ns_only",
        "    end",
        "  end",
        "",
        "  class Sib < self::Base",
        "    def run",
        "      self.ns_only",
        "    end",
        "  end",
        "end",
      ),
      // A base picked at run time, or by a method call, names no single class.
      "computed.rb": lines(
        'require_relative "other"',
        "",
        "FLAG = true",
        "",
        "class Pick < (FLAG ? Other::Base : Object)",
        "  def run",
        "    self.real_only",
        "  end",
        "end",
        "",
        "class Via < Other.const_get(:Base)",
        "  def run",
        "    self.real_only",
        "  end",
        "end",
        "",
        "class Anon < Class.new(Other::Base)",
        "end",
        "",
        "class Pair < Struct.new(:left, :right)",
        "end",
      ),
    },
    edges: [
      "Child@nested.rb -extends-> Base@nested.rb",
      "L@local.rb -extends-> Base@other.rb",
      "Late@nested_use.rb -extends-> Base@nested.rb",
      "P@use.rb -extends-> Base@decoy.rb",
      "Sib@absolute.rb -extends-> Base@absolute.rb",
      "Top@absolute.rb -extends-> Base@decoy.rb",
      "W@use.rb -extends-> Base@other.rb",
    ],
    subtypes: {
      "Base@other.rb": ["L@local.rb", "W@use.rb"],
      "Base@decoy.rb": ["P@use.rb", "Top@absolute.rb"],
      "Base@nested.rb": ["Child@nested.rb", "Late@nested_use.rb"],
      "Base@absolute.rb": ["Sib@absolute.rb"],
    },
    gotos: [
      { file: "use.rb", marker: "real_only", expect: "real_only@other.rb" },
      { file: "use.rb", marker: "shared", expect: "shared@other.rb" },
      { file: "use.rb", marker: "decoy_only", occurrence: 0, expect: null },
      { file: "use.rb", marker: "decoy_only", occurrence: 1, expect: "decoy_only@decoy.rb" },
      { file: "use.rb", marker: "decoy_only", occurrence: 2, expect: null },
      { file: "local.rb", marker: "real_only", expect: "real_only@other.rb" },
      { file: "use.rb", marker: "Other::Base", offset: 7, expect: "Base@other.rb" },
      { file: "nested.rb", marker: "inner_only", occurrence: 1, expect: "inner_only@nested.rb" },
      { file: "nested.rb", marker: "decoy_only", expect: null },
      { file: "nested.rb", marker: "Inner::Base", offset: 7, expect: "Base@nested.rb" },
      { file: "nested_use.rb", marker: "inner_only", expect: "inner_only@nested.rb" },
      { file: "nested_use.rb", marker: "Inner::Base", offset: 7, expect: "Base@nested.rb" },
      { file: "absolute.rb", marker: "decoy_only", expect: "decoy_only@decoy.rb" },
      { file: "absolute.rb", marker: "ns_only", occurrence: 1, expect: null },
      { file: "absolute.rb", marker: "ns_only", occurrence: 2, expect: "ns_only@absolute.rb" },
      { file: "absolute.rb", marker: "::Base", offset: 2, expect: "Base@decoy.rb" },
      { file: "absolute.rb", marker: "self::Base", offset: 6, expect: "Base@absolute.rb" },
      { file: "computed.rb", marker: "real_only", occurrence: 0, expect: null },
      { file: "computed.rb", marker: "real_only", occurrence: 1, expect: null },
      { file: "use.rb", marker: "ActiveRecord::Base", offset: 14, expect: null },
    ],
    references: [
      { file: "other.rb", marker: "shared", includes: ["use.rb:7"], excludes: [], coverage: "complete" },
      { file: "decoy.rb", marker: "shared", includes: [], excludes: ["use.rb:7"], coverage: "complete" },
      {
        file: "nested.rb",
        marker: "inner_only",
        includes: ["nested.rb:14", "nested_use.rb:6"],
        excludes: [],
        coverage: "complete",
      },
      {
        file: "decoy.rb",
        marker: "decoy_only",
        includes: ["use.rb:14", "absolute.rb:12"],
        excludes: ["use.rb:8", "nested.rb:15"],
        // `M` has an external base, so its `self.decoy_only` cannot be ruled out.
        coverage: "partial",
      },
      {
        file: "decoy.rb",
        marker: "Base",
        includes: ["use.rb:12", "absolute.rb:10"],
        excludes: ["use.rb:4", "absolute.rb:17", "nested.rb:12", "nested_use.rb:4"],
        // `ActiveRecord::Base` is an unproven qualified name, so it cannot be ruled out.
        coverage: "partial",
      },
    ],
  },
  {
    language: "Swift",
    files: {
      "Other.swift": lines(
        "enum Other {",
        "    class Base {",
        "        func shared() {}",
        "        func realOnly() {}",
        "    }",
        "}",
      ),
      "Empty.swift": lines("enum Empty {}"),
      "Decoy.swift": lines(
        "class Base {",
        "    func shared() {}",
        "    func decoyOnly() {}",
        "}",
        "",
        "class UIView {",
        "    func draw() {}",
        "}",
      ),
      "Use.swift": lines(
        "class W: Other.Base {",
        "    func run() {",
        "        self.realOnly()",
        "        self.shared()",
        "        self.decoyOnly()",
        "    }",
        "}",
        "",
        "class P: Base {",
        "    func run() {",
        "        self.decoyOnly()",
        "    }",
        "}",
        "",
        "class V: Empty.Base {",
        "    func run() {",
        "        self.decoyOnly()",
        "    }",
        "}",
        "",
        "class U: UIKit.UIView {",
        "    func run() {",
        "        self.draw()",
        "    }",
        "}",
      ),
    },
    edges: ["P@Use.swift -extends-> Base@Decoy.swift", "W@Use.swift -extends-> Base@Other.swift"],
    subtypes: { "Base@Other.swift": ["W@Use.swift"], "Base@Decoy.swift": ["P@Use.swift"] },
    gotos: [
      { file: "Use.swift", marker: "realOnly()", expect: "realOnly@Other.swift" },
      { file: "Use.swift", marker: "shared()", expect: "shared@Other.swift" },
      { file: "Use.swift", marker: "decoyOnly()", occurrence: 0, expect: null },
      { file: "Use.swift", marker: "decoyOnly()", occurrence: 1, expect: "decoyOnly@Decoy.swift" },
      { file: "Use.swift", marker: "decoyOnly()", occurrence: 2, expect: null },
      { file: "Use.swift", marker: "draw()", expect: null },
      { file: "Use.swift", marker: "Other.Base", offset: 6, expect: "Base@Other.swift" },
      { file: "Use.swift", marker: "Empty.Base", offset: 6, expect: null },
      { file: "Use.swift", marker: "UIKit.UIView", offset: 6, expect: null },
    ],
    references: [
      { file: "Other.swift", marker: "shared()", includes: ["Use.swift:4"], excludes: [], coverage: "complete" },
      { file: "Decoy.swift", marker: "shared()", includes: [], excludes: ["Use.swift:4"], coverage: "complete" },
      {
        file: "Other.swift",
        marker: "Base",
        includes: ["Use.swift:1"],
        excludes: ["Use.swift:9"],
        // `Empty.Base` names no proven nested type, so it cannot be ruled out: coverage stays partial, never wrong.
        coverage: "partial",
      },
      {
        file: "Decoy.swift",
        marker: "Base",
        includes: ["Use.swift:9"],
        excludes: ["Use.swift:1"],
        coverage: "partial",
      },
    ],
  },
  {
    language: "Kotlin",
    files: {
      "other/Base.kt": lines("package other", "", "open class Base {", "    fun shared() {}", "}"),
      "decoy/Base.kt": lines("package decoy", "", "open class Base {", "    fun shared() {}", "}"),
      "app/Outer.kt": lines(
        "package app",
        "",
        "open class Outer {",
        "    open class Base {",
        "        fun nested() {}",
        "    }",
        "}",
      ),
      "app/W.kt": lines("package app", "", "import decoy.Base", "", "class W : other.Base()"),
      "app/P.kt": lines("package app", "", "import decoy.Base", "", "class P : Base()"),
      "app/N.kt": lines("package app", "", "import decoy.Base", "", "class N : Outer.Base()"),
      "app/X.kt": lines("package app", "", "import decoy.Base", "", "class X : kotlin.Exception()"),
      "app/Caller.kt": lines(
        "package app",
        "",
        "fun run() {",
        "    val w = W()",
        "    w.shared()",
        "    val n = N()",
        "    n.nested()",
        "}",
      ),
    },
    edges: [
      "N@app/N.kt -extends-> Base@app/Outer.kt",
      "P@app/P.kt -extends-> Base@decoy/Base.kt",
      "W@app/W.kt -extends-> Base@other/Base.kt",
    ],
    subtypes: {
      "Base@other/Base.kt": ["W@app/W.kt"],
      "Base@decoy/Base.kt": ["P@app/P.kt"],
      "Base@app/Outer.kt": ["N@app/N.kt"],
    },
    gotos: [
      { file: "app/W.kt", marker: "other.Base", offset: 6, expect: "Base@other/Base.kt" },
      { file: "app/N.kt", marker: "Outer.Base", offset: 6, expect: "Base@app/Outer.kt" },
      { file: "app/X.kt", marker: "kotlin.Exception", offset: 7, expect: null },
      { file: "app/Caller.kt", marker: "shared()", expect: "shared@other/Base.kt" },
      { file: "app/Caller.kt", marker: "nested()", expect: "nested@app/Outer.kt" },
    ],
    references: [
      {
        file: "other/Base.kt",
        marker: "Base {",
        includes: ["app/W.kt:5"],
        excludes: ["app/P.kt:5", "app/N.kt:5"],
        coverage: "complete",
      },
      {
        file: "decoy/Base.kt",
        marker: "Base {",
        includes: ["app/P.kt:5"],
        excludes: ["app/W.kt:5", "app/N.kt:5"],
        coverage: "complete",
      },
      {
        file: "app/Outer.kt",
        marker: "Base {",
        includes: ["app/N.kt:5"],
        excludes: ["app/W.kt:5", "app/P.kt:5"],
        coverage: "complete",
      },
      { file: "other/Base.kt", marker: "shared()", includes: ["app/Caller.kt:5"], excludes: [], coverage: "complete" },
      { file: "decoy/Base.kt", marker: "shared()", includes: [], excludes: ["app/Caller.kt:5"], coverage: "complete" },
      { file: "app/Outer.kt", marker: "nested()", includes: ["app/Caller.kt:7"], excludes: [], coverage: "complete" },
    ],
  },
  {
    language: "Java",
    files: {
      "other/Base.java": lines("package other;", "", "public class Base {", "    public void shared() {}", "}"),
      "decoy/Base.java": lines("package decoy;", "", "public class Base {", "    public void shared() {}", "}"),
      "app/Outer.java": lines(
        "package app;",
        "",
        "public class Outer {",
        "    public static class Base {",
        "        public void nested() {}",
        "    }",
        "}",
      ),
      "app/W.java": lines("package app;", "", "import decoy.Base;", "", "public class W extends other.Base {}"),
      "app/P.java": lines("package app;", "", "import decoy.Base;", "", "public class P extends Base {}"),
      "app/N.java": lines("package app;", "", "import decoy.Base;", "", "public class N extends Outer.Base {}"),
      "app/X.java": lines(
        "package app;",
        "",
        "import decoy.Base;",
        "",
        "public class X extends java.lang.Exception {}",
      ),
      "app/Caller.java": lines(
        "package app;",
        "",
        "public class Caller {",
        "    public void run() {",
        "        W w = new W();",
        "        w.shared();",
        "        N n = new N();",
        "        n.nested();",
        "    }",
        "}",
      ),
    },
    edges: [
      "N@app/N.java -extends-> Base@app/Outer.java",
      "P@app/P.java -extends-> Base@decoy/Base.java",
      "W@app/W.java -extends-> Base@other/Base.java",
    ],
    subtypes: {
      "Base@other/Base.java": ["W@app/W.java"],
      "Base@decoy/Base.java": ["P@app/P.java"],
      "Base@app/Outer.java": ["N@app/N.java"],
    },
    gotos: [
      { file: "app/W.java", marker: "other.Base", offset: 6, expect: "Base@other/Base.java" },
      { file: "app/N.java", marker: "Outer.Base", offset: 6, expect: "Base@app/Outer.java" },
      { file: "app/Caller.java", marker: "shared()", expect: "shared@other/Base.java" },
      { file: "app/Caller.java", marker: "nested()", expect: "nested@app/Outer.java" },
    ],
    references: [
      {
        file: "other/Base.java",
        marker: "shared()",
        includes: ["app/Caller.java:6"],
        excludes: [],
        coverage: "complete",
      },
      {
        file: "decoy/Base.java",
        marker: "shared()",
        includes: [],
        excludes: ["app/Caller.java:6"],
        coverage: "complete",
      },
      {
        file: "app/Outer.java",
        marker: "nested()",
        includes: ["app/Caller.java:8"],
        excludes: [],
        coverage: "complete",
      },
    ],
  },
  {
    language: "Go",
    files: {
      "go.mod": lines("module example.com/m", "", "go 1.21"),
      "other/base.go": lines("package other", "", "type Base struct{}", "", "func (Base) Shared() {}"),
      "app/w.go": lines(
        "package app",
        "",
        "import (",
        '\t"example.com/m/other"',
        '\t"time"',
        ")",
        "",
        "type W struct {",
        "\tother.Base",
        "}",
        "",
        "type T struct {",
        "\ttime.Time",
        "}",
        "",
        "type Base struct{}",
        "",
        "type P struct {",
        "\tBase",
        "}",
      ),
    },
    edges: ["P@app/w.go -implements-> Base@app/w.go", "W@app/w.go -implements-> Base@other/base.go"],
    subtypes: { "Base@other/base.go": ["W@app/w.go"], "Base@app/w.go": ["P@app/w.go"] },
    gotos: [
      { file: "app/w.go", marker: "other.Base", offset: 6, expect: "Base@other/base.go" },
      { file: "app/w.go", marker: "\tBase", offset: 1, expect: "Base@app/w.go" },
      { file: "app/w.go", marker: "time.Time", offset: 5, expect: null },
    ],
    references: [
      {
        file: "other/base.go",
        marker: "Base struct",
        includes: ["app/w.go:9"],
        excludes: ["app/w.go:19"],
        coverage: "complete",
      },
      {
        file: "app/w.go",
        marker: "Base struct",
        includes: ["app/w.go:19"],
        excludes: ["app/w.go:9"],
        coverage: "complete",
      },
    ],
  },
  {
    language: "JavaScript",
    files: {
      // `Helper` is the module's first export: a namespace import must never stand for it.
      "other.js": lines("export class Helper {}", "", "export class Base {", "  shared() {}", "}"),
      "decoy.js": lines("export class Base {", "  shared() {}", "}"),
      "use.js": lines('import * as ns from "./other.js";', "", "export class W extends ns.Base {}"),
      "ext.js": lines(
        'import * as ext from "external-lib";',
        'import { Base } from "./other.js";',
        "",
        "export class E extends ext.Base {}",
        "",
        "export class F extends Base {}",
      ),
    },
    edges: ["F@ext.js -extends-> Base@other.js", "W@use.js -extends-> Base@other.js"],
    subtypes: { "Base@other.js": ["F@ext.js", "W@use.js"] },
    gotos: [
      { file: "use.js", marker: "ns.Base", offset: 3, expect: "Base@other.js" },
      { file: "ext.js", marker: "ext.Base", offset: 4, expect: null },
    ],
    references: [
      // The external `ext.Base` is not provably another class, so coverage stays partial, but it is never listed.
      {
        file: "other.js",
        marker: "Base {",
        includes: ["use.js:3", "ext.js:6"],
        excludes: ["ext.js:4"],
        coverage: "partial",
      },
      {
        file: "decoy.js",
        marker: "Base {",
        includes: [],
        excludes: ["use.js:3", "ext.js:6", "ext.js:4"],
        coverage: "complete",
      },
    ],
  },
];

export function positionOf(files: Readonly<Record<string, string>>, site: Site): { line: number; column: number } {
  const text = files[site.file];
  if (text === undefined) throw new Error(`No fixture file ${site.file}`);
  let at = -1;
  for (let occurrence = 0; occurrence <= (site.occurrence ?? 0); occurrence += 1)
    at = text.indexOf(site.marker, at + 1);
  if (at < 0) throw new Error(`No ${site.marker} in ${site.file}`);
  const before = text.slice(0, at);
  return { line: before.split("\n").length, column: at - (before.lastIndexOf("\n") + 1) + 1 + (site.offset ?? 0) };
}

const HERITAGE_LABELS: Record<string, true> = { extends: true, implements: true, trait: true, mixin: true };
const TYPE_NODE_KINDS: Record<string, true> = { class: true, interface: true, type: true };

/**
 * Asserts the qualified base facts of `fixture` from an index of its files rooted at `root`: the heritage edges, the
 * subtypes of each base, go-to-definition through the base and on its last name, and references with their coverage
 * state. The same-named decoy, the unqualified base, and the undeclared qualifier stay out of every real answer.
 */
export async function expectQualifiedBases(
  root: string,
  index: ProjectIndex,
  graph: SymbolGraph,
  fixture: QualifiedBaseFixture,
  phase: string,
): Promise<void> {
  const label = `${fixture.language} ${phase}`;
  const relative = (file: string): string => path.posix.relative(normalizePath(root), normalizePath(file));
  const keyOf = (id: string): string => {
    const node = graph.nodes.get(id);
    return node ? `${node.name}@${relative(node.file)}` : "<missing>";
  };

  const edges = graph.edges
    .filter((edge) => edge.label && HERITAGE_LABELS[edge.label])
    .map((edge) => `${keyOf(edge.from)} -${edge.label}-> ${keyOf(edge.to)}`)
    .sort();
  expect(edges, `${label} heritage edges`).toEqual([...fixture.edges].sort());

  for (const [base, children] of Object.entries(fixture.subtypes)) {
    const nodes = [...graph.nodes.values()].filter((node) => TYPE_NODE_KINDS[node.kind] && keyOf(node.id) === base);
    expect(nodes.length, `${label} type node ${base}`).toBe(1);
    const hierarchy = findTypeHierarchy(graph, nodes[0]!.id, "sub", { depth: 1 });
    if (hierarchy.status !== "ok") throw new Error(`${label}: expected subtypes of ${base}`);
    expect(hierarchy.relations.map((relation) => keyOf(relation.targetId)).sort(), `${label} ${base}`).toEqual(
      [...children].sort(),
    );
  }

  for (const site of fixture.gotos) {
    const result = await goToDefinition(index, {
      file: path.join(root, site.file),
      ...positionOf(fixture.files, site),
    });
    const actual = result.status === "ok" ? `${result.definition.localName}@${relative(result.definition.file)}` : null;
    expect(actual, `${label} go to ${site.file} ${site.marker}`).toBe(site.expect);
  }

  for (const site of fixture.references) {
    const result = await findReferences(index, {
      file: path.join(root, site.file),
      ...positionOf(fixture.files, site),
    });
    if (result.status !== "ok") throw new Error(`${label}: no references for ${site.file} ${site.marker}`);
    const uses = result.references.map((reference) => `${relative(reference.file)}:${reference.range.start.line}`);
    const where = `${label} references of ${site.file} ${site.marker}`;
    for (const included of site.includes) expect(uses, where).toContain(included);
    for (const excluded of site.excludes) expect(uses, where).not.toContain(excluded);
    expect(result.referenceCoverage.state, `${where} coverage`).toBe(site.coverage);
  }
}
