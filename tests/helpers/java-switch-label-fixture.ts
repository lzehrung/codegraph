import { expect } from "vitest";
import { buildSymbolGraphDetailed, findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { UNPROVEN_JAVA_SWITCH_CASE_REASON } from "../../src/indexer/ambiguous-resolution.js";
import {
  expectGoto,
  expectReferences,
  placeOf,
  type Batch3Fixture,
  type Place,
  type Sources,
} from "./csharp-java-batch3-fixture.js";

export const JAVA_SWITCH_LABEL_SOURCES: Sources = {
  "labels/Mode.java": "package labels; public enum Mode { STARTED, STOPPED }\n",
  "labels/Cases.java": [
    "package labels;",
    "class Cases {",
    "  static final int STARTED = 7;",
    "  static final int TOKEN = 1;",
    "  Mode field;",
    "  int number;",
    "  Mode peek() { return Mode.STOPPED; }",
    "  int intPeek() { return TOKEN; }",
    "  int unknown() { return switch (peek()) { case STARTED -> STARTED; default -> 0; }; }",
    "  int known(Mode value) { return switch (value) { case STARTED -> STARTED; default -> 0; }; }",
    "  int primitive(int value) { return switch (value) { case STARTED -> STARTED; default -> 0; }; }",
    "  int own() { return switch (this.field) { case STARTED -> STARTED; default -> 0; }; }",
    "  int bare() { return switch (field) { case STARTED -> STARTED; default -> 0; }; }",
    "  int numericField() { return switch (this.number) { case STARTED -> STARTED; default -> 0; }; }",
    "  int integerCall() { return switch (intPeek()) { case STARTED -> STARTED; default -> 0; }; }",
    "  int noCollision() { return switch (intPeek()) { case TOKEN -> TOKEN; default -> 0; }; }",
    "  int local(Mode input) { Mode value = input; return switch (value) { case STARTED -> STARTED; default -> 0; }; }",
    "}",
    "",
  ].join("\n"),
  "app/Imported.java": [
    "package app;",
    "import labels.Mode;",
    "class Imported {",
    "  static final int STARTED = 7;",
    "  Mode peek() { return Mode.STARTED; }",
    "  int run() { return switch (peek()) { case STARTED -> STARTED; default -> 0; }; }",
    "}",
    "",
  ].join("\n"),
  "isolated/Integers.java": [
    "package isolated;",
    "class Integers {",
    "  static final int STARTED = 7;",
    "  int peek() { return STARTED; }",
    "  int run() { return switch (peek()) { case STARTED -> STARTED; default -> 0; }; }",
    "}",
    "",
  ].join("\n"),
  "app/StaticOnly.java": [
    "package app;",
    "import static labels.Mode.STARTED;",
    "class StaticOnly {",
    "  static final int STARTED = 7;",
    "  labels.Mode peek() { return labels.Mode.STOPPED; }",
    "  int run() { return switch (peek()) { case STARTED -> STARTED; default -> 0; }; }",
    "}",
    "",
  ].join("\n"),
  "wild/Wildcard.java": [
    "package wild;",
    "import labels.*;",
    "class Wildcard {",
    "  static final int STARTED = 7;",
    "  Mode peek() { return Mode.STOPPED; }",
    "  int run() { return switch (peek()) { case STARTED -> STARTED; default -> 0; }; }",
    "}",
    "",
  ].join("\n"),
  "labels/Child.java": [
    "package labels;",
    "class Child extends Cases {",
    "  int inherited() { return switch (field) { case STARTED -> 1; default -> 0; }; }",
    "  int explicit() { return switch (this.field) { case STARTED -> 1; default -> 0; }; }",
    "}",
    "",
  ].join("\n"),
};

const at = (file: string, line: number, token: string, nth = 1): Place => ({ file, line, token, nth });
export const JAVA_SWITCH_ENUM = at("labels/Mode.java", 1, "STARTED");
export const JAVA_SWITCH_FIELD = at("labels/Cases.java", 3, "STARTED");
export const JAVA_SWITCH_ENUM_LABELS = [
  ...[10, 12, 13, 17].map((line) => at("labels/Cases.java", line, "STARTED")),
  at("labels/Child.java", 4, "STARTED"),
];
export const JAVA_SWITCH_FIELD_READS = [
  ...[9, 10, 11, 12, 13, 14, 15, 17].map((line) => at("labels/Cases.java", line, "STARTED", 2)),
  ...[11, 14].map((line) => at("labels/Cases.java", line, "STARTED")),
];
export const JAVA_SWITCH_UNKNOWN_LABELS = [
  at("labels/Cases.java", 9, "STARTED"),
  at("labels/Cases.java", 15, "STARTED"),
  at("app/Imported.java", 6, "STARTED"),
  at("app/StaticOnly.java", 6, "STARTED"),
  at("wild/Wildcard.java", 6, "STARTED"),
];

/** Declared enum/primitive subjects stay exact; only an unproven enum/field collision is conservative. */
export async function expectJavaSwitchLabels(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  for (const use of JAVA_SWITCH_ENUM_LABELS) await expectGoto(fixture, index, use, JAVA_SWITCH_ENUM);
  for (const use of JAVA_SWITCH_FIELD_READS) await expectGoto(fixture, index, use, JAVA_SWITCH_FIELD);
  // Bare inherited values are not proven by ordinary lookup; the explicit receiver above is.
  await expectGoto(fixture, index, at("labels/Child.java", 3, "STARTED"), "not_found");
  for (const use of JAVA_SWITCH_UNKNOWN_LABELS) {
    const answer = await goToDefinition(index, { file: fixture.files[use.file]!, ...placeOf(fixture.sources, use) });
    expect(answer).toEqual({ status: "not_found", reason: UNPROVEN_JAVA_SWITCH_CASE_REASON });
  }
  await expectReferences(
    fixture,
    index,
    JAVA_SWITCH_ENUM,
    [
      JAVA_SWITCH_ENUM,
      ...JAVA_SWITCH_ENUM_LABELS,
      at("app/Imported.java", 5, "STARTED"),
      at("app/StaticOnly.java", 2, "STARTED"),
    ],
    "partial",
  );
  await expectReferences(fixture, index, JAVA_SWITCH_FIELD, [JAVA_SWITCH_FIELD, ...JAVA_SWITCH_FIELD_READS], "partial");
  const token = at("labels/Cases.java", 4, "TOKEN");
  const tokenReads = [
    at("labels/Cases.java", 8, "TOKEN"),
    at("labels/Cases.java", 16, "TOKEN"),
    at("labels/Cases.java", 16, "TOKEN", 2),
  ];
  for (const use of tokenReads) await expectGoto(fixture, index, use, token);
  await expectReferences(fixture, index, token, [token, ...tokenReads], "complete");
  const isolated = at("isolated/Integers.java", 3, "STARTED");
  const isolatedReads = [
    at("isolated/Integers.java", 4, "STARTED"),
    at("isolated/Integers.java", 5, "STARTED"),
    at("isolated/Integers.java", 5, "STARTED", 2),
  ];
  for (const use of isolatedReads) await expectGoto(fixture, index, use, isolated);
  await expectReferences(fixture, index, isolated, [isolated, ...isolatedReads], "complete");
  const graph = await buildSymbolGraphDetailed(index);
  for (const use of JAVA_SWITCH_UNKNOWN_LABELS) {
    const site = placeOf(fixture.sources, use);
    expect(
      graph.edges.filter(
        (edge) =>
          edge.site?.file === fixture.files[use.file] &&
          edge.site.range.start.line === site.line &&
          edge.site.range.start.column === site.column,
      ),
    ).toEqual([]);
  }
}

const BOXED_SELECTOR_TYPES = ["Byte", "Short", "Integer", "Character"] as const;
const BOXED_SELECTOR_CASES = BOXED_SELECTOR_TYPES.flatMap((type) =>
  [false, true].map((qualified) => {
    const spelling = qualified ? "qualified" : "simple";
    const packageName = `boxed_${type.toLowerCase()}_${spelling}`;
    return {
      file: `${packageName}/Boxed.java`,
      packageName,
      selector: qualified ? `java.lang.${type}` : type,
    };
  }),
);
const SHADOWED_SELECTOR_CASES = BOXED_SELECTOR_TYPES.map((type) => {
  const packageName = `shadowed_${type.toLowerCase()}`;
  return { file: `${packageName}/Shadow.java`, packageName, type };
});

/** Boxed selectors retain constant fields; a project enum with the same type name still owns its labels. */
export const JAVA_BOXED_SWITCH_SOURCES: Sources = Object.fromEntries([
  ...BOXED_SELECTOR_CASES.map(({ file, packageName, selector }) => [
    file,
    [
      `package ${packageName};`,
      "enum Other { N }",
      "class Boxed {",
      "  static final int N = 1;",
      `  ${selector} value;`,
      `  int parameter(${selector} selector) { return switch (selector) { case N -> N; default -> 0; }; }`,
      `  int local(${selector} selector) { ${selector} value = selector; return switch (value) { case N -> N; default -> 0; }; }`,
      "  int selected() { return switch (this.value) { case N -> N; default -> 0; }; }",
      "  int bare() { return switch (value) { case N -> N; default -> 0; }; }",
      "  int read() { return N; }",
      "}",
      "",
    ].join("\n"),
  ]),
  ...SHADOWED_SELECTOR_CASES.map(({ file, packageName, type }) => [
    file,
    [
      `package ${packageName};`,
      `enum ${type} { N }`,
      "class Shadow {",
      "  static final int N = 7;",
      `  int selected(${type} selector) { return switch (selector) { case N -> N; default -> 0; }; }`,
      "}",
      "",
    ].join("\n"),
  ]),
]);

export const JAVA_BOXED_SWITCH_RENAME_ROWS = [
  ...BOXED_SELECTOR_CASES.map(({ file }) => ({
    sources: JAVA_BOXED_SWITCH_SOURCES,
    declaration: at(file, 4, "N"),
    references: [
      at(file, 4, "N"),
      ...[6, 7, 8, 9].flatMap((line) => [at(file, line, "N"), at(file, line, "N", 2)]),
      at(file, 10, "N"),
    ],
  })),
  ...SHADOWED_SELECTOR_CASES.flatMap(({ file }) => [
    {
      sources: JAVA_BOXED_SWITCH_SOURCES,
      declaration: at(file, 2, "N"),
      references: [at(file, 2, "N"), at(file, 5, "N")],
    },
    {
      sources: JAVA_BOXED_SWITCH_SOURCES,
      declaration: at(file, 4, "N"),
      references: [at(file, 4, "N"), at(file, 5, "N", 2)],
    },
  ]),
];

export async function expectJavaBoxedSwitches(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  for (const row of JAVA_BOXED_SWITCH_RENAME_ROWS) {
    for (const use of row.references.slice(1)) await expectGoto(fixture, index, use, row.declaration);
    await expectReferences(fixture, index, row.declaration, row.references, "complete");
  }
  for (const { file } of BOXED_SELECTOR_CASES) {
    const decoy = at(file, 2, "N");
    await expectReferences(fixture, index, decoy, [decoy], "complete");
  }
}

export const JAVA_PEER_SWITCH_SOURCES: Sources = {
  "peerlabels/Color.java": "package peerlabels; enum Color { RED, GREEN }\n",
  "peerlabels/Use.java": [
    "package peerlabels;",
    "class Use {",
    "  static final int RED = 1;",
    "  Color peek() { return Color.GREEN; }",
    "  int choose() { return switch (peek()) { case RED -> RED; default -> 0; }; }",
    "}",
    "",
  ].join("\n"),
};

export const JAVA_PEER_SWITCH_RENAME_ROWS = [
  {
    sources: JAVA_PEER_SWITCH_SOURCES,
    declaration: at("peerlabels/Color.java", 1, "RED"),
    references: [at("peerlabels/Color.java", 1, "RED")],
    coverage: "partial" as const,
    unsafe: true,
  },
  {
    sources: JAVA_PEER_SWITCH_SOURCES,
    declaration: at("peerlabels/Use.java", 3, "RED"),
    references: [at("peerlabels/Use.java", 3, "RED"), at("peerlabels/Use.java", 5, "RED", 2)],
    coverage: "partial" as const,
    unsafe: true,
  },
];

export async function expectJavaPeerSwitchCoverage(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const label = at("peerlabels/Use.java", 5, "RED");
  const answer = await goToDefinition(index, { file: fixture.files[label.file]!, ...placeOf(fixture.sources, label) });
  expect(answer).toEqual({ status: "not_found", reason: UNPROVEN_JAVA_SWITCH_CASE_REASON });
  for (const row of JAVA_PEER_SWITCH_RENAME_ROWS) {
    for (const use of row.references.slice(1)) await expectGoto(fixture, index, use, row.declaration);
    await expectReferences(fixture, index, row.declaration, row.references, row.coverage);
  }
  const declaration = JAVA_PEER_SWITCH_RENAME_ROWS[0]!.declaration;
  const refs = await findReferences(index, {
    file: fixture.files[declaration.file]!,
    ...placeOf(fixture.sources, declaration),
  });
  expect(refs.status).toBe("ok");
  if (refs.status === "ok") expect(refs.referenceCoverage.reasons).toContain("strategy_unavailable");
  const green = at("peerlabels/Color.java", 1, "GREEN");
  await expectGoto(fixture, index, at("peerlabels/Use.java", 4, "GREEN"), green);
  await expectReferences(fixture, index, green, [green, at("peerlabels/Use.java", 4, "GREEN")], "complete");
}

/** Package membership alone never makes an unrelated class's constant field a bare switch label. */
export const JAVA_UNRELATED_SWITCH_SOURCES: Sources = {
  "noise/Caller.java": [
    "package noise;",
    "enum Color { RED }",
    "class Caller {",
    "  static final int RED = 1;",
    "  Color peek() { return Color.RED; }",
    "  int f() { return switch (peek()) { case RED -> RED; }; }",
    "}",
    "",
  ].join("\n"),
  "noise/Unrelated.java": [
    "package noise;",
    "class Unrelated {",
    "  static final int RED = 2;",
    "  int read() { return RED; }",
    "}",
    "",
  ].join("\n"),
  "noise/PrivatePeer.java": [
    "package noise;",
    "class PrivatePeer {",
    "  private static final int RED = 3;",
    "  int read() { return RED; }",
    "}",
    "",
  ].join("\n"),
};

export const JAVA_UNRELATED_SWITCH_RENAME_ROWS = [
  {
    sources: JAVA_UNRELATED_SWITCH_SOURCES,
    declaration: at("noise/Caller.java", 2, "RED"),
    references: [at("noise/Caller.java", 2, "RED"), at("noise/Caller.java", 5, "RED")],
    coverage: "partial" as const,
    unsafe: true,
  },
  {
    sources: JAVA_UNRELATED_SWITCH_SOURCES,
    declaration: at("noise/Caller.java", 4, "RED"),
    references: [at("noise/Caller.java", 4, "RED"), at("noise/Caller.java", 6, "RED", 2)],
    coverage: "partial" as const,
    unsafe: true,
  },
  ...["noise/Unrelated.java", "noise/PrivatePeer.java"].map((file) => ({
    sources: JAVA_UNRELATED_SWITCH_SOURCES,
    declaration: at(file, 3, "RED"),
    references: [at(file, 3, "RED"), at(file, 4, "RED")],
  })),
];

export async function expectJavaUnrelatedSwitchConstants(fixture: Batch3Fixture, index: ProjectIndex): Promise<void> {
  const label = at("noise/Caller.java", 6, "RED");
  const answer = await goToDefinition(index, { file: fixture.files[label.file]!, ...placeOf(fixture.sources, label) });
  expect(answer).toEqual({ status: "not_found", reason: UNPROVEN_JAVA_SWITCH_CASE_REASON });
  for (const row of JAVA_UNRELATED_SWITCH_RENAME_ROWS) {
    for (const use of row.references.slice(1)) await expectGoto(fixture, index, use, row.declaration);
    const coverage = "coverage" in row ? row.coverage : "complete";
    await expectReferences(fixture, index, row.declaration, row.references, coverage);
  }
}
