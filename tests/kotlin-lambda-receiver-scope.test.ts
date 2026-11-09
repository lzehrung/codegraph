import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  type ConsumerAgreementFixture,
} from "./helpers/consumer-agreement.js";

/**
 * What a lambda's receiver gives a bare call is limited to what Kotlin lets the call reach, and to what the project or a
 * well-known library declares. Every expected target follows a program compiled and run with kotlinc 2.4.21: an
 * inaccessible receiver member, an extension that is not in scope, and a nullable receiver's member all lose to the
 * enclosing type's same-named member; `launch`, `buildList`, `sequence` and SAM constructors leave a name they do not
 * declare to the enclosing type. Each case asserts go-to-definition, `findReferences`, the detailed graph, and the
 * same-named decoy that must stay out.
 */

function lineOf(source: string, needle: string): number {
  const line = source.split("\n").findIndex((text) => text.includes(needle));
  if (line < 0) throw new Error(`no line contains ${needle}`);
  return line + 1;
}

const LIB = [
  "package lib",
  "",
  "open class Base {",
  "    protected fun protBase(tag: String) {}",
  "}",
  "",
  "open class Hidden : Base() {",
  "    fun pub(tag: String) {}",
  "    private fun secret(tag: String) {}",
  "    protected fun prot(tag: String) {}",
  "    internal fun intern(tag: String) {}",
  "    fun callSecret(tag: String) { secret(tag) }",
  "}",
  "",
  "class Derived : Base()",
  "",
  "fun Hidden.extOnly(tag: String) {}",
  "fun Hidden.extImported(tag: String) {}",
  "private fun Hidden.hiddenExt(tag: String) {}",
  "",
  "fun buildHidden(block: Hidden.() -> Unit) { Hidden().block() }",
  "fun buildDerived(block: Derived.() -> Unit) { Derived().block() }",
  "fun buildNullable(block: Hidden?.() -> Unit) { val hidden: Hidden? = Hidden(); hidden.block() }",
  "",
].join("\n");

const VIS = [
  "package app",
  "",
  "import lib.buildDerived",
  "import lib.buildHidden",
  "import lib.buildNullable",
  "import lib.extImported",
  "",
  "class Vis {",
  "    fun pub(tag: String) {}",
  "    fun secret(tag: String) {}",
  "    fun prot(tag: String) {}",
  "    fun intern(tag: String) {}",
  "    fun extOnly(tag: String) {}",
  "    fun extImported(tag: String) {}",
  "    fun hiddenExt(tag: String) {}",
  "    fun protBase(tag: String) {}",
  "",
  '    fun viaPublic() { buildHidden { pub("viaPublic") } }',
  '    fun viaPrivate() { buildHidden { secret("viaPrivate") } }',
  '    fun viaProtected() { buildHidden { prot("viaProtected") } }',
  '    fun viaProtectedBase() { buildDerived { protBase("viaProtectedBase") } }',
  '    fun viaExtNotImported() { buildHidden { extOnly("viaExtNotImported") } }',
  '    fun viaExtImported() { buildHidden { extImported("viaExtImported") } }',
  '    fun viaPrivateExt() { buildHidden { hiddenExt("viaPrivateExt") } }',
  '    fun viaNullable() { buildNullable { pub("viaNullable") } }',
  '    fun viaInternal() { buildHidden { intern("viaInternal") } }',
  "}",
  "",
  "class Maker {",
  "    private fun secret(tag: String) {}",
  "}",
  "fun buildMaker(block: Maker.() -> Unit) { Maker().block() }",
  "",
  "class Taker {",
  "    fun secret(tag: String) {}",
  '    fun viaSameFilePrivate() { buildMaker { secret("viaSameFilePrivate") } }',
  "}",
  "",
  "open class Parent {",
  "    protected open fun hook(tag: String) {}",
  "}",
  "class Child : Parent() {",
  "    override fun hook(tag: String) {}",
  '    fun viaOwnKind() { buildChild { hook("viaOwnKind") } }',
  "}",
  "fun buildChild(block: Child.() -> Unit) { Child().block() }",
  "",
].join("\n");

const BUILDERS = [
  "package app",
  "",
  "import java.util.concurrent.Callable",
  "import java.util.concurrent.ExecutorService",
  "import kotlinx.coroutines.CoroutineScope",
  "import kotlinx.coroutines.launch",
  "import kotlinx.coroutines.runBlocking",
  "",
  "class Svc {",
  "    fun stamp(tag: String) {}",
  "    fun add(x: Int) {}",
  "    fun load(tag: String) {}",
  "    fun ping(tag: String) {}",
  "",
  '    fun viaLaunch(scope: CoroutineScope) { scope.launch { load("viaLaunch") } }',
  '    fun viaRunBlocking() { runBlocking { load("viaRunBlocking") } }',
  '    fun viaBuildList() { buildList<Int> { stamp("viaBuildList") } }',
  '    fun viaBuildString() { buildString { stamp("viaBuildString") } }',
  '    fun viaSequence() { sequence<Int> { stamp("viaSequence") } }',
  '    fun viaBuildListMember() { buildList<Int> { add(2) } } // "viaBuildListMember"',
  '    fun viaRunnable() { Runnable { stamp("viaRunnable") }.run() }',
  '    fun viaCallable() { Callable { stamp("viaCallable") }.call() }',
  '    fun viaQualifiedCallable() { java.util.concurrent.Callable { stamp("viaQualifiedCallable") }.call() }',
  '    fun viaExecutor(executor: ExecutorService) { executor.submit { stamp("viaExecutor") } }',
  '    fun viaUnknownSubmit(unseen: Unseen) { unseen.submit { ping("viaUnknownSubmit") } }',
  '    fun viaThisRunnable() { Runnable { this.stamp("viaThisRunnable") }.run() }',
  "}",
  "",
].join("\n");

const CANDIDATES = [
  "package app",
  "",
  "class Builder {",
  "    fun stamp(tag: String) {}",
  "}",
  "",
  "class Other {",
  "    fun stamp(tag: String) {}",
  "}",
  "",
  "class Settings(val flag: Boolean)",
  "",
  "fun overloaded(first: Int, block: Builder.() -> Unit) {}",
  "fun overloaded(first: String, block: Builder.() -> Unit) {}",
  "fun split(first: Int, block: Builder.() -> Unit) {}",
  "fun split(first: String, block: Other.() -> Unit) {}",
  "fun plainTwice(first: Int, block: () -> Unit) {}",
  "fun plainTwice(first: String, block: () -> Unit) {}",
  "fun launchApp(flag: Boolean) {}",
  "fun launchApp(block: Builder.() -> Unit) {}",
  "fun launchApp(settings: Settings) {}",
  "fun act(action: Action<Builder>) {}",
  "",
  "class Panel(val init: Builder.() -> Unit) {",
  "    constructor(name: String, init: Builder.() -> Unit) : this(init)",
  "}",
  "",
  "fun Builder.report(message: String, input: () -> CharSequence) {}",
  'fun Builder.configure2() { this@configure2.stamp("viaThisExt") }',
  "",
  "class Caller {",
  "    fun stamp(tag: String) {}",
  "    fun own(tag: String) {}",
  "    fun ping(tag: String) {}",
  "",
  '    fun viaOverloads() { overloaded(1) { stamp("viaOverloads") } }',
  '    fun viaSplit() { split(1) { ping("viaSplit") } }',
  '    fun viaPlainTwice() { plainTwice(1) { own("viaPlainTwice") } }',
  '    fun viaLaunchApp() { launchApp { stamp("viaLaunchApp") } }',
  '    fun viaAction() { act { ping("viaAction") } }',
  '    fun viaPanel() { Panel { stamp("viaPanel") } }',
  '    fun viaPanelNamed() { Panel("x") { stamp("viaPanelNamed") } }',
  '    fun viaForeignName() { assertFailsWith<IllegalStateException> { own("viaForeignName") } }',
  "}",
  "",
  "class Reporter {",
  "    fun own(tag: String) {}",
  '    fun Builder.go() { report("m") { own("viaReport") } }',
  "}",
  "",
].join("\n");

const ELSEWHERE = [
  "package other",
  "",
  "class Foreign {",
  "    fun stamp(tag: String) {}",
  "}",
  "",
  "fun overloaded(first: Int, block: Foreign.() -> Unit) {}",
  "fun <T> assertFailsWith(block: Foreign.() -> Unit) {}",
  "",
  "interface ExceptionScope {",
  "    fun assertFailsWith(vararg message: String)",
  "}",
  "",
].join("\n");

const FILES = {
  "lib/Lib.kt": LIB,
  "app/Vis.kt": VIS,
  "app/Builders.kt": BUILDERS,
  "app/Candidates.kt": CANDIDATES,
  "other/Elsewhere.kt": ELSEWHERE,
};

type Target = { file: string; line: number; token: string };

const target = (file: string, source: string, needle: string, token: string): Target => ({
  file,
  line: lineOf(source, needle),
  token,
});

const HIDDEN_PUB = target("lib/Lib.kt", LIB, "fun pub", "pub(");
const HIDDEN_SECRET = target("lib/Lib.kt", LIB, "private fun secret", "secret(");
const HIDDEN_PROT = target("lib/Lib.kt", LIB, "protected fun prot(", "prot(");
const BASE_PROT = target("lib/Lib.kt", LIB, "protected fun protBase", "protBase(");
const EXT_ONLY = target("lib/Lib.kt", LIB, "fun Hidden.extOnly", "extOnly(");
const EXT_IMPORTED = target("lib/Lib.kt", LIB, "fun Hidden.extImported", "extImported(");
const HIDDEN_EXT = target("lib/Lib.kt", LIB, "private fun Hidden.hiddenExt", "hiddenExt(");
const VIS_PUB = target("app/Vis.kt", VIS, "    fun pub", "pub(");
const VIS_SECRET = target("app/Vis.kt", VIS, "    fun secret", "secret(");
const VIS_PROT = target("app/Vis.kt", VIS, "    fun prot(", "prot(");
const VIS_INTERN = target("app/Vis.kt", VIS, "    fun intern", "intern(");
const VIS_EXT_ONLY = target("app/Vis.kt", VIS, "    fun extOnly", "extOnly(");
const VIS_EXT_IMPORTED = target("app/Vis.kt", VIS, "    fun extImported", "extImported(");
const VIS_HIDDEN_EXT = target("app/Vis.kt", VIS, "    fun hiddenExt", "hiddenExt(");
const VIS_PROT_BASE = target("app/Vis.kt", VIS, "    fun protBase", "protBase(");
const MAKER_SECRET = target("app/Vis.kt", VIS, "private fun secret", "secret(");
const TAKER_SECRET = firstMember("app/Vis.kt", VIS, "class Taker {", "secret(");
const PARENT_HOOK = target("app/Vis.kt", VIS, "protected open fun hook", "hook(");
const CHILD_HOOK = target("app/Vis.kt", VIS, "override fun hook", "hook(");
const SVC_STAMP = target("app/Builders.kt", BUILDERS, "    fun stamp", "stamp(");
const SVC_ADD = target("app/Builders.kt", BUILDERS, "    fun add", "add(");
const SVC_LOAD = target("app/Builders.kt", BUILDERS, "    fun load", "load(");
const SVC_PING = target("app/Builders.kt", BUILDERS, "    fun ping", "ping(");
const BUILDER_STAMP = firstMember("app/Candidates.kt", CANDIDATES, "class Builder {", "stamp(");
const OTHER_STAMP = firstMember("app/Candidates.kt", CANDIDATES, "class Other {", "stamp(");
const CALLER_STAMP = firstMember("app/Candidates.kt", CANDIDATES, "class Caller {", "stamp(");
const CALLER_OWN = target("app/Candidates.kt", CANDIDATES, "    fun own", "own(");
const CALLER_PING = target("app/Candidates.kt", CANDIDATES, "    fun ping", "ping(");
const REPORTER_OWN = firstMember("app/Candidates.kt", CANDIDATES, "class Reporter {", "own(");
const FOREIGN_STAMP = firstMember("other/Elsewhere.kt", ELSEWHERE, "class Foreign {", "stamp(");

/** The member declared on the line after the class header `needle`. */
function firstMember(file: string, source: string, needle: string, token: string): Target {
  return { file, line: lineOf(source, needle) + 1, token };
}

let fixture: ConsumerAgreementFixture;

beforeAll(async () => {
  fixture = await buildConsumerAgreementFixture("cg-kotlin-lambda-receiver-scope-", FILES);
});

afterAll(async () => {
  await disposeConsumerAgreementFixture(fixture);
});

/** The call tagged `tag` in `file`, made by `caller`, binds to `expected` and not to `decoy`. */
async function expectCall(file: string, source: string, tag: string, caller: string, expected: Target, decoy: Target) {
  const site = { file, line: lineOf(source, `"${tag}"`), token: expected.token };
  const edge = { label: "calls", from: { file, name: caller } };
  await assertConsumerAgreement(fixture, {
    ...site,
    expected: { file: expected.file, line: expected.line },
    requireCompleteCoverage: true,
    edges: [edge],
  });
  await assertConsumerAgreement(fixture, {
    ...site,
    mustNotMatch: decoy,
    provablyNotAReference: true,
    absentEdge: { label: "calls", from: { file, name: caller } },
  });
}

/** A call no proof settles: goto finds nothing, the decoy's references stay partial, and no edge is drawn. */
async function expectUnproven(file: string, source: string, tag: string, caller: string, decoy: Target) {
  await assertConsumerAgreement(fixture, {
    file,
    line: lineOf(source, `"${tag}"`),
    token: decoy.token,
    expected: "not_found",
    sameNameDeclaration: decoy,
    edges: [{ label: "calls", from: { file, name: caller }, absent: true }],
  });
}

describe("a receiver member the call cannot reach is passed over", () => {
  const cases: Array<[string, string, Target, Target]> = [
    ["viaPublic", "a public member of the receiver still binds", HIDDEN_PUB, VIS_PUB],
    ["viaPrivate", "a private member of another class", VIS_SECRET, HIDDEN_SECRET],
    ["viaProtected", "a protected member, from a class that does not derive from its owner", VIS_PROT, HIDDEN_PROT],
    ["viaProtectedBase", "a protected member inherited through a project supertype", VIS_PROT_BASE, BASE_PROT],
    ["viaExtNotImported", "an extension declared beside the receiver but not imported", VIS_EXT_ONLY, EXT_ONLY],
    ["viaExtImported", "an imported extension still binds", EXT_IMPORTED, VIS_EXT_IMPORTED],
    ["viaPrivateExt", "a private extension of another file", VIS_HIDDEN_EXT, HIDDEN_EXT],
    ["viaNullable", "a nullable receiver's member is reached only through ?.", VIS_PUB, HIDDEN_PUB],
  ];
  it.each(cases)("%s: %s", async (caller, _form, expected, decoy) => {
    await expectCall("app/Vis.kt", VIS, caller, caller, expected, decoy);
  });

  it("viaSameFilePrivate: a private member of a class in the same file is as hidden", async () => {
    await expectCall("app/Vis.kt", VIS, "viaSameFilePrivate", "viaSameFilePrivate", TAKER_SECRET, MAKER_SECRET);
  });

  it("viaOwnKind: a protected member binds from inside the class that owns it", async () => {
    await expectCall("app/Vis.kt", VIS, "viaOwnKind", "viaOwnKind", CHILD_HOOK, PARENT_HOOK);
  });

  it("viaInternal: an internal member of another file stays unproven, as no module is modeled", async () => {
    await expectUnproven("app/Vis.kt", VIS, "viaInternal", "viaInternal", VIS_INTERN);
  });
});

describe("a callee from the standard library or kotlinx.coroutines", () => {
  const cases: Array<[string, string, Target, Target]> = [
    ["viaLaunch", "launch on a CoroutineScope leaves load to the enclosing type", SVC_LOAD, FOREIGN_STAMP],
    ["viaRunBlocking", "runBlocking", SVC_LOAD, FOREIGN_STAMP],
    ["viaBuildList", "buildList declares no stamp", SVC_STAMP, FOREIGN_STAMP],
    ["viaBuildString", "buildString declares no stamp", SVC_STAMP, FOREIGN_STAMP],
    ["viaSequence", "sequence declares no stamp", SVC_STAMP, FOREIGN_STAMP],
    ["viaRunnable", "a SAM constructor takes a plain lambda", SVC_STAMP, FOREIGN_STAMP],
    ["viaCallable", "Callable", SVC_STAMP, FOREIGN_STAMP],
    ["viaQualifiedCallable", "Callable spelled with its package", SVC_STAMP, FOREIGN_STAMP],
    ["viaExecutor", "submit on a declared ExecutorService", SVC_STAMP, FOREIGN_STAMP],
    ["viaThisRunnable", "an explicit this in a SAM lambda is the enclosing type", SVC_STAMP, FOREIGN_STAMP],
  ];
  it.each(cases)("%s: %s", async (caller, _form, expected, decoy) => {
    await expectCall("app/Builders.kt", BUILDERS, caller, caller, expected, decoy);
  });

  it("a name the builder's receiver declares stays unproven", async () => {
    await expectUnproven("app/Builders.kt", BUILDERS, "viaBuildListMember", "viaBuildListMember", SVC_ADD);
  });

  it("submit on a receiver nothing proves is an executor stays unproven", async () => {
    await expectUnproven("app/Builders.kt", BUILDERS, "viaUnknownSubmit", "viaUnknownSubmit", SVC_PING);
  });
});

describe("a callee go-to-definition cannot name alone", () => {
  const cases: Array<[string, string, Target, Target]> = [
    ["viaOverloads", "same-arity overloads that agree on the receiver", BUILDER_STAMP, CALLER_STAMP],
    ["viaPlainTwice", "overloads that all take a plain lambda", CALLER_OWN, BUILDER_STAMP],
    ["viaLaunchApp", "overloads whose other parameters take no lambda", BUILDER_STAMP, CALLER_STAMP],
    ["viaPanel", "constructors that agree on the receiver", BUILDER_STAMP, CALLER_STAMP],
    ["viaPanelNamed", "a secondary constructor, by position", BUILDER_STAMP, CALLER_STAMP],
    ["viaForeignName", "a standard function whose name another package also declares", CALLER_OWN, FOREIGN_STAMP],
  ];
  it.each(cases)("%s: %s", async (caller, _form, expected, decoy) => {
    await expectCall("app/Candidates.kt", CANDIDATES, caller, caller, expected, decoy);
  });

  it("an extension on an implicit receiver, called with a plain lambda", async () => {
    await expectCall("app/Candidates.kt", CANDIDATES, "viaReport", "go", REPORTER_OWN, CALLER_OWN);
  });

  it("viaSplit: overloads that disagree on the receiver stay unproven", async () => {
    await expectUnproven("app/Candidates.kt", CANDIDATES, "viaSplit", "viaSplit", CALLER_PING);
  });

  it("viaAction: a Gradle Action may carry a receiver, so it stays unproven", async () => {
    await expectUnproven("app/Candidates.kt", CANDIDATES, "viaAction", "viaAction", CALLER_PING);
  });
});

describe("this@extension inside an extension function", () => {
  it("names the extension's receiver type", async () => {
    await expectCall("app/Candidates.kt", CANDIDATES, "viaThisExt", "configure2", BUILDER_STAMP, OTHER_STAMP);
  });
});
