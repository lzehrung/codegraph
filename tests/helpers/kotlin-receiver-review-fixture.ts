import { expect } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { defNodeId } from "../../src/graphs/symbol-graph.js";
import { findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";

/** These targets follow compiled and executed kotlinc 2.4.21 programs, including the negative receiver cases. */
export const KOTLIN_RECEIVER_REVIEW_LINES = {
  "accessor/Accessors.kt": [
    "package accessor",
    "import java.lang.reflect.Method",
    'private fun sig(name: String, params: Array<Class<*>>, ret: String): String = "function:$name:$ret"',
    'val Method.sig: String get() = sig(name, parameterTypes, "V")',
    'val Class<*>.sig2: String get() = sig(name, emptyArray(), "V")',
    'fun Set<Annotation>.isAnnotationPresent(annotationClass: Class<out Annotation>): Boolean = error("wrong receiver")',
    "val Class<*>.isKotlin: Boolean get() = isAnnotationPresent(Metadata::class.java)",
    "fun Class<*>.isKotlin2(): Boolean = isAnnotationPresent(Metadata::class.java)",
    "class Receiver",
    "class Other",
    'fun Receiver.take(a: String, b: String): String = "two:$a:$b"',
    'fun take(a: String): String = "one:$a"',
    'fun Other.take(a: String): String = error("wrong receiver")',
    'val Receiver.arity: String get() = take("arity")',
    'val Receiver.match: String get() = take("a", "b")',
    'val Receiver.callback: (String) -> String get() = { "callback:$it" }',
    'fun Receiver.callCallback(): String = callback("call")',
    'class Invokable { operator fun invoke(value: String): String = "invoke:$value" }',
    "val Receiver.uncertain: Invokable get() = Invokable()",
    'fun Receiver.callUncertain(): String = uncertain("call")',
    'val Method.alone: String get() = "value"',
    'fun Receiver.callAlone(): String = alone("fallback")',
    'fun alone(tag: String): String = "alone:$tag"',
    "fun Method.readAlone(): String = alone",
    'private fun String.readPair(a: Int, b: Int): String = "$this:$a:$b"',
    "fun String.parsePair(): String = readPair(1, 2)",
    "private fun ByteArray.countBytes(): Int = size",
    "fun ByteArray.useBytes(): Int = countBytes()",
    "fun String.sequenceCount(): Int = sequence { emitText(this@sequenceCount) }.count()",
    "private suspend fun SequenceScope<Int>.emitText(value: String) { yield(value.length) }",
    "fun Receiver.defaulted(flag: Boolean = false, block: Receiver.() -> String): String = block()",
    'val Receiver.defaultedCall: String get() = defaulted(block = { "default" })',
    'fun Other.defaulted(block: () -> String): String = error("wrong receiver")',
    "fun Receiver.named(flag: Boolean = false, value: String): String = value",
    'val Receiver.namedCall: String get() = named(value = "named")',
    "",
  ],
  "desc/Desc.kt": [
    "package desc",
    "interface Desc {",
    "    fun elementName(i: Int): String",
    "    fun other(): Int",
    "}",
    "",
  ],
  "desc/Descs.kt": [
    "package desc",
    "class Impl : Desc {",
    '    override fun elementName(i: Int): String = "element:$i"',
    "    override fun other(): Int = 1",
    "}",
    "fun Desc(name: String): Desc = Impl()",
    "",
  ],
  "desc/Peer.kt": [
    "package desc",
    "class Peer {",
    '    private fun helper(x: Int): String = "peer:$x"',
    "    fun Desc.render(): String = elementName(1) + helper(3)",
    "}",
    "",
  ],
  "user/User.kt": [
    "package user",
    "import desc.*",
    "fun Desc.toStringImpl(): String = elementName(0) + other()",
    "class Holder {",
    '    private fun helper(x: Int): String = "helper:$x"',
    "    fun Desc.describe(): String = elementName(1) + helper(2)",
    "}",
    'fun make(): Desc = Desc("factory")',
    "",
  ],
  "foreign/Extensions.kt": [
    "package foreign",
    "import java.io.File as FileReceiver",
    'fun FileReceiver.externalTag(): String = "external"',
    "",
  ],
  "foreign/Use.kt": [
    "package foreign",
    "import java.io.File as Subject",
    "val Subject.externalProperty: String get() = externalTag()",
    "fun String.typedExternal(subject: Subject): String = subject.run { externalTag() }",
    "",
  ],
  "foreign/StarUse.kt": [
    "package foreign",
    "import java.io.*",
    "val File.starProperty: String get() = externalTag()",
    "",
  ],
} as const;

export const KOTLIN_RECEIVER_REVIEW_SOURCES = Object.fromEntries(
  Object.entries(KOTLIN_RECEIVER_REVIEW_LINES).map(([file, lines]) => [file, lines.join("\n")]),
);

type Site = { file: keyof typeof KOTLIN_RECEIVER_REVIEW_LINES; line: number; token: string };
type ReviewCase = {
  use: Site;
  target: Site | null;
  decoy?: Site;
  valueRead?: boolean;
  complete?: boolean;
  decoyCoverage?: "complete" | "partial";
};

const ACCESSOR = "accessor/Accessors.kt";
const CASES: readonly ReviewCase[] = [
  {
    use: { file: ACCESSOR, line: 4, token: "sig(" },
    target: { file: ACCESSOR, line: 3, token: "sig" },
    decoy: { file: ACCESSOR, line: 4, token: "sig:" },
    complete: true,
    decoyCoverage: "complete",
  },
  {
    use: { file: ACCESSOR, line: 5, token: "sig(" },
    target: { file: ACCESSOR, line: 3, token: "sig" },
    decoy: { file: ACCESSOR, line: 4, token: "sig:" },
    complete: true,
    decoyCoverage: "complete",
  },
  {
    use: { file: ACCESSOR, line: 7, token: "isAnnotationPresent(" },
    target: null,
    decoy: { file: ACCESSOR, line: 6, token: "isAnnotationPresent" },
    decoyCoverage: "partial",
  },
  {
    use: { file: ACCESSOR, line: 8, token: "isAnnotationPresent(" },
    target: null,
    decoy: { file: ACCESSOR, line: 6, token: "isAnnotationPresent" },
    decoyCoverage: "partial",
  },
  {
    use: { file: ACCESSOR, line: 14, token: "take(" },
    target: { file: ACCESSOR, line: 12, token: "take" },
    decoy: { file: ACCESSOR, line: 11, token: "take" },
  },
  {
    use: { file: ACCESSOR, line: 15, token: "take(" },
    target: { file: ACCESSOR, line: 11, token: "take" },
    decoy: { file: ACCESSOR, line: 13, token: "take" },
  },
  { use: { file: ACCESSOR, line: 17, token: "callback(" }, target: { file: ACCESSOR, line: 16, token: "callback" } },
  {
    use: { file: ACCESSOR, line: 20, token: "uncertain(" },
    target: null,
    decoy: { file: ACCESSOR, line: 19, token: "uncertain" },
  },
  {
    use: { file: ACCESSOR, line: 22, token: "alone(" },
    target: { file: ACCESSOR, line: 23, token: "alone" },
    decoy: { file: ACCESSOR, line: 21, token: "alone" },
  },
  {
    use: { file: ACCESSOR, line: 24, token: "alone" },
    target: { file: ACCESSOR, line: 21, token: "alone" },
    valueRead: true,
  },
  {
    use: { file: "user/User.kt", line: 6, token: "helper" },
    target: { file: "user/User.kt", line: 5, token: "helper" },
    complete: true,
  },
  {
    use: { file: "user/User.kt", line: 6, token: "elementName" },
    target: { file: "desc/Desc.kt", line: 3, token: "elementName" },
    decoy: { file: "desc/Descs.kt", line: 3, token: "elementName" },
  },
  {
    use: { file: "user/User.kt", line: 3, token: "Desc" },
    target: { file: "desc/Desc.kt", line: 2, token: "Desc" },
    decoy: { file: "desc/Descs.kt", line: 6, token: "Desc" },
    valueRead: true,
  },
  {
    use: { file: "desc/Peer.kt", line: 4, token: "helper" },
    target: { file: "desc/Peer.kt", line: 3, token: "helper" },
    complete: true,
  },
  {
    use: { file: "desc/Peer.kt", line: 4, token: "elementName" },
    target: { file: "desc/Desc.kt", line: 3, token: "elementName" },
  },
  {
    use: { file: "user/User.kt", line: 8, token: "Desc" },
    target: { file: "desc/Desc.kt", line: 2, token: "Desc" },
    valueRead: true,
  },
  {
    use: { file: "user/User.kt", line: 8, token: "Desc(" },
    target: null,
    decoy: { file: "desc/Desc.kt", line: 2, token: "Desc" },
  },
  {
    use: { file: ACCESSOR, line: 26, token: "readPair(" },
    target: { file: ACCESSOR, line: 25, token: "readPair" },
    complete: true,
  },
  {
    use: { file: ACCESSOR, line: 28, token: "countBytes(" },
    target: { file: ACCESSOR, line: 27, token: "countBytes" },
    complete: true,
  },
  {
    use: { file: ACCESSOR, line: 29, token: "emitText(" },
    target: { file: ACCESSOR, line: 30, token: "emitText" },
  },
  {
    use: { file: "foreign/Use.kt", line: 3, token: "externalTag(" },
    target: { file: "foreign/Extensions.kt", line: 3, token: "externalTag" },
  },
  {
    use: { file: "foreign/Use.kt", line: 4, token: "externalTag(" },
    target: { file: "foreign/Extensions.kt", line: 3, token: "externalTag" },
  },
  {
    use: { file: ACCESSOR, line: 32, token: "defaulted(" },
    target: { file: ACCESSOR, line: 31, token: "defaulted" },
    decoy: { file: ACCESSOR, line: 33, token: "defaulted" },
  },
  {
    use: { file: ACCESSOR, line: 35, token: "named(" },
    target: { file: ACCESSOR, line: 34, token: "named" },
  },
  {
    use: { file: "foreign/StarUse.kt", line: 3, token: "externalTag(" },
    target: { file: "foreign/Extensions.kt", line: 3, token: "externalTag" },
  },
];

function position(files: Readonly<Record<string, string>>, site: Site): { file: string; line: number; column: number } {
  const line = KOTLIN_RECEIVER_REVIEW_LINES[site.file][site.line - 1];
  const column = line?.indexOf(site.token) ?? -1;
  if (column < 0 || !files[site.file]) throw new Error(`Missing receiver fixture site ${JSON.stringify(site)}`);
  return { file: files[site.file]!, line: site.line, column: column + 1 };
}

/** All consumers must agree on the target and exclude the wrong property, arity, receiver, and factory declarations. */
export async function expectKotlinReceiverReview(
  index: ProjectIndex,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  for (const { use, target, decoy, valueRead, complete, decoyCoverage } of CASES) {
    const at = position(files, use);
    const result = await goToDefinition(index, at);
    const calls = graph.edges.filter((edge) => {
      const site = edge.site;
      if (edge.label !== "calls" || !site) return false;
      if (fileIdentityKey(site.file) !== fileIdentityKey(at.file)) return false;
      return site.range.start.line === at.line && site.range.start.column === at.column;
    });
    if (!target) {
      expect(result.status, JSON.stringify(use)).toBe("not_found");
      expect(calls, JSON.stringify(use)).toEqual([]);
    } else {
      const expected = position(files, target);
      expect(result.status, JSON.stringify(use)).toBe("ok");
      if (result.status !== "ok") throw new Error(`Unresolved receiver fixture site ${JSON.stringify(use)}`);
      expect(fileIdentityKey(result.definition.file)).toBe(fileIdentityKey(expected.file));
      expect(result.definition.range.start).toMatchObject({ line: expected.line, column: expected.column });
      const refs = await findReferences(index, expected);
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error(`Missing target references ${JSON.stringify(target)}`);
      if (complete) expect(refs.referenceCoverage.state).toBe("complete");
      expect(
        refs.references.some((ref) => {
          if (fileIdentityKey(ref.file) !== fileIdentityKey(at.file)) return false;
          return ref.range.start.line === at.line && ref.range.start.column === at.column;
        }),
        JSON.stringify(use),
      ).toBe(true);
      if (!valueRead) {
        expect(calls, JSON.stringify(use)).toHaveLength(1);
        expect(calls[0]?.to).toBe(defNodeId(result.definition));
      }
    }
    if (decoy) {
      const refs = await findReferences(index, position(files, decoy));
      expect(refs.status).toBe("ok");
      if (refs.status !== "ok") throw new Error(`Missing decoy references ${JSON.stringify(decoy)}`);
      if (decoyCoverage) expect(refs.referenceCoverage.state).toBe(decoyCoverage);
      expect(
        refs.references.some((ref) => {
          if (fileIdentityKey(ref.file) !== fileIdentityKey(at.file)) return false;
          return ref.range.start.line === at.line && ref.range.start.column === at.column;
        }),
        JSON.stringify(use),
      ).toBe(false);
    }
  }
}
