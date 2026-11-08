import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  findDetailedNode,
  hasDetailedEdge,
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
  "class Extern : com.acme.Base()",
  "",
  "class Labeled {",
  '    val label: String = "field"',
  "    fun label(tag: String): String = tag",
  "}",
  "",
  "class Sized { val size: Int = 1 }",
  "class Literal { val size = 5 }",
  "class CtorSized(val size: Int)",
  "class LazySized { val size: Int by lazy { 1 } }",
  "class Typed { val action: (String) -> String = { it } }",
  "class CtorTyped(val action: (String) -> String)",
  "class Converted { val transform: Transform = makeTransform() }",
  "class Invoker { operator fun invoke(tag: String): String = tag }",
  "class Operated { val operation: Invoker = Invoker() }",
  "class Rendered { val render: Transform = makeTransform() }",
  "class Formatted { val format: Invoker = Invoker() }",
  "class Ringed { val ring: Int = 1 }",
  "",
  "typealias Transform = (String) -> String",
  "fun makeTransform(): Transform = { it }",
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
  "fun labeled(block: Labeled.() -> Unit) { Labeled().block() }",
  "fun sized(block: Sized.() -> Unit) { Sized().block() }",
  "fun literal(block: Literal.() -> Unit) { Literal().block() }",
  "fun ctorSized(block: CtorSized.() -> Unit) { CtorSized(1).block() }",
  "fun lazySized(block: LazySized.() -> Unit) { LazySized().block() }",
  "fun typed(block: Typed.() -> Unit) { Typed().block() }",
  "fun ctorTyped(block: CtorTyped.() -> Unit) { CtorTyped { it }.block() }",
  "fun converted(block: Converted.() -> Unit) { Converted().block() }",
  "fun operated(block: Operated.() -> Unit) { Operated().block() }",
  "fun rendered(block: Rendered.() -> Unit) { Rendered().block() }",
  "fun formatted(block: Formatted.() -> Unit) { Formatted().block() }",
  "fun ringed(block: Ringed.() -> Unit) { Ringed().block() }",
  "",
].join("\n");

const OWNER = [
  "package app",
  "",
  "fun render(tag: String): String = tag",
  "fun format(tag: String): String = tag",
  "fun ring(tag: String): Int = tag.length",
  "",
  "class Owner {",
  "    fun stamp(tag: String) {}",
  "    fun own(tag: String) {}",
  "    fun label(tag: String): String = tag",
  "    fun size(tag: String): Int = tag.length",
  "    fun action(tag: String): String = tag",
  "    fun transform(tag: String): String = tag",
  "    fun operation(tag: String): String = tag",
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
  '    fun viaLabeledCall() { labeled { label("viaLabeledCall") } }',
  '    fun viaSizedProperty() { sized { size("viaSizedProperty") } }',
  '    fun viaLiteralProperty() { literal { size("viaLiteralProperty") } }',
  '    fun viaCtorSizedProperty() { ctorSized { size("viaCtorSizedProperty") } }',
  '    fun viaLazySizedProperty() { lazySized { size("viaLazySizedProperty") } }',
  '    fun viaTypedProperty() { typed { action("viaTypedProperty") } }',
  '    fun viaCtorTypedProperty() { ctorTyped { action("viaCtorTypedProperty") } }',
  '    fun viaConvertedProperty() { converted { transform("viaConvertedProperty") } }',
  '    fun viaOperatedProperty() { operated { operation("viaOperatedProperty") } }',
  '    fun viaRenderedProperty() { rendered { render("viaRenderedProperty") } }',
  '    fun viaFormattedProperty() { formatted { format("viaFormattedProperty") } }',
  '    fun viaRingedProperty() { ringed { ring("viaRingedProperty") } }',
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
  '            fun anonThisCaller() { build { this.stamp("anonThis") } }',
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
  '    fun viaUnknownTrailing() { unknownBuilder { ping("viaUnknownTrailing") } }',
  '    fun viaUnknownTrailingTopLevel() { unknownBuilder { helper("viaUnknownTrailingTopLevel") } }',
  '    fun viaExternalSupertype() { extern { ping("viaExternalSupertype") } }',
  '    fun viaUnseenCall() { build().apply { ping("viaUnseenCall") } }',
  "    fun viaAny(b: Builder) { with(b) { toString() } }",
  "    fun viaThisApplySb(sb: StringBuilder) { sb.apply { this.append(3) } }",
  "    fun viaThisBuildString() { buildString { this.append(4) } }",
  '    fun viaThisUnknown() { unknownBuilder { this.ping("viaThisUnknown") } }',
  "}",
  "",
].join("\n");

const THIS = [
  "package app",
  "",
  "class Holder {",
  "    fun stamp(tag: String) {}",
  "    fun label(tag: String): String = tag",
  "    fun action(tag: String): String = tag",
  "    fun transform(tag: String): String = tag",
  "    fun operation(tag: String): String = tag",
  "",
  '    fun viaThis() { build { this.stamp("viaThis") } }',
  '    fun viaThisLabeled() { labeled { this.label("viaThisLabeled") } }',
  '    fun viaThisTypedProperty() { typed { this.action("viaThisTypedProperty") } }',
  '    fun viaThisConvertedProperty() { converted { this.transform("viaThisConvertedProperty") } }',
  '    fun viaThisOperatedProperty() { operated { this.operation("viaThisOperatedProperty") } }',
  '    fun viaThisApply(b: Builder) { b.apply { this.stamp("viaThisApply") } }',
  '    fun viaThisNested() { with(Other()) { build { this.stamp("viaThisNested") } } }',
  '    fun viaThisNestedOther() { build { with(Other()) { this.stamp("viaThisNestedOther") } } }',
  '    fun viaLabeledCallee() { build { this@build.stamp("viaLabeledCallee") } }',
  '    fun viaLabeledApply(b: Builder) { b.apply { this@apply.stamp("viaLabeledApply") } }',
  '    fun viaLabeledWith(b: Builder) { with(b) { this@with.stamp("viaLabeledWith") } }',
  '    fun viaLabeledExplicit() { build lbl@{ this@lbl.stamp("viaLabeledExplicit") } }',
  '    fun viaLabeledOuter() { build { with(Other()) { this@build.stamp("viaLabeledOuter") } } }',
  '    fun viaLabeledHolder() { build { this@Holder.stamp("viaLabeledHolder") } }',
  '    fun viaThisPlain() { plain { b -> this.stamp("viaThisPlain") } }',
  '    fun viaThisForEach() { listOf(1).forEach { this.stamp("viaThisForEach") } }',
  '    fun viaThisOutside() { this.stamp("viaThisOutside") }',
  "}",
  "",
].join("\n");

const FILES = {
  "app/Dsl.kt": DSL,
  "app/Owner.kt": OWNER,
  "app/Anon.kt": ANON,
  "app/Careful.kt": UNPROVEN,
  "app/This.kt": THIS,
};

const BUILDER_STAMP = { file: "app/Dsl.kt", line: lineOf(DSL, "class Builder {") + 1, token: "stamp(" };
const OTHER_STAMP = { file: "app/Dsl.kt", line: lineOf(DSL, "class Other {") + 1, token: "stamp(" };
const OWNER_STAMP = { file: "app/Owner.kt", line: lineOf(OWNER, "fun stamp"), token: "stamp(" };
const OWNER_OWN = { file: "app/Owner.kt", line: lineOf(OWNER, "fun own"), token: "own(" };
const ANON_STAMP = { file: "app/Anon.kt", line: lineOf(ANON, "fun stamp"), token: "stamp(" };
const HOLDER_STAMP = { file: "app/This.kt", line: lineOf(THIS, "fun stamp"), token: "stamp(" };
const LABELED_METHOD = { file: "app/Dsl.kt", line: lineOf(DSL, "fun label("), token: "label(" };
const LABELED_FIELD = { file: "app/Dsl.kt", line: lineOf(DSL, "val label"), token: "label" };
const OWNER_LABEL = { file: "app/Owner.kt", line: lineOf(OWNER, "fun label("), token: "label(" };
const HOLDER_LABEL = { file: "app/This.kt", line: lineOf(THIS, "fun label("), token: "label(" };
const SIZED_SIZE = { file: "app/Dsl.kt", line: lineOf(DSL, "class Sized"), token: "size" };
const LITERAL_SIZE = { file: "app/Dsl.kt", line: lineOf(DSL, "class Literal"), token: "size" };
const CTOR_SIZED_SIZE = { file: "app/Dsl.kt", line: lineOf(DSL, "class CtorSized"), token: "size" };
const LAZY_SIZED_SIZE = { file: "app/Dsl.kt", line: lineOf(DSL, "class LazySized"), token: "size" };
const TYPED_ACTION = { file: "app/Dsl.kt", line: lineOf(DSL, "class Typed"), token: "action" };
const CTOR_TYPED_ACTION = { file: "app/Dsl.kt", line: lineOf(DSL, "class CtorTyped"), token: "action" };
const OWNER_SIZE = { file: "app/Owner.kt", line: lineOf(OWNER, "fun size("), token: "size(" };
const OWNER_ACTION = { file: "app/Owner.kt", line: lineOf(OWNER, "fun action("), token: "action(" };
const HOLDER_ACTION = { file: "app/This.kt", line: lineOf(THIS, "fun action("), token: "action(" };
const OWNER_TRANSFORM = { file: "app/Owner.kt", line: lineOf(OWNER, "fun transform("), token: "transform(" };
const OWNER_OPERATION = { file: "app/Owner.kt", line: lineOf(OWNER, "fun operation("), token: "operation(" };
const OWNER_RING = { file: "app/Owner.kt", line: lineOf(OWNER, "fun ring("), token: "ring(" };
const RINGED_RING = { file: "app/Dsl.kt", line: lineOf(DSL, "class Ringed"), token: "ring" };
const HOLDER_TRANSFORM = { file: "app/This.kt", line: lineOf(THIS, "fun transform("), token: "transform(" };
const HOLDER_OPERATION = { file: "app/This.kt", line: lineOf(THIS, "fun operation("), token: "operation(" };

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

/**
 * A call beside a file-level function that a receiver's property of the name may take instead: goto finds nothing and
 * the graph draws no edge to the function. Its references are not asserted, because a use in the function's own file
 * is gathered by scope, not by navigation.
 */
async function expectFileLevelHidden(caller: string, token: string, functionName: string) {
  await assertConsumerAgreement(fixture, {
    file: "app/Owner.kt",
    line: lineOf(OWNER, `"${caller}"`),
    token,
    expected: "not_found",
  });
  const from = findDetailedNode(fixture, "app/Owner.kt", caller);
  const to = findDetailedNode(fixture, "app/Owner.kt", functionName);
  expect(hasDetailedEdge(fixture, from.id, to.id, "calls"), `${caller} must not call ${functionName}`).toBe(false);
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
      ["viaLabeledCall", "a call beside a same-named property of the receiver", LABELED_METHOD, OWNER_LABEL],
      ["viaTypedProperty", "a function-typed property of the receiver", TYPED_ACTION, OWNER_ACTION],
      [
        "viaCtorTypedProperty",
        "a function-typed constructor property of the receiver",
        CTOR_TYPED_ACTION,
        OWNER_ACTION,
      ],
    ];
    it.each(cases)("%s: %s", async (caller, _form, target, decoy) => {
      await expectCall("app/Owner.kt", OWNER, caller, caller, target, decoy);
    });

    it("an anonymous object enclosing the lambda has its member passed over too", async () => {
      await expectCall("app/Anon.kt", ANON, "anonBuild", "run", BUILDER_STAMP, ANON_STAMP);
    });

    it("a call never binds the receiver's property of the same name", async () => {
      await assertConsumerAgreement(fixture, {
        file: "app/Owner.kt",
        line: lineOf(OWNER, '"viaLabeledCall"'),
        token: "label(",
        mustNotMatch: LABELED_FIELD,
        provablyNotAReference: true,
        absentEdge: { label: "calls", from: { file: "app/Owner.kt", name: "viaLabeledCall" } },
      });
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
      ["viaSizedProperty", "a plain Int property of the receiver cannot be called", OWNER_SIZE, SIZED_SIZE],
      ["viaLiteralProperty", "a property a literal initializes", OWNER_SIZE, LITERAL_SIZE],
      ["viaCtorSizedProperty", "a plain constructor property", OWNER_SIZE, CTOR_SIZED_SIZE],
      ["viaLazySizedProperty", "a delegated Int property", OWNER_SIZE, LAZY_SIZED_SIZE],
      ["viaRingedProperty", "a plain property beside a file-level function", OWNER_RING, RINGED_RING],
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

    it("a property typed by an alias, which may be a function type", async () => {
      await expectUnproven(
        "app/Owner.kt",
        OWNER,
        '"viaConvertedProperty"',
        "viaConvertedProperty",
        "transform(",
        OWNER_TRANSFORM,
      );
    });

    it("a property typed by a class that may declare invoke", async () => {
      await expectUnproven(
        "app/Owner.kt",
        OWNER,
        '"viaOperatedProperty"',
        "viaOperatedProperty",
        "operation(",
        OWNER_OPERATION,
      );
    });

    it("a property typed by an alias hides a file-level function of its name", async () => {
      await expectFileLevelHidden("viaRenderedProperty", "render(", "render");
    });

    it("a property typed by a class that may declare invoke hides a file-level function of its name", async () => {
      await expectFileLevelHidden("viaFormattedProperty", "format(", "format");
    });
  });
});

describe("an explicit this inside a lambda", () => {
  const cases: Array<[string, string, Target, Target]> = [
    ["viaThis", "a DSL lambda", BUILDER_STAMP, HOLDER_STAMP],
    ["viaThisApply", "apply on a typed parameter", BUILDER_STAMP, HOLDER_STAMP],
    ["viaThisNested", "a DSL lambda inside with(Other()): the closest receiver", BUILDER_STAMP, OTHER_STAMP],
    ["viaThisNestedOther", "with(Other()) inside a DSL lambda", OTHER_STAMP, BUILDER_STAMP],
    ["viaLabeledCallee", "this@build, named by the callee", BUILDER_STAMP, HOLDER_STAMP],
    ["viaLabeledApply", "this@apply", BUILDER_STAMP, HOLDER_STAMP],
    ["viaLabeledWith", "this@with", BUILDER_STAMP, HOLDER_STAMP],
    ["viaLabeledExplicit", "this@lbl, named by an explicit label", BUILDER_STAMP, HOLDER_STAMP],
    ["viaLabeledOuter", "this@build reaches past the closer with(Other())", BUILDER_STAMP, OTHER_STAMP],
    ["viaLabeledHolder", "this@Holder names the enclosing type from inside a lambda", HOLDER_STAMP, BUILDER_STAMP],
    ["viaThisPlain", "a lambda with no receiver leaves this as the enclosing type", HOLDER_STAMP, BUILDER_STAMP],
    ["viaThisForEach", "forEach", HOLDER_STAMP, BUILDER_STAMP],
    ["viaThisOutside", "no lambda at all", HOLDER_STAMP, BUILDER_STAMP],
    ["viaThisLabeled", "a call beside a same-named property of the receiver", LABELED_METHOD, HOLDER_LABEL],
    ["viaThisTypedProperty", "a function-typed property of the receiver", TYPED_ACTION, HOLDER_ACTION],
  ];
  it.each(cases)("%s: %s", async (caller, _form, target, decoy) => {
    await expectCall("app/This.kt", THIS, caller, caller, target, decoy);
  });

  it("an anonymous object enclosing the lambda has its member passed over", async () => {
    await expectCall("app/Anon.kt", ANON, "anonThis", "anonThisCaller", BUILDER_STAMP, ANON_STAMP);
  });

  describe("stays unproven when the receiver's members are unknown", () => {
    const decoyAppend = { file: "app/Careful.kt", line: lineOf(UNPROVEN, "fun append"), token: "append(" };
    const decoyPing = { file: "app/Careful.kt", line: lineOf(UNPROVEN, "fun ping"), token: "ping(" };

    it("apply on a receiver of an external type", async () => {
      await expectUnproven("app/Careful.kt", UNPROVEN, "viaThisApplySb", "viaThisApplySb", "append(", decoyAppend);
    });

    it("buildString, whose receiver is a StringBuilder", async () => {
      await expectUnproven(
        "app/Careful.kt",
        UNPROVEN,
        "viaThisBuildString",
        "viaThisBuildString",
        "append(",
        decoyAppend,
      );
    });

    it("a trailing lambda of a callee the project does not declare", async () => {
      await expectUnproven("app/Careful.kt", UNPROVEN, '"viaThisUnknown"', "viaThisUnknown", "ping(", decoyPing);
    });

    it("a property typed by an alias, which may be a function type", async () => {
      await expectUnproven(
        "app/This.kt",
        THIS,
        '"viaThisConvertedProperty"',
        "viaThisConvertedProperty",
        "transform(",
        HOLDER_TRANSFORM,
      );
    });

    it("a property typed by a class that may declare invoke", async () => {
      await expectUnproven(
        "app/This.kt",
        THIS,
        '"viaThisOperatedProperty"',
        "viaThisOperatedProperty",
        "operation(",
        HOLDER_OPERATION,
      );
    });
  });
});

/**
 * A call cannot invoke a plain property (`val size: Int`), so the receiver's property is passed over for the enclosing
 * type's function. An `operator fun Int.invoke` that makes it callable outranks that function only as a member of the
 * receiver's own class: kotlinc 2.4.21 runs the enclosing function beside a top-level extension and the member
 * extension beside a member one, so the member form leaves the call unproven.
 */
describe("a plain property of the receiver beside an invoke operator extension", () => {
  const owner = [
    "package app",
    "",
    "class Owner {",
    "    fun size(tag: String): Int = tag.length",
    '    fun viaSizedProperty() { sized { size("viaSizedProperty") } }',
    "}",
    "",
  ].join("\n");
  const topLevelDsl = [
    "package app",
    "",
    "class Sized { val size: Int = 1 }",
    "",
    "fun sized(block: Sized.() -> Unit) { Sized().block() }",
    "operator fun Int.invoke(tag: String): String = tag",
    "",
  ].join("\n");
  const memberDsl = [
    "package app",
    "",
    "class Sized {",
    "    val size: Int = 1",
    "    operator fun Int.invoke(tag: String): String = tag",
    "}",
    "",
    "fun sized(block: Sized.() -> Unit) { Sized().block() }",
    "",
  ].join("\n");
  const site = { file: "app/Owner.kt", line: lineOf(owner, '"viaSizedProperty"'), token: "size(" };
  const ownerSize = { file: "app/Owner.kt", line: lineOf(owner, "fun size("), token: "size(" };
  const edge = { label: "calls", from: { file: "app/Owner.kt", name: "viaSizedProperty" } };
  let topLevel: ConsumerAgreementFixture;
  let member: ConsumerAgreementFixture;

  beforeAll(async () => {
    topLevel = await buildConsumerAgreementFixture("cg-kotlin-lambda-invoke-top-", {
      "app/Dsl.kt": topLevelDsl,
      "app/Owner.kt": owner,
    });
    member = await buildConsumerAgreementFixture("cg-kotlin-lambda-invoke-member-", {
      "app/Dsl.kt": memberDsl,
      "app/Owner.kt": owner,
    });
  });

  afterAll(async () => {
    await disposeConsumerAgreementFixture(topLevel);
    await disposeConsumerAgreementFixture(member);
  });

  it("a top-level extension ranks below the enclosing type's members and leaves the call there", async () => {
    await assertConsumerAgreement(topLevel, {
      ...site,
      expected: { file: ownerSize.file, line: ownerSize.line },
      requireCompleteCoverage: true,
      edges: [edge],
    });
  });

  it("a member extension may take the call, so it stays unproven", async () => {
    await assertConsumerAgreement(member, {
      ...site,
      expected: "not_found",
      sameNameDeclaration: ownerSize,
      edges: [{ ...edge, absent: true }],
    });
  });
});
