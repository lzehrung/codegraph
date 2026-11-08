import { afterAll, describe, expect, it } from "vitest";
import { isNativeTreeSitterAvailable } from "../src/native/tree-sitter-native.js";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  findDetailedNode,
  type ConsumerAgreementFixture,
  type ConsumerAgreementSite,
} from "./helpers/consumer-agreement.js";

/**
 * `super`, `this`, and bare member calls inside an unnamed type body (Java `new Base() { ... }`, Kotlin
 * `object : Base() { ... }`, PHP `new class extends Base { ... }`, a JavaScript or TypeScript class
 * expression) belong to that body's own members and base type. Each site must reach the same declaration
 * through `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed`, never the enclosing type's.
 */
const nativeDescribe = isNativeTreeSitterAvailable() ? describe : describe.skip;
const fixtures: ConsumerAgreementFixture[] = [];

afterAll(async () => {
  for (const fixture of fixtures) await disposeConsumerAgreementFixture(fixture);
});

async function fixtureFor(prefix: string, files: Record<string, string>): Promise<ConsumerAgreementFixture> {
  const fixture = await buildConsumerAgreementFixture(prefix, files);
  fixtures.push(fixture);
  return fixture;
}

/** 1-based line of the `occurrence`-th source line that contains `needle`. */
function lineOf(files: Record<string, string>, file: string, needle: string, occurrence = 1): number {
  const source = files[file];
  if (source === undefined) throw new Error(`no fixture file ${file}`);
  let seen = 0;
  for (const [index, text] of source.split("\n").entries()) {
    if (!text.includes(needle)) continue;
    seen += 1;
    if (seen === occurrence) return index + 1;
  }
  throw new Error(`${file} has no line ${occurrence} containing ${needle}`);
}

/** Names of the `calls` targets of the one function named `name` in `file`. */
function callTargets(fixture: ConsumerAgreementFixture, file: string, name: string): string[] {
  const from = findDetailedNode(fixture, file, name);
  return fixture.graph.edges
    .filter((edge) => edge.label === "calls" && edge.from === from.id)
    .map((edge) => fixture.graph.nodes.get(edge.to)?.name ?? edge.to)
    .sort();
}

async function assertSites(fixture: ConsumerAgreementFixture, sites: readonly ConsumerAgreementSite[]): Promise<void> {
  for (const site of sites) await assertConsumerAgreement(fixture, site);
}

const JAVA_FILES: Record<string, string> = {
  "base/Base.java": [
    "package base;",
    "",
    "public class Base {",
    '    public String run() { return "Base.run"; }',
    '    public String run(int count) { return "Base.run(int)"; }',
    '    public String pick() { return "Base.pick"; }',
    '    public String both() { return "Base.both"; }',
    '    public String baseOnly() { return "Base.baseOnly"; }',
    "}",
    "",
  ].join("\n"),
  // A same-named base in a package that no use site imports.
  "decoy/Base.java": [
    "package decoy;",
    "",
    "public class Base {",
    '    public String run() { return "decoy.Base.run"; }',
    '    public String pick() { return "decoy.Base.pick"; }',
    "}",
    "",
  ].join("\n"),
  "app/Outer.java": [
    "package app;",
    "",
    "import base.Base;",
    "",
    "class OuterBase {",
    '    public String both() { return "OuterBase.both"; }',
    '    public String outerInherited() { return "OuterBase.outerInherited"; }',
    '    public String outerOnly() { return "OuterBase.outerOnly"; }',
    "}",
    "",
    "class Mid extends Base {",
    "    @Override",
    '    public String pick() { return "Mid.pick"; }',
    "}",
    "",
    "public class Outer extends OuterBase {",
    '    public String own() { return "Outer.own"; }',
    "",
    "    public String outerSuper() { return super.outerOnly() + super.both(); }",
    "",
    "    public String inAnonymous() {",
    "        Base anon = new Base() {",
    "            public String execute() {",
    "                String zero = super.run();",
    "                String one = super.run(1);",
    "                return zero + one + this.pick() + both() + baseOnly() + own() + outerInherited();",
    "            }",
    "        };",
    "        return anon.run();",
    "    }",
    "",
    "    public String inMid() {",
    "        Mid anon = new Mid() {",
    "            public String viaMid() {",
    "                return super.pick() + this.pick() + super.run();",
    "            }",
    "        };",
    "        return anon.run();",
    "    }",
    "",
    "    public String nested() {",
    "        Base anon = new Base() {",
    "            public String outerLevel() {",
    "                Mid inner = new Mid() {",
    "                    public String innerLevel() {",
    "                        return super.pick() + this.pick() + baseOnly();",
    "                    }",
    "                };",
    "                return super.run() + inner.run();",
    "            }",
    "        };",
    "        return anon.run();",
    "    }",
    "}",
    "",
  ].join("\n"),
};

const KOTLIN_FILES: Record<string, string> = {
  "base/Base.kt": [
    "package base",
    "",
    'open class Base(val source: String = "s") {',
    '    open fun run(): String = "Base.run"',
    '    open fun run(count: Int): String = "Base.run(int)"',
    '    open fun pick(): String = "Base.pick"',
    '    open fun both(): String = "Base.both"',
    '    open fun baseOnly(): String = "Base.baseOnly"',
    "}",
    "",
    "interface Face {",
    '    fun act(): String = "Face.act"',
    "}",
    "",
  ].join("\n"),
  // A same-named base in a package that no use site imports.
  "decoy/Base.kt": [
    "package decoy",
    "",
    'open class Base(val source: String = "s") {',
    '    open fun run(): String = "decoy.Base.run"',
    '    open fun pick(): String = "decoy.Base.pick"',
    "}",
    "",
  ].join("\n"),
  "app/Outer.kt": [
    "package app",
    "",
    "import base.Base",
    "import base.Face",
    "",
    "open class OuterBase {",
    '    open fun both(): String = "OuterBase.both"',
    '    open fun outerInherited(): String = "OuterBase.outerInherited"',
    '    open fun outerOnly(): String = "OuterBase.outerOnly"',
    "}",
    "",
    "open class Mid : Base() {",
    '    override fun pick(): String = "Mid.pick"',
    "}",
    "",
    "class Outer : OuterBase() {",
    '    fun own(): String = "Outer.own"',
    "",
    "    fun outerSuper(): String = super.outerOnly() + super.both()",
    "",
    "    fun inAnonymous(): Base {",
    '        return object : Base("x") {',
    "            fun execute(): String {",
    "                val zero = super.run()",
    "                val one = super.run(1)",
    "                return zero + one + this.pick() + both() + baseOnly() + own() + outerInherited()",
    "            }",
    "        }",
    "    }",
    "",
    "    fun inMid(): Mid {",
    "        return object : Mid() {",
    "            fun viaMid(): String {",
    "                return super.pick() + this.pick() + super.run()",
    "            }",
    "        }",
    "    }",
    "",
    "    fun nested(): Base {",
    "        return object : Base() {",
    "            fun outerLevel(): String {",
    "                val inner = object : Mid() {",
    "                    fun innerLevel(): String {",
    "                        return super.pick() + this.pick() + baseOnly()",
    "                    }",
    "                }",
    "                return super.run() + inner.pick()",
    "            }",
    "        }",
    "    }",
    "",
    "    fun faceAnonymous(): Face {",
    "        return object : Face {",
    "            override fun act(): String = super.act()",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n"),
};

/** The site list shared by the Java and Kotlin fixtures, which declare the same members on the same lines. */
function jvmSites(files: Record<string, string>, ext: "java" | "kt"): ConsumerAgreementSite[] {
  const app = `app/Outer.${ext}`;
  const base = `base/Base.${ext}`;
  const fun = ext === "java" ? "String" : "fun";
  const baseAt = (needle: string): number => lineOf(files, base, needle);
  const appAt = (needle: string, occurrence = 1): number => lineOf(files, app, needle, occurrence);
  const anonymousCalls = appAt("return zero + one + this.pick()");
  const zeroCall = appAt("zero = super.run(");
  const oneCall = appAt("one = super.run(1)");
  const midCalls = appAt("super.pick() + this.pick() + super.run()");
  const innerCalls = appAt("super.pick() + this.pick() + baseOnly()");
  const outerLevelCalls = appAt("return super.run() + inner.");
  const runDeclaration = ext === "java" ? "String run()" : "fun run()";
  const midPick = ext === "java" ? "String pick()" : "fun pick()";
  const midDeclaration = { file: app, line: appAt(midPick) };
  return [
    {
      file: app,
      line: zeroCall,
      token: "run",
      expected: { file: base, line: baseAt(runDeclaration) },
      requireCompleteCoverage: true,
      edges: [{ label: "calls", from: { file: app, name: "execute" } }],
    },
    {
      file: app,
      line: oneCall,
      token: "run",
      expected: { file: base, line: baseAt(ext === "java" ? "String run(int" : "fun run(count") },
      edges: [{ label: "calls", from: { file: app, name: "execute" } }],
    },
    {
      file: app,
      line: anonymousCalls,
      token: "pick",
      expected: { file: base, line: baseAt(`${fun} pick()`) },
      edges: [{ label: "calls", from: { file: app, name: "execute" } }],
    },
    {
      // The anonymous body's inherited member precedes the enclosing type's own `both`.
      file: app,
      line: anonymousCalls,
      token: "both",
      expected: { file: base, line: baseAt(`${fun} both()`) },
      edges: [{ label: "calls", from: { file: app, name: "execute" } }],
    },
    {
      file: app,
      line: anonymousCalls,
      token: "baseOnly",
      expected: { file: base, line: baseAt(`${fun} baseOnly()`) },
      edges: [{ label: "calls", from: { file: app, name: "execute" } }],
    },
    {
      // A name the anonymous body lacks continues to the enclosing type, and to what that type inherits.
      file: app,
      line: anonymousCalls,
      token: "own",
      expected: { file: app, line: appAt(`${fun} own()`) },
      edges: [{ label: "calls", from: { file: app, name: "execute" } }],
    },
    {
      file: app,
      line: anonymousCalls,
      token: "outerInherited",
      expected: { file: app, line: appAt(`${fun} outerInherited()`) },
      edges: [{ label: "calls", from: { file: app, name: "execute" } }],
    },
    {
      // The decoy base is in a package nothing imports: no site in the body may reach it.
      file: app,
      line: zeroCall,
      token: "run",
      mustNotMatch: {
        file: `decoy/Base.${ext}`,
        line: lineOf(files, `decoy/Base.${ext}`, runDeclaration),
        token: "run",
      },
      provablyNotAReference: true,
    },
    {
      // An anonymous body extending a class that overrides `pick` reaches the override, then the class's base.
      file: app,
      line: midCalls,
      token: "pick",
      expected: midDeclaration,
      edges: [{ label: "calls", from: { file: app, name: "viaMid" } }],
    },
    {
      file: app,
      line: midCalls,
      token: "pick",
      occurrence: 2,
      expected: midDeclaration,
      edges: [{ label: "calls", from: { file: app, name: "viaMid" } }],
    },
    {
      file: app,
      line: midCalls,
      token: "run",
      expected: { file: base, line: baseAt(runDeclaration) },
      edges: [{ label: "calls", from: { file: app, name: "viaMid" } }],
    },
    {
      // Nested anonymous bodies each own their `super`.
      file: app,
      line: innerCalls,
      token: "pick",
      expected: midDeclaration,
      edges: [{ label: "calls", from: { file: app, name: "innerLevel" } }],
    },
    {
      file: app,
      line: innerCalls,
      token: "baseOnly",
      expected: { file: base, line: baseAt(`${fun} baseOnly()`) },
      edges: [{ label: "calls", from: { file: app, name: "innerLevel" } }],
    },
    {
      file: app,
      line: outerLevelCalls,
      token: "run",
      expected: { file: base, line: baseAt(runDeclaration) },
      edges: [{ label: "calls", from: { file: app, name: "outerLevel" } }],
    },
    {
      // The enclosing class's own `super` still names its own base.
      file: app,
      line: appAt("outerSuper()"),
      token: "outerOnly",
      expected: { file: app, line: appAt(`${fun} outerOnly()`) },
      edges: [{ label: "calls", from: { file: app, name: "outerSuper" } }],
    },
    {
      file: app,
      line: appAt("outerSuper()"),
      token: "both",
      expected: { file: app, line: appAt(`${fun} both()`) },
      edges: [{ label: "calls", from: { file: app, name: "outerSuper" } }],
    },
  ];
}

nativeDescribe("anonymous class and object bodies own super and this", () => {
  it("resolves Java anonymous class members through goto, references, and the graph", async () => {
    const fixture = await fixtureFor("cg-anon-owner-java-", JAVA_FILES);
    await assertSites(fixture, jvmSites(JAVA_FILES, "java"));
  });

  it("resolves Kotlin object expression members through goto, references, and the graph", async () => {
    const fixture = await fixtureFor("cg-anon-owner-kotlin-", KOTLIN_FILES);
    await assertSites(fixture, jvmSites(KOTLIN_FILES, "kt"));
  });

  it("gives an object expression over an interface no super edge", async () => {
    const fixture = await fixtureFor("cg-anon-owner-kotlin-face-", KOTLIN_FILES);
    const app = "app/Outer.kt";
    // `super` follows class ancestors only, so a sole interface supertype leaves `super.act()` open.
    await assertConsumerAgreement(fixture, {
      file: app,
      line: lineOf(KOTLIN_FILES, app, "override fun act()"),
      token: "act",
      occurrence: 2,
      expected: "not_found",
      sameNameDeclaration: {
        file: "base/Base.kt",
        line: lineOf(KOTLIN_FILES, "base/Base.kt", "fun act()"),
        token: "act",
      },
      edges: [{ label: "calls", from: { file: app, name: "act" }, absent: true }],
    });
    expect(callTargets(fixture, app, "act")).toEqual([]);
  });

  it("does not count members of an anonymous body as members of the enclosing type", async () => {
    for (const ext of ["java", "kt"] as const) {
      const java = ext === "java";
      const files: Record<string, string> = java
        ? {
            "app/Handler.java": [
              "package app;",
              "",
              "public interface Handler {",
              "    void handle(String event);",
              "}",
              "",
            ].join("\n"),
            "app/Registry.java": [
              "package app;",
              "",
              "public class Registry {",
              "    public static final Handler DEFAULT = new Handler() {",
              "        @Override",
              "        public void handle(String event) {}",
              "",
              "        public void onlyOnAnonymous() {}",
              "    };",
              "",
              "    public void own() {}",
              "}",
              "",
            ].join("\n"),
            "app/Use.java": [
              "package app;",
              "",
              "public class Use {",
              "    public void go(Registry registry) {",
              "        registry.own();",
              "        registry.onlyOnAnonymous();",
              '        registry.handle("x");',
              "    }",
              "}",
              "",
            ].join("\n"),
          }
        : {
            "app/Handler.kt": ["package app", "", "interface Handler {", "    fun handle(event: String)", "}", ""].join(
              "\n",
            ),
            "app/Registry.kt": [
              "package app",
              "",
              "class Registry {",
              "    val default: Handler = object : Handler {",
              "        override fun handle(event: String) {}",
              "",
              "        fun onlyOnAnonymous() {}",
              "    }",
              "",
              "    fun own() {}",
              "}",
              "",
            ].join("\n"),
            "app/Use.kt": [
              "package app",
              "",
              "class Use {",
              "    fun go(registry: Registry) {",
              "        registry.own()",
              "        registry.onlyOnAnonymous()",
              '        registry.handle("x")',
              "    }",
              "}",
              "",
            ].join("\n"),
          };
      const fixture = await fixtureFor(`cg-anon-owner-members-${ext}-`, files);
      const use = `app/Use.${ext}`;
      const registry = `app/Registry.${ext}`;
      await assertConsumerAgreement(fixture, {
        file: use,
        line: lineOf(files, use, "registry.own()"),
        token: "own",
        expected: { file: registry, line: lineOf(files, registry, java ? "void own()" : "fun own()") },
        edges: [{ label: "calls", from: { file: use, name: "go" } }],
      });
      // The anonymous body's members are not members of `Registry`: neither call may bind to them.
      for (const missing of ["onlyOnAnonymous", "handle"]) {
        await assertConsumerAgreement(fixture, {
          file: use,
          line: lineOf(files, use, `registry.${missing}(`),
          token: missing,
          expected: "not_found",
        });
      }
      expect(callTargets(fixture, use, "go")).toEqual(["own"]);
    }
  });

  it("reads a qualified base of an anonymous body through its qualifier, never by its last name", async () => {
    const cases = [
      {
        prefix: "cg-anon-owner-qualified-java-",
        files: {
          "base/Base.java": [
            "package base;",
            "",
            "public class Base {",
            "    public String run() {",
            '        return "base";',
            "    }",
            "}",
            "",
          ].join("\n"),
          "decoy/Base.java": [
            "package decoy;",
            "",
            "public class Base {",
            "    public String run() {",
            '        return "decoy";',
            "    }",
            "}",
            "",
          ].join("\n"),
          "app/Use.java": [
            "package app;",
            "",
            "public class Use {",
            "    public Object go() {",
            "        return new base.Base() {",
            "            public String execute() {",
            "                return super.run();",
            "            }",
            "        };",
            "    }",
            "}",
            "",
          ].join("\n"),
        },
        use: "app/Use.java",
        base: { file: "base/Base.java", declaration: "String run()" },
        decoy: { file: "decoy/Base.java", declaration: "String run()" },
      },
      {
        prefix: "cg-anon-owner-qualified-kotlin-",
        files: {
          "base/Outer.kt": [
            "package base",
            "",
            "open class Outer {",
            "    open class Base {",
            '        open fun run(): String = "base"',
            "    }",
            "}",
            "",
          ].join("\n"),
          "decoy/Outer.kt": [
            "package decoy",
            "",
            "open class Outer {",
            "    open class Base {",
            '        open fun run(): String = "decoy"',
            "    }",
            "}",
            "",
          ].join("\n"),
          "app/Use.kt": [
            "package app",
            "",
            "import base.Outer",
            "",
            "fun go(): Any {",
            "    return object : Outer.Base() {",
            "        fun execute(): String = super.run()",
            "    }",
            "}",
            "",
          ].join("\n"),
        },
        use: "app/Use.kt",
        base: { file: "base/Outer.kt", declaration: "fun run()" },
        decoy: { file: "decoy/Outer.kt", declaration: "fun run()" },
      },
      {
        prefix: "cg-anon-owner-qualified-ts-",
        files: {
          "base.ts": ["export class Base {", "  run(): string {", '    return "base";', "  }", "}", ""].join("\n"),
          "decoy.ts": ["export class Base {", "  run(): string {", '    return "decoy";', "  }", "}", ""].join("\n"),
          "use.ts": [
            'import * as ns from "./base";',
            "",
            "export const Anonymous = class extends ns.Base {",
            "  execute(): string {",
            "    return super.run();",
            "  }",
            "};",
            "",
          ].join("\n"),
        },
        use: "use.ts",
        base: { file: "base.ts", declaration: "run(): string" },
        decoy: { file: "decoy.ts", declaration: "run(): string" },
      },
    ];
    for (const { prefix, files, use, base, decoy } of cases) {
      const fixture = await fixtureFor(prefix, files);
      const line = lineOf(files, use, "super.run()");
      await assertConsumerAgreement(fixture, {
        file: use,
        line,
        token: "run",
        expected: { file: base.file, line: lineOf(files, base.file, base.declaration) },
        edges: [{ label: "calls", from: { file: use, name: "execute" } }],
      });
      // A same-named base in a package or module that the qualifier does not name must not match.
      await assertConsumerAgreement(fixture, {
        file: use,
        line,
        token: "run",
        mustNotMatch: { file: decoy.file, line: lineOf(files, decoy.file, decoy.declaration), token: "run" },
        provablyNotAReference: true,
      });
    }
  });

  it("leaves a qualified base unproven when its qualifier is a parameter, beside the import-bound form", async () => {
    const files: Record<string, string> = {
      "other.ts": ["export class Base {", "  run(): number {", "    return 1;", "  }", "}", ""].join("\n"),
      "mixin.ts": [
        'import * as ns from "./other";',
        "",
        "export const Mixin = (ns: { Base: new () => { run(): number } }) =>",
        "  class extends ns.Base {",
        "    exercise(): number {",
        "      return super.run() + 1;",
        "    }",
        "  };",
        "",
        "export const Direct = class extends ns.Base {",
        "  perform(): number {",
        "    return super.run() + 2;",
        "  }",
        "};",
        "",
      ].join("\n"),
    };
    const fixture = await fixtureFor("cg-anon-owner-ts-qualifier-", files);
    const run = { file: "other.ts", line: lineOf(files, "other.ts", "run(): number"), token: "run" };
    // `ns` in the mixin is its parameter, so the namespace import of the same name does not qualify the base.
    await assertConsumerAgreement(fixture, {
      file: "mixin.ts",
      line: lineOf(files, "mixin.ts", "super.run() + 1"),
      token: "run",
      expected: "not_found",
      sameNameDeclaration: run,
      edges: [{ label: "calls", from: { file: "mixin.ts", name: "exercise" }, absent: true }],
    });
    // Outside the mixin `ns` is the namespace import, so the same qualifier resolves.
    await assertConsumerAgreement(fixture, {
      file: "mixin.ts",
      line: lineOf(files, "mixin.ts", "super.run() + 2"),
      token: "run",
      expected: { file: run.file, line: run.line },
      edges: [{ label: "calls", from: { file: "mixin.ts", name: "perform" } }],
    });
    expect(callTargets(fixture, "mixin.ts", "exercise")).toEqual([]);
    expect(callTargets(fixture, "mixin.ts", "perform")).toEqual(["run"]);
  });

  it("resolves PHP anonymous class members through goto, references, and the graph", async () => {
    const files: Record<string, string> = {
      "Base.php": [
        "<?php",
        "namespace Sample;",
        "",
        "class Base {",
        "    public function close(): void {}",
        "    public function baseMethod(): int { return 1; }",
        '    public function describe(): string { return "base"; }',
        "}",
        "",
      ].join("\n"),
      "Decoy.php": [
        "<?php",
        "namespace Other;",
        "",
        "class Base {",
        "    public function baseMethod(): int { return 2; }",
        "}",
        "",
      ].join("\n"),
      "OuterBase.php": [
        "<?php",
        "namespace Sample;",
        "",
        "class OuterBase {",
        '    public function describe(): string { return "outerBase"; }',
        "    public function outerOnly(): int { return 1; }",
        "}",
        "",
      ].join("\n"),
      "Outer.php": [
        "<?php",
        "namespace Sample;",
        "",
        "class Outer extends OuterBase {",
        "    public function make() {",
        "        return new class extends Base {",
        "            public function execute(): int {",
        "                $this->close();",
        "                return parent::baseMethod() + strlen(parent::describe());",
        "            }",
        "        };",
        "    }",
        "",
        "    public function outerSuper(): int {",
        "        return parent::outerOnly() + strlen(parent::describe());",
        "    }",
        "}",
        "",
      ].join("\n"),
    };
    const fixture = await fixtureFor("cg-anon-owner-php-", files);
    const closeLine = lineOf(files, "Outer.php", "$this->close()");
    const parentCalls = lineOf(files, "Outer.php", "parent::baseMethod()");
    const outerCalls = lineOf(files, "Outer.php", "parent::outerOnly()");
    await assertSites(fixture, [
      {
        file: "Outer.php",
        line: closeLine,
        token: "close",
        expected: { file: "Base.php", line: lineOf(files, "Base.php", "function close()") },
        edges: [{ label: "calls", from: { file: "Outer.php", name: "execute" } }],
      },
      {
        file: "Outer.php",
        line: parentCalls,
        token: "baseMethod",
        expected: { file: "Base.php", line: lineOf(files, "Base.php", "function baseMethod()") },
        edges: [{ label: "calls", from: { file: "Outer.php", name: "execute" } }],
      },
      {
        file: "Outer.php",
        line: parentCalls,
        token: "baseMethod",
        mustNotMatch: {
          file: "Decoy.php",
          line: lineOf(files, "Decoy.php", "function baseMethod()"),
          token: "baseMethod",
        },
        provablyNotAReference: true,
      },
      {
        // `parent::describe()` in the body reaches the anonymous class's base, not the enclosing class's.
        file: "Outer.php",
        line: parentCalls,
        token: "describe",
        expected: { file: "Base.php", line: lineOf(files, "Base.php", "function describe()") },
        edges: [{ label: "calls", from: { file: "Outer.php", name: "execute" } }],
      },
      {
        file: "Outer.php",
        line: outerCalls,
        token: "describe",
        expected: { file: "OuterBase.php", line: lineOf(files, "OuterBase.php", "function describe()") },
        edges: [{ label: "calls", from: { file: "Outer.php", name: "outerSuper" } }],
      },
    ]);
  });

  it("resolves a TypeScript class expression's super and this calls in goto, references, and the graph", async () => {
    const files: Record<string, string> = {
      "base.ts": [
        "export class Base {",
        "  run(): number {",
        "    return 1;",
        "  }",
        "  close(): void {}",
        "  describe(): string {",
        '    return "base";',
        "  }",
        "}",
        "",
      ].join("\n"),
      "decoy.ts": ["export class Base {", "  run(): number {", "    return -1;", "  }", "}", ""].join("\n"),
      "outerbase.ts": [
        "export class OuterBase {",
        "  describe(): string {",
        '    return "outer";',
        "  }",
        "  outerOnly(): number {",
        "    return 1;",
        "  }",
        "}",
        "",
      ].join("\n"),
      "use.ts": [
        'import { Base } from "./base";',
        'import { OuterBase } from "./outerbase";',
        "",
        "export class Outer extends OuterBase {",
        "  make() {",
        "    const Derived = class extends Base {",
        "      exercise(): number {",
        "        this.close();",
        "        return super.run() + super.describe().length;",
        "      }",
        "    };",
        "    return new Derived();",
        "  }",
        "",
        "  outerSuper(): number {",
        "    return super.outerOnly() + super.describe().length;",
        "  }",
        "}",
        "",
      ].join("\n"),
    };
    const fixture = await fixtureFor("cg-anon-owner-ts-", files);
    const exerciseCalls = lineOf(files, "use.ts", "super.run()");
    await assertSites(fixture, [
      {
        file: "use.ts",
        line: lineOf(files, "use.ts", "this.close()"),
        token: "close",
        expected: { file: "base.ts", line: lineOf(files, "base.ts", "close(): void") },
        requireCompleteCoverage: true,
        edges: [{ label: "calls", from: { file: "use.ts", name: "exercise" } }],
      },
      {
        file: "use.ts",
        line: exerciseCalls,
        token: "run",
        expected: { file: "base.ts", line: lineOf(files, "base.ts", "run(): number") },
        requireCompleteCoverage: true,
        edges: [{ label: "calls", from: { file: "use.ts", name: "exercise" } }],
      },
      {
        file: "use.ts",
        line: exerciseCalls,
        token: "run",
        mustNotMatch: { file: "decoy.ts", line: lineOf(files, "decoy.ts", "run(): number"), token: "run" },
        provablyNotAReference: true,
      },
      {
        file: "use.ts",
        line: exerciseCalls,
        token: "describe",
        expected: { file: "base.ts", line: lineOf(files, "base.ts", "describe(): string") },
        edges: [{ label: "calls", from: { file: "use.ts", name: "exercise" } }],
      },
      {
        file: "use.ts",
        line: lineOf(files, "use.ts", "super.outerOnly()"),
        token: "outerOnly",
        expected: { file: "outerbase.ts", line: lineOf(files, "outerbase.ts", "outerOnly(): number") },
        edges: [{ label: "calls", from: { file: "use.ts", name: "outerSuper" } }],
      },
    ]);
  });

  it("leaves a mixin's parameter-named base unproven instead of resolving a same-named import", async () => {
    const files: Record<string, string> = {
      "base.ts": ["export class Base {", "  run(): number {", "    return 1;", "  }", "}", ""].join("\n"),
      "mixin.ts": [
        'import { Base } from "./base";',
        "",
        "export const Mixin = (Base: new () => { run(): number }) =>",
        "  class extends Base {",
        "    exercise(): number {",
        "      return super.run() + 1;",
        "    }",
        "  };",
        "",
        "export const Unrelated = Base;",
        "",
      ].join("\n"),
    };
    const fixture = await fixtureFor("cg-anon-owner-ts-mixin-", files);
    // `Base` in `extends Base` is the parameter, so the imported class is not the base.
    await assertConsumerAgreement(fixture, {
      file: "mixin.ts",
      line: lineOf(files, "mixin.ts", "super.run()"),
      token: "run",
      expected: "not_found",
      sameNameDeclaration: { file: "base.ts", line: lineOf(files, "base.ts", "run(): number"), token: "run" },
      edges: [{ label: "calls", from: { file: "mixin.ts", name: "exercise" }, absent: true }],
    });
    expect(callTargets(fixture, "mixin.ts", "exercise")).toEqual([]);
  });

  it("binds a call to the method that shares its name with a field or property, anonymous and named", async () => {
    // The Java and Kotlin sources below compile unchanged with javac and kotlinc.
    const sources = {
      java: [
        "package app;",
        "",
        "public class Holder {",
        "    static class Adapter {",
        '        public String read() { return "Adapter.read"; }',
        "    }",
        "",
        "    public static class Wrapper {",
        '        public String read() { return "Wrapper.read"; }',
        "    }",
        "",
        "    public String viaAnonymous() {",
        "        Wrapper wrapper = new Wrapper() {",
        "            private Adapter delegate;",
        "",
        "            public String fetch() {",
        "                return delegate().read() + this.delegate().read() + (delegate != null);",
        "            }",
        "",
        "            private Adapter delegate() {",
        "                if (delegate == null) delegate = new Adapter();",
        "                return delegate;",
        "            }",
        "        };",
        "        return wrapper.read();",
        "    }",
        "}",
        "",
        "class Named {",
        "    private int size = 3;",
        "",
        "    int size() { return size + 1; }",
        "",
        "    int total() { return size() + this.size() + size + this.size; }",
        "}",
        "",
        "class FieldOnly {",
        "    private int count = 1;",
        "",
        "    int twice() { return count + this.count; }",
        "}",
      ],
      kt: [
        "package app",
        "",
        "class Adapter {",
        '    fun read(): String = "Adapter.read"',
        "}",
        "",
        "open class Wrapper {",
        '    open fun read(): String = "Wrapper.read"',
        "}",
        "",
        "class Holder {",
        "    fun viaAnonymous(): Wrapper {",
        "        return object : Wrapper() {",
        "            private val delegate = Adapter()",
        "",
        "            fun fetch(): String = delegate().read() + this.delegate().read() + delegate.read()",
        "",
        "            private fun delegate(): Adapter = delegate",
        "        }",
        "    }",
        "}",
        "",
        "class Named {",
        "    private val size = 3",
        "",
        "    fun size(): Int = size + 1",
        "",
        "    fun total(): Int = size() + this.size() + size + this.size",
        "}",
        "",
        "class FieldOnly {",
        "    private val count = 1",
        "",
        "    fun twice(): Int = count + this.count",
        "}",
      ],
    };
    const needles = {
      java: {
        calls: "return delegate().read()",
        method: "private Adapter delegate() {",
        sizeMethod: "int size() {",
        total: "int total()",
        countField: "private int count = 1;",
        twice: "int twice()",
      },
      kt: {
        calls: "fun fetch()",
        method: "private fun delegate()",
        sizeMethod: "fun size()",
        total: "fun total()",
        countField: "private val count = 1",
        twice: "fun twice()",
      },
    };
    for (const ext of ["java", "kt"] as const) {
      const file = `app/Holder.${ext}`;
      const files: Record<string, string> = { [file]: `${sources[ext].join("\n")}\n` };
      const fixture = await fixtureFor(`cg-same-name-member-${ext}-`, files);
      const at = (needle: string): number => lineOf(files, file, needle);
      const n = needles[ext];
      const delegateMethod = { file, line: at(n.method) };
      const sizeMethod = { file, line: at(n.sizeMethod) };
      const countField = { file, line: at(n.countField) };
      await assertSites(fixture, [
        // A call names the method, never the field or property beside it, in an anonymous body and a named class.
        {
          file,
          line: at(n.calls),
          token: "delegate",
          expected: delegateMethod,
          edges: [{ label: "calls", from: { file, name: "fetch" } }],
        },
        {
          file,
          line: at(n.calls),
          token: "delegate",
          occurrence: 2,
          expected: delegateMethod,
          edges: [{ label: "calls", from: { file, name: "fetch" } }],
        },
        {
          file,
          line: at(n.total),
          token: "size",
          expected: sizeMethod,
          edges: [{ label: "calls", from: { file, name: "total" } }],
        },
        {
          file,
          line: at(n.total),
          token: "size",
          occurrence: 2,
          expected: sizeMethod,
          edges: [{ label: "calls", from: { file, name: "total" } }],
        },
        // A name with no method beside it is unchanged.
        { file, line: at(n.twice), token: "count", expected: countField },
        { file, line: at(n.twice), token: "count", occurrence: 2, expected: countField },
      ]);
      expect(callTargets(fixture, file, "fetch").filter((name) => name === "delegate")).toEqual([
        "delegate",
        "delegate",
      ]);
      expect(callTargets(fixture, file, "total")).toEqual(["size", "size"]);
    }
  });
});
