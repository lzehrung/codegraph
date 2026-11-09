import { afterAll, beforeAll, describe, it } from "vitest";
import {
  assertConsumerAgreement,
  buildConsumerAgreementFixture,
  disposeConsumerAgreementFixture,
  type ConsumerAgreementFixture,
} from "./helpers/consumer-agreement.js";
import {
  expectKotlinReceiverReview,
  KOTLIN_RECEIVER_REVIEW_SOURCES,
} from "./helpers/kotlin-receiver-review-fixture.js";

// These bindings follow the compiled and executed kotlinc 2.4.21 receiver-precedence oracle.
const TYPES = [
  "package model",
  "open class Base {",
  "    fun inherited(tag: String) {}",
  "}",
  "class Receiver : Base() {",
  "    fun stamp(tag: String) {}",
  "    fun conflict(tag: String) {}",
  "    private fun secret(tag: String) {}",
  "    fun dflt(tag: String): String = tag",
  "}",
  "class Inner { fun stamp(tag: String) {} }",
  "fun build(block: Inner.() -> Unit) { Inner().block() }",
  "fun buildReceiver(block: Receiver.() -> Unit) { Receiver().block() }",
  "",
].join("\n");
const LIB = [
  "package library",
  "import model.Receiver",
  "import model.Base",
  "import model.Inner",
  "fun Receiver.imported(tag: String) {}",
  "fun Receiver.starred(tag: String) {}",
  "fun Receiver.renamed(tag: String) {}",
  "fun Receiver.conflict(tag: String) {}",
  "fun Receiver.secret(tag: String) {}",
  "fun Receiver.priority(tag: String) {}",
  "fun Base.specific(tag: String) {}",
  "fun Receiver.specific(tag: String) {}",
  "fun Inner.innerOnly(tag: String) {}",
  "",
].join("\n");
const PEER = [
  "package app",
  "import model.Receiver",
  "import model.Base",
  "fun Receiver.peer(tag: String) {}",
  "private fun Receiver.hidden(tag: String) {}",
  "fun Receiver.priority(tag: String) {}",
  "fun Base.more(tag: String) {}",
  "fun Receiver.more(tag: String) {}",
  "",
].join("\n");
const USE = [
  "package app",
  "import model.Receiver",
  "import model.build",
  "import model.buildReceiver",
  "import library.imported",
  "import library.priority",
  "import library.specific",
  "import library.*",
  "import library.renamed as aliasName",
  "fun stamp(tag: String) {}",
  "fun imported(tag: String) {}",
  "fun peer(tag: String) {}",
  "fun hidden(tag: String) {}",
  "fun dflt(tag: String): String = tag",
  "fun innerOnly(tag: String) {}",
  'fun Receiver.topBare() { stamp("topBare") }',
  'fun Receiver.topThis() { this.stamp("topThis") }',
  'fun Receiver.topPlain() { run { stamp("topPlain") } }',
  'fun Receiver.topNested() { build { stamp("topNested") } }',
  'val Receiver.topProperty: Int get() { stamp("topProperty"); return 0 }',
  'fun Receiver.topImported() { imported("topImported") }',
  'fun Receiver.topPeer() { peer("topPeer") }',
  'fun Receiver.topHidden() { hidden("topHidden") }',
  'fun Receiver.topConflict() { conflict("topConflict") }',
  'fun Receiver.topSecret() { secret("topSecret") }',
  'fun Receiver.topAlias() { aliasName("topAlias") }',
  'fun Receiver.topDefault(value: String = dflt("topDefault")) {}',
  'val Receiver.topLabel: Int get() { this@topLabel.stamp("topLabel"); return 0 }',
  'val Receiver.topPropertyThis: Int get() { this.stamp("topPropertyThis"); return 0 }',
  "var Receiver.topSetter: Int",
  "    get() = 0",
  '    set(value) { stamp("topSetter") }',
  'fun Receiver.topUnrelated() { innerOnly("topUnrelated") }',
  "class Host {",
  "    fun stamp(tag: String) {}",
  "    fun imported(tag: String) {}",
  "    fun peer(tag: String) {}",
  "    fun hidden(tag: String) {}",
  "    fun conflict(tag: String) {}",
  "    fun memberExt(tag: String) {}",
  "    fun ghost(tag: String) {}",
  "    fun priority(tag: String) {}",
  "    fun specific(tag: String) {}",
  "    fun more(tag: String) {}",
  "    fun dflt(tag: String): String = tag",
  "    fun innerOnly(tag: String) {}",
  "    fun invoke() {}",
  "    fun Receiver.memberExt(tag: String) {}",
  '    fun Receiver.memberBare() { stamp("memberBare") }',
  '    fun Receiver.memberThis() { this.stamp("memberThis") }',
  '    fun Receiver.memberInherited() { inherited("memberInherited") }',
  '    fun Receiver.memberImported() { imported("memberImported") }',
  '    fun Receiver.memberPeer() { peer("memberPeer") }',
  '    fun Receiver.memberHidden() { hidden("memberHidden") }',
  '    fun Receiver.memberConflict() { conflict("memberConflict") }',
  '    fun Receiver.memberExtension() { memberExt("memberExtension") }',
  '    fun Receiver.memberNested() { build { stamp("memberNested") } }',
  '    fun Receiver.memberPlain() { run { stamp("memberPlain") } }',
  '    fun Receiver.memberPriority() { priority("memberPriority") }',
  '    fun Receiver.memberSpecific() { specific("memberSpecific") }',
  '    fun Receiver.memberMore() { more("memberMore") }',
  '    fun lambdaPeer() { buildReceiver { peer("lambdaPeer") } }',
  '    fun <T> T.genericReceiver() { ghost("genericReceiver") }',
  '    val Receiver.memberProperty: Int get() { stamp("memberProperty"); return 0 }',
  '    fun Receiver.memberDefault(value: String = dflt("memberDefault")) {}',
  '    fun Receiver.memberUnrelated() { innerOnly("memberUnrelated") }',
  '    fun Receiver.memberLabelLambda() { build { this@memberLabelLambda.stamp("memberLabelLambda") } }',
  '    fun anonymousHolder() { val block = fun Receiver.() { stamp("anonymousHolder") } }',
  "    fun (() -> Unit).functionTypeInvoke() { invoke() }",
  "}",
  "",
].join("\n");
const EXTERNAL_EXTENSION = ["package externalapp", "fun ArrayList<String>.sparkle(tag: String) {}", ""].join("\n");
const EXTERNAL = [
  "package externalapp",
  "class ExternalHost {",
  "    fun sparkle(tag: String) {}",
  "    fun free(tag: String) {}",
  "    fun add(tag: String) {}",
  '    fun ArrayList<String>.externalBare() { sparkle("externalBare") }',
  '    fun ArrayList<String>.externalThis() { this.sparkle("externalThis") }',
  '    fun ArrayList<String>.externalAbsent() { free("externalAbsent") }',
  '    fun ArrayList<String>.externalKnownMember() { add("externalKnownMember") }',
  '    fun com.example.Unknown.externalUnknown() { free("externalUnknown") }',
  "}",
  "",
].join("\n");
const NULLABLE = [
  "package nullableapp",
  "import model.Receiver",
  "fun Receiver?.nullableExt(tag: String) {}",
  "class NullableHost {",
  "    fun nullableExt(tag: String) {}",
  "    fun stamp(tag: String) {}",
  '    fun Receiver?.nullableBare() { nullableExt("nullableBare") }',
  '    fun Receiver?.nullableThis() { this.nullableExt("nullableThis") }',
  '    fun Receiver?.nullableFallback() { stamp("nullableFallback") }',
  "}",
  "",
].join("\n");
const FILES = {
  "model/Types.kt": TYPES,
  "library/Lib.kt": LIB,
  "app/Peer.kt": PEER,
  "app/Use.kt": USE,
  "external/Extension.kt": EXTERNAL_EXTENSION,
  "external/Use.kt": EXTERNAL,
  "nullable/Use.kt": NULLABLE,
  ...KOTLIN_RECEIVER_REVIEW_SOURCES,
};

type Target = { file: string; line: number; token: string };
function lineOf(source: string, text: string): number {
  const line = source.split("\n").findIndex((part) => part.includes(text));
  if (line < 0) throw new Error(`Missing ${text}`);
  return line + 1;
}
const target = (file: string, source: string, text: string, token: string): Target => ({
  file,
  line: lineOf(source, text),
  token,
});
const receiverStamp = target("model/Types.kt", TYPES, "fun stamp", "stamp");
const innerStamp = target("model/Types.kt", TYPES, "class Inner", "stamp");
const hostStamp = target("app/Use.kt", USE, "    fun stamp", "stamp");
const topStamp = target("app/Use.kt", USE, "fun stamp", "stamp");
const imported = target("library/Lib.kt", LIB, "Receiver.imported", "imported");
const peer = target("app/Peer.kt", PEER, "Receiver.peer", "peer");
const hostPeer = target("app/Use.kt", USE, "    fun peer", "peer");
const hostImported = target("app/Use.kt", USE, "    fun imported", "imported");
const hidden = target("app/Peer.kt", PEER, "Receiver.hidden", "hidden");
const topHidden = target("app/Use.kt", USE, "fun hidden", "hidden");
const hostHidden = target("app/Use.kt", USE, "    fun hidden", "hidden");
const receiverConflict = target("model/Types.kt", TYPES, "fun conflict", "conflict");
const extensionConflict = target("library/Lib.kt", LIB, "Receiver.conflict", "conflict");
const secret = target("library/Lib.kt", LIB, "Receiver.secret", "secret");
const privateSecret = target("model/Types.kt", TYPES, "private fun secret", "secret");
const inherited = target("model/Types.kt", TYPES, "fun inherited", "inherited");
const renamed = target("library/Lib.kt", LIB, "Receiver.renamed", "renamed");
const memberExtension = target("app/Use.kt", USE, "fun Receiver.memberExt(", "memberExt");
const ordinaryMember = target("app/Use.kt", USE, "    fun memberExt(", "memberExt");
const importedPriority = target("library/Lib.kt", LIB, "Receiver.priority", "priority");
const packagePriority = target("app/Peer.kt", PEER, "Receiver.priority", "priority");
const specificReceiver = target("library/Lib.kt", LIB, "Receiver.specific", "specific");
const specificBase = target("library/Lib.kt", LIB, "Base.specific", "specific");
const moreReceiver = target("app/Peer.kt", PEER, "Receiver.more", "more");
const moreBase = target("app/Peer.kt", PEER, "Base.more", "more");
const receiverDflt = target("model/Types.kt", TYPES, "fun dflt", "dflt");
const topDflt = target("app/Use.kt", USE, "fun dflt", "dflt");
const hostDflt = target("app/Use.kt", USE, "    fun dflt", "dflt");
const topInnerOnly = target("app/Use.kt", USE, "fun innerOnly", "innerOnly");
const hostInnerOnly = target("app/Use.kt", USE, "    fun innerOnly", "innerOnly");
const innerOnlyExtension = target("library/Lib.kt", LIB, "Inner.innerOnly", "innerOnly");

let fixture: ConsumerAgreementFixture;
beforeAll(async () => {
  fixture = await buildConsumerAgreementFixture("cg-kotlin-extension-receiver-", FILES);
});
afterAll(async () => {
  await disposeConsumerAgreementFixture(fixture);
});

describe("Kotlin extension-body implicit receivers", () => {
  it("keeps accessor calls callable, receiver-compatible, and arity-compatible beside factory-named types", async () => {
    await expectKotlinReceiverReview(fixture.index, fixture.paths);
  });

  const cases: Array<[string, string, Target, Target]> = [
    ["topBare", "stamp", receiverStamp, topStamp],
    ["topThis", "stamp", receiverStamp, topStamp],
    ["topPlain", "stamp", receiverStamp, topStamp],
    ["topNested", "stamp", innerStamp, receiverStamp],
    ["topProperty", "stamp", receiverStamp, topStamp],
    ["topImported", "imported", imported, hostImported],
    ["topPeer", "peer", peer, hostPeer],
    ["topHidden", "hidden", topHidden, hidden],
    ["topConflict", "conflict", receiverConflict, extensionConflict],
    ["topSecret", "secret", secret, privateSecret],
    ["topAlias", "aliasName", renamed, imported],
    ["memberBare", "stamp", receiverStamp, hostStamp],
    ["memberThis", "stamp", receiverStamp, hostStamp],
    ["memberInherited", "inherited", inherited, hostStamp],
    ["memberImported", "imported", imported, hostImported],
    ["memberPeer", "peer", peer, hostPeer],
    ["memberHidden", "hidden", hostHidden, hidden],
    ["memberConflict", "conflict", receiverConflict, extensionConflict],
    ["memberExtension", "memberExt(", memberExtension, ordinaryMember],
    ["memberNested", "stamp", innerStamp, receiverStamp],
    ["memberPlain", "stamp", receiverStamp, hostStamp],
    ["memberPriority", "priority(", importedPriority, packagePriority],
    ["memberSpecific", "specific(", specificReceiver, specificBase],
    ["memberMore", "more(", moreReceiver, moreBase],
    ["memberProperty", "stamp", receiverStamp, hostStamp],
    ["lambdaPeer", "peer", peer, hostPeer],
    ["topDefault", "dflt", receiverDflt, topDflt],
    ["topLabel", "stamp", receiverStamp, topStamp],
    ["topPropertyThis", "stamp", receiverStamp, topStamp],
    ["topSetter", "stamp", receiverStamp, topStamp],
    ["topUnrelated", "innerOnly", topInnerOnly, innerOnlyExtension],
    ["memberDefault", "dflt", receiverDflt, hostDflt],
    ["memberUnrelated", "innerOnly", hostInnerOnly, innerOnlyExtension],
    ["memberLabelLambda", "stamp", receiverStamp, innerStamp],
    ["anonymousHolder", "stamp", receiverStamp, hostStamp],
  ];
  it.each(cases)("%s binds %s to the accessible receiver declaration", async (caller, token, expected, decoy) => {
    const site = { file: "app/Use.kt", line: lineOf(USE, `\"${caller}\"`), token };
    await assertConsumerAgreement(fixture, {
      ...site,
      expected: { file: expected.file, line: expected.line },
      edges: [{ label: "calls", from: { file: site.file, name: caller } }],
    });
    await assertConsumerAgreement(fixture, {
      ...site,
      mustNotMatch: decoy,
      provablyNotAReference: true,
      absentEdge: { label: "calls", from: { file: site.file, name: caller } },
    });
  });

  it("leaves an unproven generic receiver unresolved before an enclosing member", async () => {
    await assertConsumerAgreement(fixture, {
      file: "app/Use.kt",
      line: lineOf(USE, '"genericReceiver"'),
      token: "ghost",
      expected: "not_found",
      sameNameDeclaration: target("app/Use.kt", USE, "fun ghost", "ghost"),
      edges: [{ label: "calls", from: { file: "app/Use.kt", name: "genericReceiver" }, absent: true }],
    });
  });

  it("leaves a function-type receiver's members unproven before an enclosing member", async () => {
    await assertConsumerAgreement(fixture, {
      file: "app/Use.kt",
      line: lineOf(USE, "functionTypeInvoke"),
      token: "invoke(",
      expected: "not_found",
      sameNameDeclaration: target("app/Use.kt", USE, "    fun invoke", "invoke"),
      edges: [{ label: "calls", from: { file: "app/Use.kt", name: "functionTypeInvoke" }, absent: true }],
    });
  });
});

describe("known and unknown external extension receivers", () => {
  it.each(["externalBare", "externalThis"])("%s resolves a same-package project extension", async (caller) => {
    const site = { file: "external/Use.kt", line: lineOf(EXTERNAL, `\"${caller}\"`), token: "sparkle" };
    await assertConsumerAgreement(fixture, {
      ...site,
      expected: { file: "external/Extension.kt", line: 2 },
      edges: [{ label: "calls", from: { file: site.file, name: caller } }],
    });
    await assertConsumerAgreement(fixture, {
      ...site,
      mustNotMatch: target("external/Use.kt", EXTERNAL, "fun sparkle", "sparkle"),
      provablyNotAReference: true,
      absentEdge: { label: "calls", from: { file: site.file, name: caller } },
    });
  });
  it("falls through when the known receiver omits the name", async () => {
    await assertConsumerAgreement(fixture, {
      file: "external/Use.kt",
      line: lineOf(EXTERNAL, '\"externalAbsent\"'),
      token: "free",
      expected: { file: "external/Use.kt", line: lineOf(EXTERNAL, "fun free") },
      edges: [{ label: "calls", from: { file: "external/Use.kt", name: "externalAbsent" } }],
    });
  });
  it.each([
    ["externalKnownMember", "add"],
    ["externalUnknown", "free"],
  ])("%s keeps the enclosing member unproven", async (caller, token) => {
    await assertConsumerAgreement(fixture, {
      file: "external/Use.kt",
      line: lineOf(EXTERNAL, `\"${caller}\"`),
      token: `${token}(`,
      expected: "not_found",
      sameNameDeclaration: target("external/Use.kt", EXTERNAL, `fun ${token}`, token),
      edges: [{ label: "calls", from: { file: "external/Use.kt", name: caller }, absent: true }],
    });
  });
});

describe("nullable extension receivers", () => {
  it.each(["nullableBare", "nullableThis"])("%s resolves an extension on the nullable receiver", async (caller) => {
    const site = { file: "nullable/Use.kt", line: lineOf(NULLABLE, `\"${caller}\"`), token: "nullableExt(" };
    await assertConsumerAgreement(fixture, {
      ...site,
      expected: { file: site.file, line: lineOf(NULLABLE, "fun Receiver?.nullableExt") },
      edges: [{ label: "calls", from: { file: site.file, name: caller } }],
    });
    await assertConsumerAgreement(fixture, {
      ...site,
      mustNotMatch: target(site.file, NULLABLE, "    fun nullableExt", "nullableExt"),
      provablyNotAReference: true,
      absentEdge: { label: "calls", from: { file: site.file, name: caller } },
    });
  });
  it("skips a non-null receiver member and retains the dispatch receiver", async () => {
    await assertConsumerAgreement(fixture, {
      file: "nullable/Use.kt",
      line: lineOf(NULLABLE, '\"nullableFallback\"'),
      token: "stamp",
      expected: { file: "nullable/Use.kt", line: lineOf(NULLABLE, "fun stamp") },
      edges: [{ label: "calls", from: { file: "nullable/Use.kt", name: "nullableFallback" } }],
    });
  });
});
