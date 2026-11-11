export const SYNTAX_FORMS = [
  "bare-call",
  "member-call",
  "member-access",
  "type-reference",
  "constructor",
  "import",
  "other-identifier",
];

const LANGUAGES = new Set(["typescript", "csharp"]);
const CALL_FORMS = new Set(["bare-call", "member-call", "constructor"]);

/** @typedef {{ file: string, line: number, column: number }} Location */
/** @typedef {Location & { name: string, form: string, definitions: Location[], external: boolean }} Site */
/** @typedef {Location & { name: string, kind: string, references: Location[], relatedDeclarations?: Location[] }} Declaration */
/** @typedef {{ status: string, definition?: Location, reason?: string }} DefinitionAnswer */
/** @typedef {{ status: string, references?: Location[], coverage?: string }} ReferenceAnswer */
/** @typedef {{ from: string, to: Location, label: string, site: Location }} CallEdge */

export function validateManifest(manifest) {
  if (!Array.isArray(manifest) || !manifest.length) throw new Error("Corpus manifest must be a nonempty array.");
  const ids = new Set();
  for (const entry of manifest) {
    if (!entry || typeof entry !== "object") throw new Error("Each corpus entry must be an object.");
    if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
      throw new Error("Corpus id must contain lowercase letters, digits, and hyphens.");
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate corpus id: ${entry.id}`);
    ids.add(entry.id);
    if (!LANGUAGES.has(entry.language)) throw new Error(`Unknown corpus language for ${entry.id}: ${entry.language}`);
    if (typeof entry.commit !== "string" || !/^[a-f0-9]{40}$/.test(entry.commit)) {
      throw new Error(`Corpus ${entry.id} requires a full 40-character commit SHA.`);
    }
    if (typeof entry.url !== "string" || !/^https:\/\/[^\s]+$/.test(entry.url)) {
      throw new Error(`Corpus ${entry.id} requires an HTTPS repository URL.`);
    }
    for (const key of ["include", "exclude"]) {
      const globs = entry[key];
      if (globs === undefined) continue;
      if (!Array.isArray(globs) || globs.some((glob) => typeof glob !== "string" || !glob.trim())) {
        throw new Error(`Corpus ${entry.id} ${key} must be an array of nonempty globs.`);
      }
    }
  }
  return manifest;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    let t = (a = (a + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {Location} left @param {Location} right */
export function compareLocations(left, right) {
  if (left.file < right.file) return -1;
  if (left.file > right.file) return 1;
  return left.line - right.line || left.column - right.column;
}

/** @template {Location} T @param {T[]} candidates @returns {T[]} */
export function sampleCandidates(candidates, seed, maximum) {
  const sorted = [...candidates].sort(compareLocations);
  const random = mulberry32(seed);
  for (let index = sorted.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [sorted[index], sorted[other]] = [sorted[other], sorted[index]];
  }
  return sorted.slice(0, maximum);
}

/** Definition matching intentionally uses file+line, not column (the public benchmark contract). */
export function matchesDefinition(actual, expected) {
  return actual.file === expected.file && actual.line === expected.line;
}

/** @param {Site} site @param {DefinitionAnswer} answer */
export function scoreDefinition(site, answer) {
  if (!site.external && !site.definitions.length) return "excluded";
  if (answer.status !== "ok" || !answer.definition) return site.external ? "external-ok" : "missed";
  if (site.external) return "wrong";
  return site.definitions.some((expected) => matchesDefinition(answer.definition, expected)) ? "correct" : "wrong";
}

/** @param {Location} location */
export function locationKey(location) {
  return `${location.file}:${location.line}:${location.column}`;
}

/** @param {Declaration} declaration @param {ReferenceAnswer} answer */
export function scoreReferences(declaration, answer) {
  const declarationKeys = new Set([
    locationKey(declaration),
    ...(declaration.relatedDeclarations ?? []).map(locationKey),
  ]);
  const expected = new Set(declaration.references.map(locationKey).filter((key) => !declarationKeys.has(key)));
  const reported = new Set((answer.references ?? []).map(locationKey).filter((key) => !declarationKeys.has(key)));
  let truePositives = 0;
  for (const key of reported) if (expected.has(key)) truePositives += 1;
  const falsePositives = reported.size - truePositives;
  const falseNegatives = expected.size - truePositives;
  const precision = reported.size ? truePositives / reported.size : 1;
  const recall = expected.size ? truePositives / expected.size : 1;
  return {
    truePositives,
    falsePositives,
    falseNegatives,
    expected: expected.size,
    reported: reported.size,
    precision,
    recall,
    overclaim: answer.coverage === "complete" && recall < 1,
    status: answer.status,
    coverage: answer.coverage ?? "unavailable",
  };
}

/** Edges supplied here are already restricted to the sampled identifier's source span. */
/** @param {Site} site @param {CallEdge[]} edges @param {string | null} caller */
export function scoreEdges(site, edges, caller) {
  if (!CALL_FORMS.has(site.form)) return "excluded-form";
  if (!site.external && !site.definitions.length) return "excluded-unresolved";
  if (!caller) return "excluded-enclosing";
  const candidates = edges.filter((edge) => edge.label === "calls" || edge.label === "instantiates");
  if (site.external) return candidates.length ? "edge-wrong" : "edge-external-ok";
  if (!candidates.length) return "edge-missed";
  const correct = candidates.every(
    (edge) => edge.from === caller && site.definitions.some((expected) => matchesDefinition(edge.to, expected)),
  );
  return correct ? "edge-correct" : "edge-wrong";
}

function emptyCounts() {
  return {
    sites: 0,
    correct: 0,
    wrong: 0,
    missed: 0,
    externalOk: 0,
    excluded: 0,
    edgeCorrect: 0,
    edgeWrong: 0,
    edgeMissed: 0,
    edgeExternalOk: 0,
    edgeExcluded: 0,
    declarations: 0,
    referenceTruePositives: 0,
    referenceFalsePositives: 0,
    referenceFalseNegatives: 0,
    overclaims: 0,
  };
}

function addSite(counts, result) {
  counts.sites += 1;
  const definitionKey = result.definition === "external-ok" ? "externalOk" : result.definition;
  counts[definitionKey] += 1;
  const edgeKeys = {
    "edge-correct": "edgeCorrect",
    "edge-wrong": "edgeWrong",
    "edge-missed": "edgeMissed",
    "edge-external-ok": "edgeExternalOk",
  };
  const edgeKey = edgeKeys[result.edge] ?? "edgeExcluded";
  counts[edgeKey] += 1;
}

function addDeclaration(counts, result) {
  counts.declarations += 1;
  counts.referenceTruePositives += result.score.truePositives;
  counts.referenceFalsePositives += result.score.falsePositives;
  counts.referenceFalseNegatives += result.score.falseNegatives;
  if (result.score.overclaim) counts.overclaims += 1;
}

function withRates(counts) {
  const scored = counts.correct + counts.wrong + counts.missed + counts.externalOk;
  const edgesScored = counts.edgeCorrect + counts.edgeWrong + counts.edgeMissed + counts.edgeExternalOk;
  const referencesReported = counts.referenceTruePositives + counts.referenceFalsePositives;
  const referencesExpected = counts.referenceTruePositives + counts.referenceFalseNegatives;
  return {
    ...counts,
    scored,
    edgesScored,
    correctRate: scored ? (counts.correct + counts.externalOk) / scored : null,
    wrongRate: scored ? counts.wrong / scored : null,
    missedRate: scored ? counts.missed / scored : null,
    edgeCorrectRate: edgesScored ? (counts.edgeCorrect + counts.edgeExternalOk) / edgesScored : null,
    edgeWrongRate: edgesScored ? counts.edgeWrong / edgesScored : null,
    edgeMissedRate: edgesScored ? counts.edgeMissed / edgesScored : null,
    referencePrecision: referencesReported ? counts.referenceTruePositives / referencesReported : 1,
    referenceRecall: referencesExpected ? counts.referenceTruePositives / referencesExpected : 1,
  };
}

export function summarizeResults(sites, declarations) {
  const totals = emptyCounts();
  const byForm = Object.fromEntries(SYNTAX_FORMS.map((form) => [form, emptyCounts()]));
  const byKind = {};
  for (const result of sites) {
    addSite(totals, result);
    addSite(byForm[result.site.form], result);
  }
  for (const result of declarations) {
    addDeclaration(totals, result);
    byKind[result.declaration.kind] ??= emptyCounts();
    addDeclaration(byKind[result.declaration.kind], result);
  }
  return {
    totals: withRates(totals),
    byForm: Object.fromEntries(Object.entries(byForm).map(([key, counts]) => [key, withRates(counts)])),
    byKind: Object.fromEntries(Object.entries(byKind).map(([key, counts]) => [key, withRates(counts)])),
  };
}

export function aggregateReports(reports) {
  const combined = summarizeResults(
    reports.flatMap((report) => report.sites),
    reports.flatMap((report) => report.declarations),
  );
  /** @type {Record<string, ReturnType<typeof summarizeResults>>} */
  const byLanguage = {};
  for (const language of [...LANGUAGES].sort()) {
    const subset = reports.filter((report) => report.repository.language === language);
    if (!subset.length) continue;
    byLanguage[language] = summarizeResults(
      subset.flatMap((report) => report.sites),
      subset.flatMap((report) => report.declarations),
    );
  }
  return { ...combined, byLanguage };
}

function percent(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function table(rows, includeReferences = true) {
  return [
    "| Scope | Scored | Correct | Wrong | Missed | External OK | Excluded | Correct rate | Wrong rate | Miss rate | Refs P / R | Overclaims | Edges C / W / M / external | Edge correct / wrong / miss |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |",
    ...rows.map(([label, counts]) => {
      const references = includeReferences
        ? `${percent(counts.referencePrecision)} / ${percent(counts.referenceRecall)}`
        : "n/a";
      const overclaims = includeReferences ? counts.overclaims : "n/a";
      return `| ${label} | ${counts.scored} | ${counts.correct} | ${counts.wrong} | ${counts.missed} | ${counts.externalOk} | ${counts.excluded} | ${percent(counts.correctRate)} | ${percent(counts.wrongRate)} | ${percent(counts.missedRate)} | ${references} | ${overclaims} | ${counts.edgeCorrect} / ${counts.edgeWrong} / ${counts.edgeMissed} / ${counts.edgeExternalOk} | ${percent(counts.edgeCorrectRate)} / ${percent(counts.edgeWrongRate)} / ${percent(counts.edgeMissedRate)} |`;
    }),
  ].join("\n");
}

function displayLocation(location) {
  return `${location.file}:${location.line}:${location.column}`;
}

export function firstWrongAnswers(report) {
  const wrong = report.sites.filter((result) => result.definition === "wrong" || result.edge === "edge-wrong");
  return [...wrong].sort((left, right) => compareLocations(left.site, right.site)).slice(0, 20);
}

export function renderReport(reports) {
  const aggregate = aggregateReports(reports);
  const lines = [
    "# Real-code accuracy benchmark",
    "",
    "Deterministically sampled compiler/language-service answers, not hand-labeled Codegraph fixtures.",
    "Wrong answers are distinct from misses. Unresolved oracle sites are excluded; external answers require no project target.",
    "Reference precision/recall are micro-averaged by exact UTF-16 token position. Definition/edge targets match by file+line.",
    "",
    "## Summary",
    "",
    table([
      ["all", aggregate.totals],
      ...Object.entries(aggregate.byLanguage).map(([language, summary]) => [language, summary.totals]),
      ...reports.map((report) => [report.repository.id, report.summary.totals]),
    ]),
    "",
    "## Syntax forms (all repositories)",
    "",
    table(Object.entries(aggregate.byForm), false),
    "",
  ];
  for (const [language, summary] of Object.entries(aggregate.byLanguage)) {
    lines.push(`## ${language} syntax forms`, "", table(Object.entries(summary.byForm), false), "");
  }
  for (const report of reports) {
    const diagnostics = report.oracle.diagnostics;
    lines.push(
      `## ${report.repository.id}`,
      "",
      `- Source: ${report.repository.url} at \`${report.repository.commit}\`.`,
      `- Oracle: ${report.oracle.oracle.name} ${report.oracle.oracle.version}; ${diagnostics.files} files; ${diagnostics.unresolvedSites} sampled unresolved sites.`,
      `- Seed: ${report.request.seed}; limits: ${report.request.maxSites} sites / ${report.request.maxDeclarations} declarations.`,
      `- Runtime: ${(report.runtimeMs / 1000).toFixed(2)}s (${Object.entries(report.timings)
        .map(([name, ms]) => `${name} ${(ms / 1000).toFixed(2)}s`)
        .join(", ")}).`,
      `- Oracle diagnostics: ${diagnostics.errors.length}; edge exclusions: ${report.summary.totals.edgeExcluded}.`,
      "",
      table(Object.entries(report.summary.byForm), false),
      "",
      "### First 20 wrong answers (source order)",
      "",
    );
    const wrong = firstWrongAnswers(report);
    if (!wrong.length) lines.push("None in this sample.");
    for (const result of wrong) {
      const actual = result.answer.definition ? displayLocation(result.answer.definition) : result.answer.status;
      const expected = result.site.external ? "external" : result.site.definitions.map(displayLocation).join(", ");
      lines.push(
        `- \`${displayLocation(result.site)}\` \`${result.site.name}\` (${result.site.form}; ${result.definition}; ${result.edge}): got \`${actual}\`; oracle \`${expected}\`.`,
      );
    }
    lines.push("");
  }
  lines.push(
    "## Limits",
    "",
    "No package restore, code generation, build-system membership, or compiler-error repair is performed. Missing dependencies and incompatible repository configurations can make oracle answers unresolved; inspect diagnostics in each JSON report.",
    "Sampling is bounded, not exhaustive. Standard-library/package targets outside the requested files are external. Calls outside a named indexed enclosing function are excluded from edge scoring, not counted as correct.",
    "The per-repository JSON includes every sampled site, reference set, edge answer, oracle diagnostics, timings, and per-form counts/rates for triage.",
    "",
  );
  return lines.join("\n");
}
