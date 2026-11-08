import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  type ConsumerAgreementFixture,
} from "./helpers/consumer-agreement.js";

/**
 * A bare call inside a Kotlin lambda binds to a member of the lambda's implicit receiver before any member of the
 * enclosing type. Each form follows a program compiled and run with kotlinc 2.4.21, where the member that ran is the
 * expected target. Each case asserts go-to-definition, `findReferences` (coverage included) and the detailed graph's
 * `calls` edge, plus the same-named decoy that must stay out.
 */

function lineOf(source: string, needle: string): number {
  const line = source.split("\n").findIndex((text) => text.includes(needle));
  if (line < 0) throw new Error(`no line contains ${needle}`);
  return line + 1;
}

const DSL = [
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
  "class Extern : java.util.ArrayList<String>()",
  "",
  "typealias BuilderBlock = Builder.() -> Unit",
  "",
  "fun build(block: Builder.() -> Unit) { Builder().block() }",
  "fun <T> buildAs(block: Builder.() -> Unit) { Builder().block() }",
  "fun buildTwo(first: Int, block: Builder.() -> Unit) { Builder().block() }",
  "fun aliased(block: BuilderBlock) { Builder().block() }",
  "fun plain(block: (Builder) -> Unit) { block(Builder()) }",
  "fun extern(block: Extern.() -> Unit) { Extern().block() }",
  "fun Builder.configure(block: Builder.() -> Unit) { block() }",
  "",
].join("\n");

const OWNER = [
  "package app",
  "",
  "class Owner {",
  "    fun stamp(tag: String) {}",
  "    fun own(tag: String) {}",
  "",
  '    fun viaBuild() { build { stamp("viaBuild") } }',
  '    fun viaBuildTwo() { buildTwo(1) { stamp("viaBuildTwo") } }',
  '    fun viaParen() { buildTwo(1, { stamp("viaParen") }) }',
  '    fun viaNamed() { build(block = { stamp("viaNamed") }) }',
  '    fun viaAlias() { aliased { stamp("viaAlias") } }',
  '    fun viaGeneric() { buildAs<Int> { stamp("viaGeneric") } }',
  '    fun viaConfigure(b: Builder) { b.configure { stamp("viaConfigure") } }',
  '    fun viaApplyParam(b: Builder) { b.apply { stamp("viaApplyParam") } }',
  '    fun viaApplyCtor() { Builder().apply { stamp("viaApplyCtor") } }',
  '    fun viaRunExt(b: Builder) { b.run { stamp("viaRunExt") } }',
  '    fun viaWith(b: Builder) { with(b) { stamp("viaWith") } }',
  '    fun viaNestedRecv() { with(Other()) { build { stamp("viaNestedRecv") } } }',
  '    fun viaNestedOther() { build { with(Other()) { stamp("viaNestedOther") } } }',
  '    fun viaNestedPlain(b: Builder) { b.apply { plain { x -> stamp("viaNestedPlain") } } }',
  '    fun viaFallThrough(b: Builder) { b.apply { own("viaFallThrough") } }',
  '    fun viaLocal() { build { fun stamp(tag: String) {}; stamp("viaLocal") } }',
  '    fun viaPlain() { plain { b -> stamp("viaPlain") } }',
  '    fun viaLet(b: Builder) { b.let { stamp("viaLet") } }',
  '    fun viaAlso(b: Builder) { b.also { stamp("viaAlso") } }',
  '    fun viaForEach() { listOf(1).forEach { stamp("viaForEach") } }',
  '    fun viaBareRun() { run { stamp("viaBareRun") } }',
  '    fun viaBareApply() { apply { stamp("viaBareApply") } }',
  '    fun viaFails() { assertFailsWith<IllegalStateException> { own("viaFails") } }',
  '    fun viaThreadParen() { Thread({ own("viaThreadParen") }) }',
  "}",
  "",
].join("\n");

const ANON = [
  "package app",
  "",
  "class Host {",
  "    fun launch() {",
  "        val task = object : Runnable {",
  "            fun stamp(tag: String) {}",
  '            override fun run() { build { stamp("anonBuild") } }',
  '            fun anonPlainCaller() { plain { b -> stamp("anonPlain") } }',
  "        }",
  "        task.run()",
  "    }",
  "}",
  "",
].join("\n");

const UNPROVEN = [
  "package app",
  "",
  "fun helper(tag: String) {}",
  "",
  "class Careful {",
  "    fun append(x: Int) {}",
  "    fun ping(tag: String) {}",
  '    override fun toString(): String = "careful"',
  "",
  "    fun viaApplyStringBuilder(sb: StringBuilder) { sb.apply { append(1) } }",
  "    fun viaBuildString() { buildString { append(2) } }",
  '    fun viaUnknownTrailing() { Thread { ping("viaUnknownTrailing") } }',
  '    fun viaUnknownTrailingTopLevel() { Thread { helper("viaUnknownTrailingTopLevel") } }',
  '    fun viaExternalSupertype() { extern { ping("viaExternalSupertype") } }',
  '    fun viaUnseenCall() { build().apply { ping("viaUnseenCall") } }',
  "    fun viaAny(b: Builder) { with(b) { toString() } }",
  "}",
  "",
].join("\n");

const FILES = { "app/Dsl.kt": DSL, "app/Owner.kt": OWNER, "app/Anon.kt": ANON, "app/Careful.kt": UNPROVEN };

const BUILDER_STAMP = { file: "app/Dsl.kt", line: lineOf(DSL, "class Builder {") + 1, token: "stamp(" };
const OTHER_STAMP = { file: "app/Dsl.kt", line: lineOf(DSL, "class Other {") + 1, token: "stamp(" };
const OWNER_STAMP = { file: "app/Owner.kt", line: lineOf(OWNER, "fun stamp"), token: "stamp(" };
const OWNER_OWN = { file: "app/Owner.kt", line: lineOf(OWNER, "fun own"), token: "own(" };
const ANON_STAMP = { file: "app/Anon.kt", line: lineOf(ANON, "fun stamp"), token: "stamp(" };

let fixture: ConsumerAgreementFixture;

beforeAll(async () => {
  fixture = await buildConsumerAgreementFixture("cg-kotlin-lambda-receiver-", FILES);
});

afterAll(async () => {
  await disposeConsumerAgreementFixture(fixture);
});

type Target = { file: string; line: number; token: string };

/** The call at the line tagged `tag`, in `file`, whose enclosing declaration is `caller`. */
async function expectCall(file: string, source: string, tag: string, caller: string, target: Target, decoy: Target) {
  const site = { file, line: lineOf(source, `"${tag}"`), token: target.token };
  const edge = { label: "calls", from: { file, name: caller } };
  await assertConsumerAgreement(fixture, {
    ...site,
    expected: { file: target.file, line: target.line },
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
async function expectUnproven(
  file: string,
  source: string,
  needle: string,
  caller: string,
  token: string,
  decoy: Target,
) {
  await assertConsumerAgreement(fixture, {
    file,
    line: lineOf(source, needle),
    token,
    expected: "not_found",
    sameNameDeclaration: decoy,
    edges: [{ label: "calls", from: { file, name: caller }, absent: true }],
  });
}

describe("a bare call inside a lambda with an implicit receiver", () => {
  describe("binds to the receiver's member, not the enclosing type's", () => {
    const cases: Array<[string, string, Target, Target]> = [
      ["viaBuild", "a trailing lambda of a project DSL function", BUILDER_STAMP, OWNER_STAMP],
      ["viaBuildTwo", "a trailing lambda after arguments", BUILDER_STAMP, OWNER_STAMP],
      ["viaParen", "a lambda in parentheses, by position", BUILDER_STAMP, OWNER_STAMP],
      ["viaNamed", "a lambda in parentheses, by name", BUILDER_STAMP, OWNER_STAMP],
      ["viaAlias", "a parameter typed by an alias of a receiver function type", BUILDER_STAMP, OWNER_STAMP],
      ["viaGeneric", "a generic call the grammar reads as comparisons", BUILDER_STAMP, OWNER_STAMP],
      ["viaConfigure", "an extension function with a receiver lambda", BUILDER_STAMP, OWNER_STAMP],
      ["viaApplyParam", "apply on a typed parameter", BUILDER_STAMP, OWNER_STAMP],
      ["viaApplyCtor", "apply on a constructor call", BUILDER_STAMP, OWNER_STAMP],
      ["viaRunExt", "run on a typed parameter", BUILDER_STAMP, OWNER_STAMP],
      ["viaWith", "with(x)", BUILDER_STAMP, OWNER_STAMP],
      ["viaNestedRecv", "a DSL lambda inside with(Other())", BUILDER_STAMP, OTHER_STAMP],
      ["viaNestedOther", "with(Other()) inside a DSL lambda: the closest receiver", OTHER_STAMP, BUILDER_STAMP],
      ["viaNestedPlain", "a plain lambda between apply and the call", BUILDER_STAMP, OWNER_STAMP],
    ];
    it.each(cases)("%s: %s", async (caller, _form, target, decoy) => {
      await expectCall("app/Owner.kt", OWNER, caller, caller, target, decoy);
    });

    it("an anonymous object enclosing the lambda has its member passed over too", async () => {
      await expectCall("app/Anon.kt", ANON, "anonBuild", "run", BUILDER_STAMP, ANON_STAMP);
    });
  });

  describe("keeps the enclosing member when the lambda has no receiver, or the receiver lacks the name", () => {
    const cases: Array<[string, string, Target, Target]> = [
      ["viaFallThrough", "the receiver declares no such member", OWNER_OWN, BUILDER_STAMP],
      ["viaPlain", "a project function typed (Builder) -> Unit", OWNER_STAMP, BUILDER_STAMP],
      ["viaLet", "let", OWNER_STAMP, BUILDER_STAMP],
      ["viaAlso", "also", OWNER_STAMP, BUILDER_STAMP],
      ["viaForEach", "forEach", OWNER_STAMP, BUILDER_STAMP],
      ["viaBareRun", "run with no receiver expression", OWNER_STAMP, BUILDER_STAMP],
      ["viaBareApply", "apply with no receiver expression", OWNER_STAMP, BUILDER_STAMP],
      ["viaFails", "a generic standard-library call the grammar reads as comparisons", OWNER_OWN, BUILDER_STAMP],
      ["viaThreadParen", "a lambda in parentheses of an unknown callee", OWNER_OWN, BUILDER_STAMP],
    ];
    it.each(cases)("%s: %s", async (caller, _form, target, decoy) => {
      await expectCall("app/Owner.kt", OWNER, caller, caller, target, decoy);
    });

    it("an anonymous object's own member answers a plain lambda", async () => {
      await expectCall("app/Anon.kt", ANON, "anonPlain", "anonPlainCaller", ANON_STAMP, BUILDER_STAMP);
    });

    it("a local function declared in the lambda binds before the receiver", async () => {
      await assertConsumerAgreement(fixture, {
        file: "app/Owner.kt",
        line: lineOf(OWNER, '"viaLocal"'),
        token: 'stamp("viaLocal")',
        expected: { file: "app/Owner.kt", line: lineOf(OWNER, '"viaLocal"') },
        checkReferences: false,
      });
    });
  });

  describe("stays unproven when the receiver's members are unknown", () => {
    const decoyAppend = { file: "app/Careful.kt", line: lineOf(UNPROVEN, "fun append"), token: "append(" };
    const decoyPing = { file: "app/Careful.kt", line: lineOf(UNPROVEN, "fun ping"), token: "ping(" };
    const decoyToString = { file: "app/Careful.kt", line: lineOf(UNPROVEN, "fun toString"), token: "toString(" };

    it("apply on a receiver of an external type", async () => {
      await expectUnproven(
        "app/Careful.kt",
        UNPROVEN,
        "viaApplyStringBuilder",
        "viaApplyStringBuilder",
        "append(1)",
        decoyAppend,
      );
    });

    it("buildString, whose receiver is a StringBuilder", async () => {
      await expectUnproven("app/Careful.kt", UNPROVEN, "viaBuildString", "viaBuildString", "append(2)", decoyAppend);
    });

    it("a trailing lambda of a callee the project does not declare", async () => {
      await expectUnproven(
        "app/Careful.kt",
        UNPROVEN,
        '"viaUnknownTrailing"',
        "viaUnknownTrailing",
        "ping(",
        decoyPing,
      );
    });

    it("a receiver type with a supertype outside the project", async () => {
      await expectUnproven(
        "app/Careful.kt",
        UNPROVEN,
        '"viaExternalSupertype"',
        "viaExternalSupertype",
        "ping(",
        decoyPing,
      );
    });

    it("a receiver expression whose type no declaration proves", async () => {
      await expectUnproven("app/Careful.kt", UNPROVEN, '"viaUnseenCall"', "viaUnseenCall", "ping(", decoyPing);
    });

    it("a member every type has, through with(x)", async () => {
      await expectUnproven("app/Careful.kt", UNPROVEN, "viaAny", "viaAny", "toString(", decoyToString);
    });

    it("a file-level function is still the answer inside a trailing lambda of an unknown callee", async () => {
      const line = lineOf(UNPROVEN, '"viaUnknownTrailingTopLevel"');
      await assertConsumerAgreement(fixture, {
        file: "app/Careful.kt",
        line,
        token: "helper(",
        expected: { file: "app/Careful.kt", line: lineOf(UNPROVEN, "fun helper") },
        edges: [{ label: "calls", from: { file: "app/Careful.kt", name: "viaUnknownTrailingTopLevel" } }],
      });
    });
  });
});
