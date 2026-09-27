/**
 * 2026-09-25 accuracy audit: F1 (cross-consumer agreement), G3 (Go qualified-call `calls` edge),
 * G4 (Ruby cross-file `extends`/`include`/`extend` edges), G5 (TS static-call `calls` edge).
 *
 * Each fixture is asserted through `goToDefinition`, `findReferences`, and
 * `buildSymbolGraphDetailed` together via `tests/helpers/consumer-agreement.ts`, so a future fix
 * that makes one consumer disagree with the others fails here. The language spread proves
 * agreement holds for forms unrelated to G3-G5, across every language named in the assignment.
 */
import { describe, expect, it } from "vitest";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  findDetailedNode,
} from "./helpers/consumer-agreement.js";

// The detailed graph requires the native Tree-sitter runtime; skip the whole suite instead of
// asserting native-only behavior on a host that cannot run it.
const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;

nativeDescribe("G3: Go package-qualified call produces a calls edge", () => {
  it("resolves u.Square() to the imported package function and records a calls edge", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-g3-basic-", {
      "go.mod": "module example.com/proj\n\ngo 1.22\n",
      "util/util.go": "package util\n\nfunc Square(x float64) float64 { return x * x }\n",
      "main/main.go": 'package main\n\nimport u "example.com/proj/util"\n\nfunc main() {\n\t_ = u.Square(3.0)\n}\n',
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "main/main.go",
        line: 6,
        token: "Square",
        expected: { file: "util/util.go", line: 3 },
        edges: [{ label: "calls", from: { file: "main/main.go", name: "main" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("does not let a local variable shadowing the package alias resolve through the package", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-g3-decoy-", {
      "go.mod": "module example.com/proj\n\ngo 1.22\n",
      "util/util.go": "package util\n\nfunc Square(x float64) float64 { return x * x }\n",
      "main/local.go":
        "package main\n\ntype LocalU struct{}\n\nfunc (l LocalU) Square() float64 { return -1 }\n\n" +
        "func useLocal() float64 {\n\tu := LocalU{}\n\treturn u.Square()\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "main/local.go",
        line: 9,
        token: "Square",
        expected: { file: "main/local.go", line: 5 },
        edges: [
          { label: "calls", from: { file: "main/local.go", name: "useLocal" } },
          {
            label: "calls",
            from: { file: "main/local.go", name: "useLocal" },
            to: { file: "util/util.go", name: "Square" },
            absent: true,
          },
        ],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });
});

nativeDescribe("G4: Ruby cross-file class/include/extend produce detailed-graph edges", () => {
  it("records extends and mixin (include + extend) edges for cross-file targets goto resolves", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-g4-basic-", {
      "ruby_base.rb": "class RubyBase\nend\n",
      "greetable.rb": 'module Greetable\n  def greet\n    "hi"\n  end\nend\n',
      "ruby_worker.rb":
        'require_relative "ruby_base"\nrequire_relative "greetable"\n\n' +
        "class RubyWorker < RubyBase\n  include Greetable\n  extend Greetable\nend\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "ruby_worker.rb",
        line: 4,
        token: "RubyBase",
        expected: { file: "ruby_base.rb", line: 1 },
        checkReferences: false,
        edges: [{ label: "extends", from: { file: "ruby_worker.rb", name: "RubyWorker" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "ruby_worker.rb",
        line: 5,
        token: "Greetable",
        expected: { file: "greetable.rb", line: 1 },
        checkReferences: false,
        edges: [{ label: "mixin", from: { file: "ruby_worker.rb", name: "RubyWorker" } }],
      });
      await assertConsumerAgreement(fixture, {
        file: "ruby_worker.rb",
        line: 6,
        token: "Greetable",
        expected: { file: "greetable.rb", line: 1 },
        checkReferences: false,
        edges: [{ label: "mixin", from: { file: "ruby_worker.rb", name: "RubyWorker" } }],
      });
      // include and extend must each contribute their own mixin edge, not one shared edge
      // that would still pass a plain existence check.
      const workerNode = findDetailedNode(fixture, "ruby_worker.rb", "RubyWorker");
      const greetableNode = findDetailedNode(fixture, "greetable.rb", "Greetable");
      const mixinEdgeCount = fixture.graph.edges.filter(
        (edge) => edge.from === workerNode.id && edge.to === greetableNode.id && edge.label === "mixin",
      ).length;
      expect(mixinEdgeCount, "include and extend each record their own mixin edge").toBe(2);
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });
});

nativeDescribe("G5: TypeScript static method call produces a calls edge", () => {
  it("records a calls edge for Box.create() matching goToDefinition", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-g5-basic-", {
      "box.ts": "export class Box {\n  static create(): Box { return new Box(); }\n}\n",
      "use.ts": 'import { Box } from "./box";\nexport function run(): Box {\n  return Box.create();\n}\n',
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "use.ts",
        line: 3,
        token: "create",
        expected: { file: "box.ts", line: 2 },
        edges: [{ label: "calls", from: { file: "use.ts", name: "run" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("never attributes an unbound global or an unimported same-named class to the call", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-g5-decoy-", {
      "box.ts": "export class Box {\n  static create(): Box { return new Box(); }\n}\n",
      "decoy/box.ts": 'export class Box {\n  static create(): string { return "decoy"; }\n}\n',
      "use.ts":
        'import { Box } from "./box";\nexport function run(): number {\n' +
        "  const m = Math.max(1, 2);\n  Box.create();\n  return m;\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "use.ts",
        line: 4,
        token: "create",
        expected: { file: "box.ts", line: 2 },
        edges: [
          { label: "calls", from: { file: "use.ts", name: "run" } },
          {
            label: "calls",
            from: { file: "use.ts", name: "run" },
            to: { file: "decoy/box.ts", name: "create" },
            absent: true,
          },
        ],
      });
      // Math.max() names no project declaration to check "absent" against; prove it directly
      // by requiring run's only calls edge to be the real Box.create().
      const runNode = findDetailedNode(fixture, "use.ts", "run");
      const callsEdges = fixture.graph.edges.filter((edge) => edge.from === runNode.id && edge.label === "calls");
      expect(callsEdges, "Math.max() must not create any calls edge").toHaveLength(1);
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });
});

nativeDescribe("G6: star-import expansion must not overwrite an explicit alias", () => {
  it("Java: an explicit single-type import beats a wildcard package import for the call edge", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-g6-java-", {
      "pkg/a/Foo.java": "package pkg.a;\n\npublic class Foo {\n    public int hit() {\n        return 1;\n    }\n}\n",
      "pkg/b/Foo.java": "package pkg.b;\n\npublic class Foo {\n    public int hit() {\n        return 2;\n    }\n}\n",
      "app/Main.java":
        "package app;\n\nimport pkg.b.*;\nimport pkg.a.Foo;\n\npublic class Main {\n    public int run() {\n" +
        "        Foo instance = new Foo();\n        return instance.hit();\n    }\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "app/Main.java",
        line: 9,
        token: "hit",
        expected: { file: "pkg/a/Foo.java", line: 4 },
        edges: [
          { label: "calls", from: { file: "app/Main.java", name: "run" } },
          {
            label: "calls",
            from: { file: "app/Main.java", name: "run" },
            to: { file: "pkg/b/Foo.java", name: "hit" },
            absent: true,
          },
        ],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("Python: an explicit import written after a star import keeps last-wins for the call edge", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-g6-python-", {
      "a.py": "class Foo:\n    def hit(self):\n        return 1\n",
      "b.py": "class Foo:\n    def hit(self):\n        return 2\n",
      "main.py": "from a import *\nfrom b import Foo\n\n\ndef run():\n    return Foo().hit()\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "main.py",
        line: 6,
        token: "hit",
        expected: { file: "b.py", line: 2 },
        edges: [
          { label: "calls", from: { file: "main.py", name: "run" } },
          {
            label: "calls",
            from: { file: "main.py", name: "run" },
            to: { file: "a.py", name: "hit" },
            absent: true,
          },
        ],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("C#: two ambiguous `using` namespaces defining the same type produce no call edge to either", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-g6-cs-", {
      "P/Thing.cs":
        "namespace P {\n  public class Thing {\n    public static int Hit() {\n      return 1;\n    }\n  }\n}\n",
      "Q/Thing.cs":
        "namespace Q {\n  public class Thing {\n    public static int Hit() {\n      return 2;\n    }\n  }\n}\n",
      "Runner.cs":
        "using P;\nusing Q;\n\nnamespace Consumer {\n  public class Runner {\n    public int Run() {\n" +
        "      return Thing.Hit();\n    }\n  }\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "Runner.cs",
        line: 7,
        token: "Thing",
        expected: "not_found",
        sameNameDeclaration: { file: "P/Thing.cs", line: 3, token: "Hit" },
        edges: [
          {
            label: "calls",
            from: { file: "Runner.cs", name: "Run" },
            to: { file: "P/Thing.cs", name: "Hit" },
            absent: true,
          },
          {
            label: "calls",
            from: { file: "Runner.cs", name: "Run" },
            to: { file: "Q/Thing.cs", name: "Hit" },
            absent: true,
          },
        ],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });
});

describe("Cross-consumer agreement spread: already-working forms", () => {
  it("Python: cross-file class inheritance", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-py-", {
      "base.py": "class Base:\n    def greet(self):\n        return 1\n",
      "derived.py":
        "from base import Base\n\n\nclass Derived(Base):\n    pass\n\n\ndef run():\n    d = Derived()\n    return d.greet()\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "derived.py",
        line: 4,
        token: "Base",
        expected: { file: "base.py", line: 1 },
        edges: [{ label: "extends", from: { file: "derived.py", name: "Derived" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("Java: instance method call through a constructed local, cross-file", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-java-", {
      "com/example/Helper.java":
        "package com.example;\n\npublic class Helper {\n    public int compute() {\n        return 1;\n    }\n}\n",
      "com/example/use/Runner.java":
        "package com.example.use;\n\nimport com.example.Helper;\n\npublic class Runner {\n" +
        "    public int run() {\n        Helper h = new Helper();\n        return h.compute();\n    }\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "com/example/use/Runner.java",
        line: 8,
        token: "compute",
        expected: { file: "com/example/Helper.java", line: 4 },
        edges: [{ label: "calls", from: { file: "com/example/use/Runner.java", name: "run" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("C#: static method call through an explicit using, cross-file", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-cs-", {
      "Helper.cs":
        "namespace Example {\n  public class Helper {\n    public static int Compute() {\n      return 1;\n    }\n  }\n}\n",
      "Runner.cs":
        "using Example;\n\nnamespace Consumer {\n  public class Runner {\n    public int Run() {\n      return Helper.Compute();\n    }\n  }\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "Runner.cs",
        line: 6,
        token: "Compute",
        expected: { file: "Helper.cs", line: 3 },
        edges: [{ label: "calls", from: { file: "Runner.cs", name: "Run" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("Go: same-package unqualified receiver call (no package selector)", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-go-", {
      "go.mod": "module example.test/shapes\n\ngo 1.22\n",
      "shapes.go":
        "package shapes\n\ntype Circle struct {\n\tRadius float64\n}\n\nfunc (c Circle) Area() float64 {\n\treturn c.Radius * c.Radius\n}\n\n" +
        "func Run() float64 {\n\tc := Circle{Radius: 2.0}\n\treturn c.Area()\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "shapes.go",
        line: 13,
        token: "Area",
        expected: { file: "shapes.go", line: 7 },
        edges: [{ label: "calls", from: { file: "shapes.go", name: "Run" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("Rust: same-file self-dispatch to another impl method", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-rust-", {
      "Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
      "src/lib.rs":
        "pub struct Circle {\n    pub radius: f64,\n}\n\nimpl Circle {\n    pub fn area(&self) -> f64 {\n" +
        "        self.radius * self.radius\n    }\n\n    pub fn describe(&self) -> f64 {\n        self.area() * 2.0\n    }\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "src/lib.rs",
        line: 11,
        token: "area",
        expected: { file: "src/lib.rs", line: 6 },
        edges: [{ label: "calls", from: { file: "src/lib.rs", name: "describe" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("Ruby: cross-file extends (reused from G4, proving the same fixture generalizes)", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-ruby-", {
      "ruby_base.rb": "class RubyBase\nend\n",
      "ruby_worker.rb": 'require_relative "ruby_base"\n\nclass RubyWorker < RubyBase\nend\n',
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "ruby_worker.rb",
        line: 3,
        token: "RubyBase",
        expected: { file: "ruby_base.rb", line: 1 },
        checkReferences: false,
        edges: [{ label: "extends", from: { file: "ruby_worker.rb", name: "RubyWorker" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("PHP: static call through an explicit use import, cross-file", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-php-", {
      "Helper.php":
        "<?php\nnamespace App;\n\nclass Helper {\n  public static function compute() {\n    return 1;\n  }\n}\n",
      "run.php": "<?php\nnamespace Consumer;\n\nuse App\\Helper;\n\nfunction run() {\n  return Helper::compute();\n}\n",
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "run.php",
        line: 7,
        token: "compute",
        expected: { file: "Helper.php", line: 5 },
        edges: [{ label: "calls", from: { file: "run.php", name: "run" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("C: quoted-include prototype resolves a cross-file call", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-c-", {
      "util.h": "#ifndef UTIL_H\n#define UTIL_H\nint compute(void);\n#endif\n",
      "util.c": '#include "util.h"\nint compute(void) {\n  return 1;\n}\n',
      "run.c": '#include "util.h"\nint run(void) {\n  return compute();\n}\n',
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "run.c",
        line: 3,
        token: "compute",
        expected: { file: "util.h", line: 3 },
        edges: [{ label: "calls", from: { file: "run.c", name: "run" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });

  it("C++: method call through a proven parameter receiver, cross-file", async () => {
    const fixture = await buildConsumerAgreementFixture("cg-audit-spread-cpp-", {
      "box.hpp": "class Box {\npublic:\n  int run();\n};\n",
      "box.cpp": '#include "box.hpp"\nint Box::run() {\n  return 1;\n}\n',
      "use.cpp": '#include "box.hpp"\nint call(Box& box) {\n  return box.run();\n}\n',
    });
    try {
      await assertConsumerAgreement(fixture, {
        file: "use.cpp",
        line: 3,
        token: "run",
        expected: { file: "box.hpp", line: 3 },
        edges: [{ label: "calls", from: { file: "use.cpp", name: "call" } }],
      });
    } finally {
      await disposeConsumerAgreementFixture(fixture);
    }
  });
});
