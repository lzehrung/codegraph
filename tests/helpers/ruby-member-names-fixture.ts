import { expect } from "vitest";
import { buildSymbolGraphDetailed } from "../../src/graphs/symbol-graph-detailed.js";
import { findReferences, goToDefinition, type ProjectIndex } from "../../src/index.js";
import { fileIdentityKey } from "../../src/util/paths.js";

/**
 * `Gauge` declares `?` and `!` methods, `attr_*` accessors (symbol and string arguments), and a writer beside its
 * reader. `Dial` repeats each name in another file as a same-named decoy.
 */
export const RUBY_MEMBER_LINES: Record<string, string[]> = {
  "gauge.rb": [
    "class Gauge",
    '  attr_reader :level, "unit"',
    "  attr_accessor :mode",
    "",
    "  def full?",
    "    level > 0",
    "  end",
    "",
    "  def full",
    "    level",
    "  end",
    "",
    "  def drain!",
    "    self.mode = :idle",
    "  end",
    "",
    "  def label=(value)",
    "    @label = value",
    "  end",
    "",
    "  def label",
    "    @label",
    "  end",
    "",
    "  def check",
    "    full?",
    "    full",
    "    drain!",
    "    self.label = 1",
    "    self.label",
    "    self.mode",
    "  end",
    "end",
    "",
  ],
  "use.rb": [
    'require_relative "gauge"',
    'require_relative "dial"',
    "",
    "Gauge.new.full?",
    "Gauge.new.level",
    "Gauge.new.unit",
    "Gauge.new.label = 2",
    "Dial.new.full?",
    "Dial.new.level",
    "Dial.new.label = 3",
    "",
  ],
  "dial.rb": [
    "class Dial",
    "  attr_reader :level",
    "  def full?",
    "    true",
    "  end",
    "  def label=(value)",
    "    @label = value",
    "  end",
    "  def label",
    "    @label",
    "  end",
    "end",
    "",
  ],
};

export const RUBY_MEMBER_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RUBY_MEMBER_LINES).map(([name, lines]) => [name, lines.join("\n")]),
);

/** A file, a 1-based line, a token on it, and which occurrence of the token (default the first). */
export type RubyMemberSite = readonly [file: string, line: number, token: string, occurrence?: number];

/** 1-based source position of a token; a generated member is declared at its argument (`:level`, `"unit"`). */
export function rubyMemberSite(
  paths: Readonly<Record<string, string>>,
  [file, line, token, occurrence = 0]: RubyMemberSite,
): { file: string; line: number; column: number } {
  const text = RUBY_MEMBER_LINES[file]?.[line - 1];
  const absolute = paths[file];
  if (text === undefined || !absolute) throw new Error(`Missing Ruby fixture site ${file}:${line}`);
  let from = 0;
  for (let seen = 0; seen <= occurrence; seen += 1) {
    const at = text.indexOf(token, from);
    if (at < 0) throw new Error(`Missing Ruby fixture token ${token} at ${file}:${line}`);
    if (seen === occurrence) return { file: absolute, line, column: at + 1 };
    from = at + token.length;
  }
  throw new Error(`Missing Ruby fixture occurrence ${token} at ${file}:${line}`);
}

/** Use site, then the line and name of the declaration it must reach. */
export const RUBY_MEMBER_GOTO: ReadonlyArray<readonly [use: RubyMemberSite, file: string, line: number, name: string]> =
  [
    [["gauge.rb", 26, "full?"], "gauge.rb", 5, "full?"],
    [["gauge.rb", 27, "full"], "gauge.rb", 9, "full"],
    [["gauge.rb", 6, "level"], "gauge.rb", 2, "level"],
    [["gauge.rb", 14, "mode"], "gauge.rb", 3, "mode="],
    [["gauge.rb", 31, "mode"], "gauge.rb", 3, "mode"],
    [["gauge.rb", 29, "label"], "gauge.rb", 17, "label="],
    [["gauge.rb", 30, "label"], "gauge.rb", 21, "label"],
    [["use.rb", 4, "full?"], "gauge.rb", 5, "full?"],
    [["use.rb", 5, "level"], "gauge.rb", 2, "level"],
    [["use.rb", 6, "unit"], "gauge.rb", 2, "unit"],
    [["use.rb", 7, "label"], "gauge.rb", 17, "label="],
    [["use.rb", 8, "full?"], "dial.rb", 3, "full?"],
    [["use.rb", 9, "level"], "dial.rb", 2, "level"],
    [["use.rb", 10, "label"], "dial.rb", 6, "label="],
  ];

/** Declaration, then every site `findReferences` lists for it: the declaration itself and each proven use. */
export const RUBY_MEMBER_REFERENCES: ReadonlyArray<readonly [declaration: RubyMemberSite, sites: RubyMemberSite[]]> = [
  [
    ["gauge.rb", 5, "full?"],
    [
      ["gauge.rb", 5, "full?"],
      ["gauge.rb", 26, "full?"],
      ["use.rb", 4, "full?"],
    ],
  ],
  [
    ["gauge.rb", 9, "full"],
    [
      ["gauge.rb", 9, "full"],
      ["gauge.rb", 27, "full"],
    ],
  ],
  [
    ["gauge.rb", 2, ":level"],
    [
      ["gauge.rb", 2, ":level"],
      ["gauge.rb", 6, "level"],
      ["gauge.rb", 10, "level"],
      ["use.rb", 5, "level"],
    ],
  ],
  [
    ["gauge.rb", 2, '"unit"'],
    [
      ["gauge.rb", 2, '"unit"'],
      ["use.rb", 6, "unit"],
    ],
  ],
  [
    ["gauge.rb", 3, ":mode"],
    [
      ["gauge.rb", 3, ":mode"],
      ["gauge.rb", 14, "mode"],
      ["gauge.rb", 31, "mode"],
    ],
  ],
  [
    ["gauge.rb", 17, "label"],
    [
      ["gauge.rb", 17, "label"],
      ["gauge.rb", 29, "label"],
      ["use.rb", 7, "label"],
    ],
  ],
  [
    ["gauge.rb", 21, "label"],
    [
      ["gauge.rb", 21, "label"],
      ["gauge.rb", 30, "label"],
    ],
  ],
  [
    ["dial.rb", 3, "full?"],
    [
      ["dial.rb", 3, "full?"],
      ["use.rb", 8, "full?"],
    ],
  ],
  [
    ["dial.rb", 2, ":level"],
    [
      ["dial.rb", 2, ":level"],
      ["use.rb", 9, "level"],
    ],
  ],
  [
    ["dial.rb", 6, "label"],
    [
      ["dial.rb", 6, "label"],
      ["use.rb", 10, "label"],
    ],
  ],
  [["dial.rb", 9, "label"], [["dial.rb", 9, "label"]]],
];

/** The methods each caller reaches through a `calls` edge. A bare `full` is an identifier read, so it has no edge. */
export const RUBY_MEMBER_CALLS: Readonly<Record<string, readonly string[]>> = {
  check: ["drain!", "full?", "label", "label=", "mode"],
  "drain!": ["mode="],
};

export async function expectRubyMemberGoto(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
  phase = "index",
): Promise<void> {
  for (const [use, file, line, name] of RUBY_MEMBER_GOTO) {
    const label = `${phase}: ${use.join(" ")}`;
    const result = await goToDefinition(index, rubyMemberSite(paths, use));
    expect(result.status, label).toBe("ok");
    if (result.status !== "ok") continue;
    expect(fileIdentityKey(result.definition.file), label).toBe(fileIdentityKey(paths[file]!));
    expect([result.definition.range.start.line, result.definition.localName], label).toEqual([line, name]);
  }
}

export async function expectRubyMemberReferences(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
  phase = "index",
): Promise<void> {
  const locate = (site: { file: string; line: number; column: number }): string =>
    `${fileIdentityKey(site.file)}:${site.line}:${site.column}`;
  for (const [declaration, sites] of RUBY_MEMBER_REFERENCES) {
    const label = `${phase}: ${declaration.join(" ")}`;
    const result = await findReferences(index, rubyMemberSite(paths, declaration));
    expect(result.status, label).toBe("ok");
    if (result.status !== "ok") continue;
    expect(result.referenceCoverage.state, label).toBe("complete");
    expect(
      result.references.map((reference) => locate({ file: reference.file, ...reference.range.start })).sort(),
      label,
    ).toEqual(sites.map((site) => locate(rubyMemberSite(paths, site))).sort());
  }
}

export async function expectRubyMemberCalls(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
  phase = "index",
): Promise<void> {
  const graph = await buildSymbolGraphDetailed(index);
  for (const [callerName, callees] of Object.entries(RUBY_MEMBER_CALLS)) {
    const caller = [...graph.nodes.values()].find(
      (node) => node.name === callerName && fileIdentityKey(node.file) === fileIdentityKey(paths["gauge.rb"]!),
    );
    expect(caller, `${phase}: ${callerName}`).toBeDefined();
    const reached = graph.edges
      .filter((edge) => edge.from === caller?.id && edge.label === "calls")
      .map((edge) => graph.nodes.get(edge.to))
      .map((node) => `${fileIdentityKey(node?.file ?? "")}:${node?.name}`)
      .sort();
    expect(reached, `${phase}: calls of ${callerName}`).toEqual(
      callees.map((name) => `${fileIdentityKey(paths["gauge.rb"]!)}:${name}`).sort(),
    );
  }
}

/**
 * A caller that never requires the declaring file, as under Rails or Zeitwerk, which load by constant name. Its `?`,
 * `!`, and `=` calls on a `Box` are candidates the index cannot prove, so the references to those names stay partial.
 * The plain `empty` that the caller never writes is excluded by the Bloom filter and stays complete.
 */
export const RUBY_SUFFIX_LINES: Record<string, string[]> = {
  "box.rb": [
    "class Box",
    "  def empty?; true; end",
    "  def empty; false; end",
    "  def clear!; end",
    "  def label=(value); end",
    "end",
    "",
  ],
  "lone.rb": [
    "class Lone",
    "  def check",
    "    b = Box.new",
    "    b.empty?",
    "    b.clear!",
    "    b.label = 1",
    "  end",
    "end",
    "",
  ],
};

export const RUBY_SUFFIX_SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RUBY_SUFFIX_LINES).map(([name, lines]) => [name, lines.join("\n")]),
);

/** Declaration line and token in `box.rb`, then the coverage `findReferences` reports for it. */
const RUBY_SUFFIX_COVERAGE: ReadonlyArray<readonly [line: number, token: string, coverage: "complete" | "partial"]> = [
  [2, "empty?", "partial"],
  [3, "empty", "complete"],
  [4, "clear!", "partial"],
  [5, "label", "partial"],
];

export async function expectRubySuffixCoverage(
  index: ProjectIndex,
  paths: Readonly<Record<string, string>>,
  phase = "index",
): Promise<void> {
  for (const [line, token, coverage] of RUBY_SUFFIX_COVERAGE) {
    const label = `${phase}: ${token}`;
    const text = RUBY_SUFFIX_LINES["box.rb"]![line - 1]!;
    const result = await findReferences(index, { file: paths["box.rb"]!, line, column: text.indexOf(token) + 1 });
    expect(result.status, label).toBe("ok");
    if (result.status !== "ok") continue;
    // The unproven receiver calls in lone.rb are not listed; the coverage says that they were not checked.
    expect(
      result.references.map((reference) => `${fileIdentityKey(reference.file)}:${reference.range.start.line}`),
      label,
    ).toEqual([`${fileIdentityKey(paths["box.rb"]!)}:${line}`]);
    expect(result.referenceCoverage.state, label).toBe(coverage);
  }
}
