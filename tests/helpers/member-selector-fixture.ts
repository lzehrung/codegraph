import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { createAgentSession, type AgentSession } from "../../src/agent/session.js";
import { previewRenameWithSession } from "../../src/agent/rename-preview.js";
import { clearMemoryCache, closeDiskCacheDatabase } from "../../src/indexer/build-cache.js";
import {
  buildProjectIndex,
  buildProjectIndexIncremental,
  buildSymbolGraphDetailed,
  findReferences,
  goToDefinition,
  type ProjectIndex,
} from "../../src/index.js";

/** A token on a one-based line, optionally selecting a later occurrence on that line. */
type TokenSite = readonly [line: number, token: string, occurrence?: number];
type SelectorTarget = { declaration: TokenSite; reads: readonly TokenSite[]; noRename?: boolean };
export type MemberSelectorFixture = {
  language: string;
  file: string;
  lines: readonly string[];
  targets: readonly SelectorTarget[];
  members: readonly { use: TokenSite; declaration?: TokenSite }[];
};

export const MEMBER_SELECTOR_FIXTURES: readonly MemberSelectorFixture[] = [
  {
    language: "ruby",
    file: "main.rb",
    lines: [
      "class Box",
      "  def name; 7; end",
      "  def run(name, other)",
      "    direct = name",
      "    selected = other.name",
      "    own = self.name",
      "    receiver = name.to_i",
      "    direct + selected + own + receiver",
      "  end",
      "  def local(input, other)",
      "    name = input",
      "    direct = name",
      "    selected = other.name",
      "    own = self.name",
      "    receiver = name.to_i",
      "    direct + selected + own + receiver",
      "  end",
      "  def bare; name(); end",
      "end",
      'raise "wrong result" unless Box.new.run(3, Box.new) == 20 && Box.new.local(3, Box.new) == 20 && Box.new.bare == 7',
    ],
    targets: [
      {
        declaration: [3, "name"],
        reads: [
          [4, "name"],
          [7, "name"],
        ],
        noRename: true,
      },
      { declaration: [3, "other"], reads: [[5, "other"]], noRename: true },
      {
        declaration: [11, "name"],
        reads: [
          [12, "name"],
          [15, "name"],
        ],
      },
    ],
    members: [
      { use: [5, "name"] },
      { use: [6, "name"] },
      { use: [13, "name"] },
      { use: [14, "name"] },
      { use: [18, "name"], declaration: [2, "name"] },
    ],
  },
  {
    language: "rust",
    file: "main.rs",
    lines: [
      "#![allow(dead_code, non_upper_case_globals)]",
      "mod other { pub const name: i32 = 11; }",
      "struct Box { name: i32 }",
      "impl Box {",
      "  fn run(&self, name: i32, other: &Box) -> i32 {",
      "    let direct = name;",
      "    let selected = other.name;",
      "    let own = self.name;",
      "    let path = crate::other::name;",
      "    let receiver = name.abs();",
      "    direct + selected + own + path + receiver",
      "  }",
      "}",
      "fn main() { assert_eq!(Box { name: 7 }.run(3, &Box { name: 5 }), 29); }",
    ],
    targets: [
      {
        declaration: [5, "name"],
        reads: [
          [6, "name"],
          [10, "name"],
        ],
      },
      { declaration: [5, "other"], reads: [[7, "other"]] },
    ],
    members: [
      { use: [7, "name"] },
      { use: [8, "name"] },
      { use: [9, "name"] },
      { use: [9, "other"], declaration: [2, "other"] },
    ],
  },
  {
    language: "c",
    file: "main.c",
    lines: [
      "struct Box { int name; };",
      "int run(int name, struct Box other, struct Box *ptr) {",
      "  int direct = name;",
      "  int selected = other.name;",
      "  int pointed = ptr->name;",
      "  return direct + selected + pointed + name;",
      "}",
      "int read(struct Box *name) { return name->name; }",
      "int field(struct Box other) { return other.name; }",
      "int initial(int name) { struct Box other = { .name = name }; return other.name + name; }",
      "int main(void) { struct Box a = {5}; struct Box b = {7}; return run(3, a, &b) == 18 && read(&a) == 5 && field(a) == 5 && initial(4) == 8 ? 0 : 1; }",
    ],
    targets: [
      { declaration: [1, "name"], reads: [[9, "name"]], noRename: true },
      {
        declaration: [2, "name"],
        reads: [
          [3, "name"],
          [6, "name"],
        ],
      },
      { declaration: [8, "name"], reads: [[8, "name", 1]], noRename: true },
      { declaration: [2, "other"], reads: [[4, "other"]] },
      {
        declaration: [10, "name"],
        reads: [
          [10, "name", 2],
          [10, "name", 4],
        ],
      },
    ],
    members: [
      { use: [4, "name"] },
      { use: [5, "name"] },
      { use: [8, "name", 2] },
      { use: [10, "name", 1] },
      { use: [10, "name", 3] },
    ],
  },
  {
    language: "swift",
    file: "main.swift",
    lines: [
      "struct Foo { let value: Int }",
      "func f(title: Int) -> Int { return title }",
      "func run(_ value: Int, _ title: Int) -> Int {",
      "  let box = Foo(value: value)",
      "  let result = f(title: title)",
      "  let quoted = f(`title`: title)",
      "  let labeled = (title: title, value: value)",
      "  let plain = (title, value)",
      "  let second = (other: title, kept: value)",
      "  let local = value",
      "  let pair2 = (local: local, value: value)",
      "  let quotedTuple = (`title`: title, value: value)",
      "  return value + title + box.value + result + quoted + labeled.value + pair2.local",
      "}",
      "precondition(run(3, 5) == 27)",
      "func typeLabels(_ value: Int, _ title: Int) {",
      "  let _: (value: Int, title: Int) = (value: value, title: title)",
      "}",
    ],
    targets: [
      {
        declaration: [3, "value"],
        reads: [
          [4, "value", 1],
          [7, "value", 1],
          [8, "value"],
          [9, "value"],
          [10, "value"],
          [11, "value", 1],
          [12, "value", 1],
          [13, "value"],
        ],
      },
      {
        declaration: [3, "title"],
        reads: [
          [5, "title", 1],
          [6, "title", 1],
          [7, "title", 1],
          [8, "title"],
          [9, "title"],
          [12, "title", 1],
          [13, "title"],
        ],
      },
      { declaration: [10, "local"], reads: [[11, "local", 1]] },
      { declaration: [16, "value"], reads: [[17, "value", 2]] },
      { declaration: [16, "title"], reads: [[17, "title", 2]] },
    ],
    members: [
      { use: [4, "value"] },
      { use: [5, "title"] },
      { use: [6, "title"] },
      { use: [7, "title"] },
      { use: [7, "value"] },
      { use: [9, "other"] },
      { use: [9, "kept"] },
      { use: [11, "local"] },
      { use: [11, "value"] },
      { use: [12, "title"] },
      { use: [12, "value"] },
      { use: [13, "value", 1] },
      { use: [13, "value", 2] },
      { use: [13, "local"] },
      { use: [17, "value"] },
      { use: [17, "title"] },
      { use: [17, "value", 1] },
      { use: [17, "title", 1] },
    ],
  },
];

/** Value calls and module paths share spelling without sharing their references or rename edits. */
export const RUST_NAMESPACE_COLLISION_FIXTURE: MemberSelectorFixture = {
  language: "rust",
  file: "namespace.rs",
  lines: [
    "mod inner { pub const K: i32 = 3; }",
    "fn invoke() -> i32 {",
    "  let pointer = inner;",
    "  inner() + inner::K",
    "}",
    "fn inner() -> i32 { 2 }",
    "fn local() -> i32 {",
    "  let inner = 4;",
    "  inner + crate::inner::K",
    "}",
    "use inner::K as IMPORTED;",
    "fn read_imported() -> i32 { IMPORTED }",
    "fn before() -> i32 { swapped() + swapped::K }",
    "fn swapped() -> i32 { 1 }",
    "mod swapped { pub const K: i32 = 2; }",
  ],
  targets: [
    {
      declaration: [1, "inner"],
      reads: [
        [4, "inner", 1],
        [9, "inner", 1],
        [11, "inner"],
      ],
      noRename: true,
    },
    {
      declaration: [6, "inner"],
      reads: [
        [3, "inner"],
        [4, "inner"],
      ],
    },
    { declaration: [8, "inner"], reads: [[9, "inner"]] },
    { declaration: [14, "swapped"], reads: [[13, "swapped"]] },
    { declaration: [15, "swapped"], reads: [], noRename: true },
  ],
  members: [],
};

/** Item names stay valid in qualified paths; same-named functions still cannot be namespace qualifiers. */
export const RUST_QUALIFIED_ITEM_FIXTURE: MemberSelectorFixture = {
  language: "rust",
  file: "main.rs",
  lines: [
    "fn shared() -> i32 { 1 }",
    "mod inner {",
    "  pub fn f() -> i32 { 2 }",
    "  pub const K: i32 = 3;",
    "  pub fn g() -> i32 { super::shared() + self::f() + crate::shared() }",
    "}",
    "fn run() -> i32 { shared() + self::shared() + crate::shared() + inner::f() + inner::K + inner::g() }",
    "#[cfg(test)]",
    "mod tests {",
    "  #[test]",
    "  fn t() { let result = super::shared(); assert_eq!(result, 1); }",
    "}",
    "fn main() { assert_eq!(run(), 12); assert_eq!(read_items(), 38); let _ = io(); }",
    "static VALUE: i32 = 5;",
    "const LIMIT: i32 = 7;",
    "fn read_items() -> i32 { self::VALUE + crate::VALUE + self::LIMIT + crate::LIMIT + Model::read() + crate::inner::K + { let _ = std::io::empty(); 0 } }",
    "struct Model;",
    "impl Model { const ASSOC: i32 = 11; fn read() -> i32 { Self::ASSOC } }",
    "fn io() -> i32 { 0 }",
  ],
  targets: [
    {
      declaration: [1, "shared"],
      reads: [
        [5, "shared"],
        [5, "shared", 1],
        [7, "shared"],
        [7, "shared", 1],
        [7, "shared", 2],
        [11, "shared"],
      ],
    },
    {
      declaration: [3, "f", 1],
      reads: [
        [5, "f", 2],
        [7, "f", 2],
      ],
    },
    {
      declaration: [4, "K"],
      reads: [
        [7, "K"],
        [16, "K"],
      ],
    },
    {
      declaration: [14, "VALUE"],
      reads: [
        [16, "VALUE"],
        [16, "VALUE", 1],
      ],
    },
    {
      declaration: [15, "LIMIT"],
      reads: [
        [16, "LIMIT"],
        [16, "LIMIT", 1],
      ],
    },
    { declaration: [18, "ASSOC"], reads: [[18, "ASSOC", 1]] },
    { declaration: [19, "io"], reads: [[13, "io"]] },
  ],
  members: [{ use: [16, "io"] }],
};

export async function expectRustQualifiedItemGoto(index: ProjectIndex, file: string): Promise<void> {
  await expectMemberSelectorGoto(index, RUST_QUALIFIED_ITEM_FIXTURE, file);
  const module = selectorSite(RUST_QUALIFIED_ITEM_FIXTURE, file, [2, "inner"]);
  for (const use of [
    [7, "inner"],
    [7, "inner", 1],
    [7, "inner", 2],
    [16, "inner"],
  ] as const) {
    const result = await goToDefinition(index, selectorSite(RUST_QUALIFIED_ITEM_FIXTURE, file, use));
    if (result.status === "ok") {
      expect([result.definition.range.start.line, result.definition.range.start.column]).toEqual([
        module.line,
        module.column,
      ]);
    } else {
      expect(result.status).toBe("not_found");
    }
  }
}

/** Languages whose member selectors already stay separate from lexical values. */
export const MEMBER_SELECTOR_CONTROLS: readonly MemberSelectorFixture[] = [
  {
    language: "cpp",
    file: "main.cpp",
    lines: ["struct Box { int name; };", "int run(int name, Box other) { return name + other.name; }"],
    targets: [{ declaration: [2, "name"], reads: [[2, "name", 1]] }],
    members: [],
  },
  {
    language: "python",
    file: "main.py",
    lines: ["class Box:", "    name = 7", "    def run(self, name):", "        return name + self.name"],
    targets: [{ declaration: [3, "name"], reads: [[4, "name"]] }],
    members: [],
  },
  {
    language: "kotlin",
    file: "Main.kt",
    lines: ["class Box(val name: Int) {", "  fun run(name: Int): Int = name + this.name", "}"],
    targets: [{ declaration: [2, "name"], reads: [[2, "name", 1]] }],
    members: [],
  },
  {
    language: "go",
    file: "main.go",
    lines: [
      "package p",
      "type Box struct { name int }",
      "func run(name int, other Box) int { return name + other.name }",
    ],
    targets: [{ declaration: [3, "name"], reads: [[3, "name", 1]] }],
    members: [],
  },
  {
    language: "ts",
    file: "main.ts",
    lines: ["class Box { name = 7; }", "function run(name: number, other: Box) { return name + other.name; }"],
    targets: [{ declaration: [2, "name"], reads: [[2, "name", 1]] }],
    members: [],
  },
  {
    language: "php",
    file: "main.php",
    lines: [
      "<?php",
      "class Box { public $name = 7; }",
      "function run($name, Box $other) { return $name + $other->name; }",
    ],
    targets: [{ declaration: [3, "$name"], reads: [[3, "$name", 1]] }],
    members: [],
  },
];

export function selectorSite(fixture: MemberSelectorFixture, file: string, [line, token, occurrence = 0]: TokenSite) {
  const text = fixture.lines[line - 1]!;
  let offset = -1;
  for (let count = 0; count <= occurrence; count += 1) offset = text.indexOf(token, offset + 1);
  if (offset < 0) throw new Error(`Missing ${fixture.file}:${line} ${token} #${occurrence}`);
  return { file, line, column: offset + 1 };
}

/** Each consumer sees a cold index and a reopened disk cache, with the native backend required. */
export async function withMemberSelectorFixture(
  fixture: MemberSelectorFixture,
  check: (index: ProjectIndex, file: string, session: AgentSession, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-member-selector-"));
  const file = path.join(root, fixture.file);
  try {
    await writeFile(file, `${fixture.lines.join("\n")}\n`);
    for (const cache of ["off", "disk", "disk"] as const) {
      clearMemoryCache();
      closeDiskCacheDatabase(root);
      const session = createAgentSession({ root, buildOptions: { cache, threads: 1 } });
      try {
        const { index } = await session.loadProject();
        for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
        await check(index, file, session, root);
      } finally {
        session.invalidate();
      }
    }
  } finally {
    closeDiskCacheDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
}

function targetPositions(fixture: MemberSelectorFixture, file: string, target: SelectorTarget) {
  return [target.declaration, ...target.reads]
    .map((token) => {
      const use = selectorSite(fixture, file, token);
      return [use.line, use.column] as const;
    })
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
}

export async function expectMemberSelectorReferences(
  index: ProjectIndex,
  fixture: MemberSelectorFixture,
  file: string,
) {
  for (const target of fixture.targets) {
    const declaration = selectorSite(fixture, file, target.declaration);
    const refs = await findReferences(index, declaration);
    expect(refs.status).toBe("ok");
    if (refs.status !== "ok") continue;
    expect(refs.referenceCoverage.state).toBe("complete");
    expect(refs.references.map((ref) => [ref.range.start.line, ref.range.start.column])).toEqual(
      targetPositions(fixture, file, target),
    );
  }
}

export async function expectMemberSelectorGoto(index: ProjectIndex, fixture: MemberSelectorFixture, file: string) {
  for (const member of fixture.members) {
    const answer = await goToDefinition(index, selectorSite(fixture, file, member.use));
    expect(answer.status, `${fixture.language} ${member.use.join(":")}`).toBe(member.declaration ? "ok" : "not_found");
    if (answer.status === "ok" && member.declaration) {
      const declaration = selectorSite(fixture, file, member.declaration);
      expect([answer.definition.range.start.line, answer.definition.range.start.column]).toEqual([
        declaration.line,
        declaration.column,
      ]);
    }
  }
  for (const target of fixture.targets) {
    for (const token of target.reads) {
      const answer = await goToDefinition(index, selectorSite(fixture, file, token));
      expect(answer.status, `${fixture.language} ${token.join(":")} -> ${target.declaration.join(":")}`).toBe("ok");
      if (answer.status !== "ok") continue;
      const declaration = selectorSite(fixture, file, target.declaration);
      expect([answer.definition.range.start.line, answer.definition.range.start.column]).toEqual([
        declaration.line,
        declaration.column,
      ]);
    }
  }
}

export async function expectMemberSelectorRename(
  session: AgentSession,
  fixture: MemberSelectorFixture,
  root: string,
  file: string,
) {
  for (const target of fixture.targets) {
    if (target.noRename) continue;
    const declaration = selectorSite(fixture, file, target.declaration);
    const preview = await previewRenameWithSession(session, {
      root,
      handle: `${fixture.file}:${declaration.line}:${declaration.column}`,
      newName: "renamed",
    });
    expect(preview.safe).toBe(true);
    expect(preview.unsafeSites).toEqual([]);
    expect(preview.edits.map((edit) => [edit.range.start.line, edit.range.start.column])).toEqual(
      targetPositions(fixture, file, target),
    );
  }
}

export async function expectMemberSelectorGraph(index: ProjectIndex, fixture: MemberSelectorFixture, file: string) {
  const graph = await buildSymbolGraphDetailed(index);
  for (const edge of graph.edges) {
    if (edge.site) expect(path.resolve(edge.site.file)).toBe(path.resolve(file));
  }
  if (fixture === RUST_NAMESPACE_COLLISION_FIXTURE) {
    const calls = graph.edges
      .filter((edge) => edge.label === "calls")
      .map((edge) => [graph.nodes.get(edge.from)?.name, graph.nodes.get(edge.to)?.name, edge.site?.range.start.line]);
    expect(calls).toEqual([
      ["invoke", "inner", 4],
      ["before", "swapped", 13],
    ]);
    return;
  }
  const expected: Record<string, readonly (readonly [string, string, string, number | null])[]> = {
    ruby: [
      ["calls", "run", "name", 6],
      ["calls", "local", "name", 14],
      ["calls", "bare", "name", 18],
      ["member_of", "name", "Box", null],
      ["member_of", "run", "Box", null],
      ["member_of", "local", "Box", null],
      ["member_of", "bare", "Box", null],
    ],
    rust: [["member_of", "run", "Box", null]],
    c: [
      ["calls", "main", "run", 11],
      ["calls", "main", "read", 11],
      ["calls", "main", "field", 11],
      ["calls", "main", "initial", 11],
    ],
    swift: [
      ["instantiates", "run", "Foo", 4],
      ["calls", "run", "f", 5],
      ["calls", "run", "f", 6],
    ],
  };
  expect(
    graph.edges.map((edge) => [
      edge.label,
      graph.nodes.get(edge.from)?.name,
      graph.nodes.get(edge.to)?.name,
      edge.site?.range.start.line ?? null,
    ]),
  ).toEqual(expected[fixture.language]);
}

/** Edited, renamed, deleted, and restored files give the same answers from warm and reopened caches as a cold build. */
export async function expectMemberSelectorCacheTransitions(fixture: MemberSelectorFixture): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cg-member-selector-transitions-"));
  const originalFile = path.join(root, fixture.file);
  let file = originalFile;
  let deleted = false;
  const source = `${fixture.lines.join("\n")}\n`;
  const check = async (): Promise<void> => {
    const cold = await buildProjectIndex(root, { cache: "off", threads: 1 });
    const warm = await buildProjectIndexIncremental(root, { cache: "disk", threads: 1 });
    clearMemoryCache();
    closeDiskCacheDatabase(root);
    const reopened = await buildProjectIndex(root, { cache: "disk", threads: 1 });
    for (const index of [cold, warm, reopened]) {
      if (deleted) {
        expect(index.byFile.size).toBe(0);
        continue;
      }
      for (const module of index.byFile.values()) expect(module.nativeOutcome).toBe("used");
      await expectMemberSelectorReferences(index, fixture, file);
      await expectMemberSelectorGoto(index, fixture, file);
      await expectMemberSelectorGraph(index, fixture, file);
    }
  };
  try {
    await writeFile(file, source);
    await check();
    const comment = fixture.language === "ruby" ? "#" : "//";
    await writeFile(file, `${source}${comment} Changed without moving the reference sites.\n`);
    await check();
    file = path.join(root, `renamed${path.extname(file)}`);
    await rename(originalFile, file);
    await check();
    await rename(file, originalFile);
    file = originalFile;
    await check();
    await rm(file);
    deleted = true;
    await check();
    await writeFile(file, source);
    deleted = false;
    await check();
  } finally {
    clearMemoryCache();
    closeDiskCacheDatabase(root);
    await rm(root, { recursive: true, force: true });
  }
}

const rustNamespaceLines = [
  "mod model;",
  "use crate::model::Item as Alias;",
  "fn shared() -> i32 { 1 }",
  "mod first { use super::shared; pub fn read() -> i32 { shared() } }",
  "mod second { use super::shared; pub fn read() -> i32 { shared() } }",
  "fn main() { let _item = Alias::new(); assert_eq!(first::read() + second::read(), 2); }",
];
export const RUST_SELECTOR_NAMESPACE_SOURCES = {
  "Cargo.toml": '[package]\nname = "selector_namespace_control"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/main.rs": `${rustNamespaceLines.join("\n")}\n`,
  "src/model.rs": "pub struct Item;\nimpl Item { pub fn new() -> Self { Self } }\n",
};

/** Qualified paths retain type/namespace segments and import source tokens, never a lexical value. */
export async function expectRustSelectorNamespace(index: ProjectIndex, files: Record<string, string>): Promise<void> {
  for (const [line, token, target, targetLine, targetColumn] of [
    [2, "model", "src/main.rs", 1, 5],
    [2, "Item", "src/model.rs", 1, 12],
    [4, "shared", "src/main.rs", 3, 4],
    [5, "shared", "src/main.rs", 3, 4],
    [6, "Alias", "src/model.rs", 1, 12],
    [6, "new", "src/model.rs", 2, 20],
  ] as const) {
    const answer = await goToDefinition(index, {
      file: files["src/main.rs"]!,
      line,
      column: rustNamespaceLines[line - 1]!.indexOf(token) + 1,
    });
    expect(answer.status, `${line}:${token}`).toBe("ok");
    if (answer.status !== "ok") continue;
    expect(path.resolve(answer.definition.file)).toBe(path.resolve(files[target]!));
    expect([answer.definition.range.start.line, answer.definition.range.start.column]).toEqual([
      targetLine,
      targetColumn,
    ]);
  }
  const references = await findReferences(index, { file: files["src/main.rs"]!, line: 3, column: 4 });
  expect(references.status).toBe("ok");
  if (references.status !== "ok") return;
  expect(references.referenceCoverage.state).toBe("complete");
  expect(references.references.map((reference) => [reference.range.start.line, reference.range.start.column])).toEqual([
    [3, rustNamespaceLines[2]!.indexOf("shared") + 1],
    [4, rustNamespaceLines[3]!.indexOf("shared") + 1],
    [4, rustNamespaceLines[3]!.lastIndexOf("shared") + 1],
    [5, rustNamespaceLines[4]!.indexOf("shared") + 1],
    [5, rustNamespaceLines[4]!.lastIndexOf("shared") + 1],
  ]);
}
