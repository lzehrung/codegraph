export const meta = {
  name: "codegraph-pre-merge",
  description: "Read-only differential review of Codegraph answers, coverage, cache behavior, and performance.",
  whenToUse:
    "Run in a prepared worktree with built head and base checkouts. Pass base and an absolute baseline path; use mode refactor to require identical answers.",
  phases: [
    {
      title: "Prepare",
      detail: "Validate built checkouts and external scratch paths without changing either checkout.",
    },
    { title: "Review", detail: "Compare regression, test-gap, cache, and performance evidence in parallel." },
    { title: "Verify", detail: "Independently rerun every P0/P1 candidate against base and head." },
  ],
};

// args: { base, head?, baseline, goals?, corpora?, mode?, scratch?,
//         models?: { review }, adapters?: { review } }
const TEXT = { type: "string" };
const COUNT = { type: "integer" };
const TEXTS = { type: "array", items: TEXT };
const LANES = ["regression", "test-gaps", "cache", "performance"];
const CLASSES = ["fix", "regression", "conservative-loss", "unclear"];
const FINDING = {
  type: "object",
  additionalProperties: false,
  properties: {
    lane: { type: "string", enum: LANES },
    severity: { type: "string", enum: ["P0", "P1", "P2"] },
    title: TEXT,
    location: TEXT,
    evidence: TEXT,
    suggestedFix: TEXT,
  },
  required: ["lane", "severity", "title", "location", "evidence", "suggestedFix"],
};
const FINDINGS = { type: "array", items: FINDING };
const EDGE_CHANGES = {
  type: "object",
  additionalProperties: false,
  properties: {
    added: COUNT,
    removed: COUNT,
    byClass: {
      type: "object",
      additionalProperties: false,
      properties: { fix: COUNT, regression: COUNT, "conservative-loss": COUNT, unclear: COUNT },
      required: CLASSES,
    },
  },
  required: ["added", "removed", "byClass"],
};
const TIMING = {
  type: "object",
  additionalProperties: false,
  properties: {
    operation: { type: "string", enum: ["cold-build", "no-change-update", "one-file-update", "graph-build"] },
    corpus: TEXT,
    corpusFiles: COUNT,
    baseMs: { type: "number" },
    headMs: { type: "number" },
    slowerPercent: { type: "number" },
    baseRoundsMs: { type: "array", items: { type: "number" }, minItems: 3 },
    headRoundsMs: { type: "array", items: { type: "number" }, minItems: 3 },
    evidence: TEXT,
  },
  required: [
    "operation",
    "corpus",
    "corpusFiles",
    "baseMs",
    "headMs",
    "slowerPercent",
    "baseRoundsMs",
    "headRoundsMs",
    "evidence",
  ],
};
const PREPARE = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: TEXT,
    baseline: TEXT,
    scratch: TEXT,
    corpora: TEXTS,
    baseCommit: TEXT,
    headCommit: TEXT,
    changedFiles: TEXTS,
    performanceCorpus: TEXT,
    performanceCorpusFiles: COUNT,
    evidence: TEXT,
    blocker: TEXT,
  },
  required: [
    "source",
    "baseline",
    "scratch",
    "corpora",
    "baseCommit",
    "headCommit",
    "changedFiles",
    "performanceCorpus",
    "performanceCorpusFiles",
    "evidence",
    "blocker",
  ],
};
const VERDICTS = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: TEXT,
          confirmed: { type: "boolean" },
          preexisting: { type: "boolean" },
          evidence: TEXT,
        },
        required: ["id", "confirmed", "preexisting", "evidence"],
      },
    },
  },
  required: ["verdicts"],
};

function requiredText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function absolutePath(value, name) {
  const path = requiredText(value, name);
  if (!/^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path)) throw new Error(`${name} must be an absolute path`);
  return path;
}
function agentOptions(schema, label) {
  const options = { schema, label, phase: label };
  if (input.models?.review !== undefined) options.model = requiredText(input.models.review, "models.review");
  if (input.adapters?.review !== undefined) options.adapter = requiredText(input.adapters.review, "adapters.review");
  return options;
}
function laneSchema(lane) {
  const properties = {
    lane: { type: "string", enum: [lane] },
    status: { type: "string", enum: ["complete", "skipped", "incomplete"] },
    reason: TEXT,
    // A finding that names another lane fails schema validation, so the agent is asked to correct it instead of the
    // run failing after every lane has finished.
    findings: {
      type: "array",
      items: { ...FINDING, properties: { ...FINDING.properties, lane: { type: "string", enum: [lane] } } },
    },
    evidence: TEXT,
    artifacts: TEXTS,
  };
  if (lane === "regression") properties.edgeChanges = EDGE_CHANGES;
  if (lane === "performance") {
    const timing = {
      ...TIMING,
      properties: {
        ...TIMING.properties,
        corpus: { type: "string", enum: [context.performanceCorpus] },
        corpusFiles: { type: "integer", enum: [context.performanceCorpusFiles] },
      },
    };
    properties.timings = { type: "array", items: timing };
  }
  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
}
function safety() {
  return `Read AGENTS.md first and review against it, particularly Semantic Accuracy Bar and Path, Cache, and Review Safety.
Work in place, read-only: no source edits, builds, dependency installs, git writes, or remote actions. Never create junctions or symlinks. Never change the baseline or extra projects.
Use absolute paths in commands and probes. All scripts, logs, copies, generated indexes, disk caches, and temporary files go ONLY below the supplied scratch directory, in your own lane subdirectory. Never put scratch inside an indexed root. Mutable cache/performance experiments index a separate scratch project copy, with scripts and caches outside that copy. Set cache paths explicitly; do not populate checkout-local caches.
Read actual compiled API signatures and existing consumer tests before constructing probes. Load the source checkout's dist for head and baseline/dist for base. Native is required. No mocked results, guessed APIs, builds, or source-loader substitutes. CLI commands are run by you, not by the workflow.
Language reference-implementation cross-checks are supplemental here, not prerequisites: use a compiler/interpreter only if already available, never install one. If unavailable, record that limitation and use repository evidence and authoritative language documentation to assess semantics; retain uncertain material changes as unclear candidates. Its absence alone does not make a lane incomplete. The mandatory executable comparisons are the built Codegraph dist APIs with the native runtime.
Scope findings to git diff ${JSON.stringify(`${base}...${head}`)} and its affected consumers. Inspect the complete diff and relevant unchanged shared consumers. Do not fix anything. Existing wrong answers and rare conservative limits are follow-up material, not new mechanisms for this change.
Severity: P0 = wrong answer, regression, or data loss; P1 = material risk or missing coverage; P2 = minor. Every finding needs your lane, severity, a short title, a real repository-relative file:line location, concrete probe output in evidence, and a bounded suggestedFix. Verify your own candidates against counterexamples before returning them. Missing required Codegraph prerequisites or unexecuted required comparisons are not a valid empty result; report incomplete rather than a clean review.`;
}
function reviewPrompt(lane, focus) {
  return `${safety()}
Lane: ${lane}. Use scratch/${lane}/ for your own artifacts.
Prepared context: ${JSON.stringify(context)}
Mode: ${mode}. Goals: ${JSON.stringify(goals)}
${focus}
Return only the requested schema. status skipped needs a specific applicability reason; status complete needs observed evidence and artifact paths. Put every full comparison and command output in scratch artifacts, not committed files. Include concise evidence in the result.`;
}

const input = typeof args === "string" ? JSON.parse(args) : args;
if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an args object");
const base = requiredText(input.base, "base");
const head = requiredText(input.head ?? "HEAD", "head");
const baseline = absolutePath(input.baseline, "baseline");
const mode = input.mode ?? "change";
if (!["change", "refactor"].includes(mode)) throw new Error("mode must be change or refactor");
const goals = input.goals ?? "";
if (typeof goals !== "string") throw new Error("goals must be text");
const corpora = input.corpora ?? [];
if (!Array.isArray(corpora)) throw new Error("corpora must be an array");
corpora.forEach((path) => absolutePath(path, "corpora entry"));
if (input.scratch !== undefined) absolutePath(input.scratch, "scratch");

phase("Prepare");
const context = await agent(
  `${safety()}
Prepare this differential review, without performing the review yet. Inputs: ${JSON.stringify({ base, head, baseline, corpora, scratch: input.scratch })}
Resolve the current source cwd and all paths absolutely. Verify the source HEAD equals the requested head, baseline HEAD equals base resolved in the source, both dist builds exist, and both native runtimes load. Record the exact commits and git diff --name-only base...head. Do not rebuild either checkout. Refuse runtime-source edits that make the checked-out code disagree with the requested commits.
Enumerate eligible indexed-file counts for every supplied corpus and every immediate project under tests/samples/* and tests/edge-corpus/* in both fixture revisions, using consistent discovery options. Save that inventory under scratch. Select the largest available project by eligible indexed-file count, independent of which language the diff affects; do not substitute a smaller language-specific project. Return its original absolute root as performanceCorpus and the measured count as performanceCorpusFiles. The performance lane must benchmark this exact corpus and may add supplemental affected-language measurements only in its evidence.
If scratch is omitted, create a unique run directory below a codegraph-odw folder in the OS temporary directory. Otherwise create a unique run directory below the supplied scratch parent. Resolve physical paths and reject scratch within source, baseline, or any corpus root, including aliases; also reject an ancestor that would cause scratch artifacts to be indexed by those roots. These checks must precede writing artifacts. Return the unique scratch directory, normalized corpus paths, and observed validation evidence. Set blocker to an empty string when every check passed. If any prerequisite fails, stop there: set blocker to the failed check with the expected and observed values (for example, baseline HEAD versus base), and return empty strings, empty arrays, or 0 for anything not established. Never invent a prepared context.`,
  agentOptions(PREPARE, "Prepare"),
);
if (context.blocker.trim()) throw new Error(`Review preparation stopped: ${context.blocker}\n${context.evidence}`);
absolutePath(context.source, "prepared source");
absolutePath(context.baseline, "prepared baseline");
absolutePath(context.scratch, "prepared scratch");
absolutePath(context.performanceCorpus, "prepared performance corpus");
if (context.performanceCorpusFiles <= 0) throw new Error("Prepared performance corpus must contain eligible files");

const regressionFocus = `Always run this lane, including when the diff is empty. Perform differential comparisons using buildSymbolGraphDetailed, goto, and findReferences (exact normalized sites AND referenceCoverage.state).
Cover every project under tests/samples/* and tests/edge-corpus/* and every supplied corpus. Compare both compiled versions on IDENTICAL input bytes: use the union of head/base fixture roots, distinguish fixture-content changes from algorithm changes, and label which fixture revision is used. Enumerate declarations and navigation/reference sites from the actual indexes and existing fixture markers; do not sample or cap the required comparisons. Normalize only checkout prefixes and unstable identities, never semantic positions, coverage, targets, or edges. Account explicitly for added/deleted fixture files.
Compare explicit unsupported outcomes as outcomes too: some indexed definitions (for example JSON exports) have no native navigation parser. Capture each API's returned unsupported state or typed UnsupportedParserInputError with its code/message in the ledger, distinct from an empty answer. Matching, evidenced unsupported outcomes in BOTH versions are baseline limitations, not an incomplete comparison. A supported-to-unsupported change is a finding. Capture reproducible API error outcomes distinctly too; a newly failing answer is a candidate, not an empty answer. Required process/tool failures that prevent comparing outcomes, unreadable required inputs, or unexecuted required comparisons still make the lane incomplete; never swallow them or fabricate results. Unavailable optional interpreters do not prevent these native comparisons.
Classify EVERY added/removed detailed-graph edge and EVERY changed goto/reference/coverage answer as fix | regression | conservative-loss | unclear, with file:line, base output, head output, and rationale, in a complete scratch JSON ledger. edgeChanges contains counts for edges only; byClass must sum to added + removed. Answer differences belong in the ledger too. Every regression or unclear material difference is a candidate, not just the intended fixes.
Inspect other languages using shared modules touched by the diff: name-resolution, name-lookup-policies, member-selection, callable-identity, navigation-goto/references, edge-passes, receiver-calls. Probe their affected call forms and same-named decoys. In refactor mode ANY output difference is a finding, even an apparent improvement or conservative loss. Report every corpus checked and the number of edges and answers compared. A required comparison that could not be completed makes this lane incomplete.`;
const gapFocus = `From goals AND the diff, identify affected behavior not pinned by real consumer tests: inclusion AND exclusion, goto, findReferences sites and referenceCoverage.state, buildSymbolGraphDetailed, and rename-preview where relevant. Check same-named decoys, cold versus reopened disk cache, and the relevant tests/call-form-matrix cell and generated report.
Read the existing tests and demonstrate each material missing guarantee with source and probe evidence; do not claim missing coverage merely from test names. Missing ordinary-code guarantees can be P1; out-of-scope rare conservative limits belong in follow-up findings. Skip ONLY when goals and the diff provide no behavior to check, stating why.`;
const cacheFocus = `Run if the diff touches indexed/derived data, caching, incremental updates, or snapshots; otherwise return skipped with the inspected paths and reason.
On separate real scratch project copies, for each compiled version, compare warm memory and reopened disk-cache answers with a fresh cold index after an edit, delete, rename-back sequence, and restoration of affected files. Include both the intermediate rename and the rename back. Check goto, references with referenceCoverage.state, and detailed-graph edges after EACH operation; compare canonical answers, not just file counts. Never mutate source, baseline, or supplied corpora, and keep scripts/caches outside the indexed copies. Record the operations and observed equalities.
Inspect CORE_ALGORITHM_EPOCH and LANGUAGE_BEHAVIOR_EPOCH in base and head. Require the appropriate epoch change when persisted facts or language hooks changed, following AGENTS.md, and explain when no bump is needed. A reserved epoch is not evidence unless the actual relevant constant changed. Report stale persisted-data or incremental discrepancies with exact outputs.`;
const performanceFocus = `Run if the diff touches indexing, incremental updates, or graph-build hot paths; otherwise return skipped with inspected paths and reason and timings: [].
Measure the exact largest corpus selected in preparation: ${JSON.stringify(context.performanceCorpus)} (${context.performanceCorpusFiles} eligible files). Do not replace it with a smaller affected-language corpus. Each timing must use that exact original absolute corpus string and file count, even when indexing a scratch copy. Supplemental affected-language measurements can go in evidence, not replace these four timings. Use paired interleaved base/head medians for cold build, no-change update, one-file update, and buildSymbolGraphDetailed graph build: at least FIVE alternating rounds per operation (base/head, head/base, ...), separate processes for every measured version/round, identical Node flags, native runtime, options, input bytes, and cache state. Prepare indexes outside timed no-change/one-file operations and change only a scratch copy. Include raw round times, medians in milliseconds, slowerPercent = (headMs/baseMs - 1)*100, commands, and environment in scratch evidence.
This lane runs alone after the other lanes finish; do not start other heavy work while measuring. A head median slower than base by more than the larger of 2% and the base rounds' relative spread ((max-min)/median), with head slower in most paired rounds, is a P0 performance regression: performance must not regress. Report a smaller but consistent slowdown as P1. Compare incremental work counters or paired smaller/larger subsets to detect work growing with project size instead of changed files; report observed evidence, not speculation. Return four timings, one per operation. Do not replace measurements with estimates.`;

phase("Review");
const focuses = [regressionFocus, gapFocus, cacheFocus, performanceFocus];
// Timing runs alone after the other lanes so their CPU and disk load cannot skew it.
const correctnessLanes = await parallel(
  LANES.slice(0, 3).map(
    (lane, index) => () => agent(reviewPrompt(lane, focuses[index]), agentOptions(laneSchema(lane), lane)),
  ),
);
phase("Performance");
let performanceLane = null;
try {
  performanceLane = await agent(reviewPrompt(LANES[3], focuses[3]), agentOptions(laneSchema(LANES[3]), LANES[3]));
} catch {
  performanceLane = null;
}
const lanes = [...correctnessLanes, performanceLane];
for (let index = 0; index < lanes.length; index++) {
  const result = lanes[index];
  if (!result || result.status === "incomplete")
    throw new Error(`Review incomplete: ${LANES[index]}: ${result?.reason ?? "agent failed"}`);
  if (result.lane !== LANES[index]) throw new Error("Review returned a mismatched lane");
  if (result.status === "skipped" && !result.reason.trim()) throw new Error("Skipped lane needs a reason");
  if (result.status === "skipped" && result.findings.length) throw new Error("Skipped lane cannot contain findings");
  if (result.findings.some((finding) => finding.lane !== result.lane))
    throw new Error("Finding returned by the wrong lane");
}
const regression = lanes[0];
if (regression.status !== "complete") throw new Error("Regression comparisons cannot be skipped");
const edgeChanges = regression.edgeChanges;
const edgeCount = edgeChanges.added + edgeChanges.removed;
if (Object.values(edgeChanges.byClass).some((count) => count < 0))
  throw new Error("Negative edge classification count");
if (edgeChanges.added < 0 || edgeChanges.removed < 0) throw new Error("Negative edge change count");
if (Object.values(edgeChanges.byClass).reduce((sum, count) => sum + count, 0) !== edgeCount)
  throw new Error("Not every edge change was classified");
const timings = lanes[3].timings;
if (lanes[3].status === "complete") {
  const operations = new Set(timings.map((timing) => timing.operation));
  if (timings.length !== 4 || operations.size !== 4)
    throw new Error("Performance lane must measure all four operations");
  for (const timing of timings) {
    if (timing.baseMs <= 0 || timing.headMs <= 0) throw new Error("Performance medians must be positive");
  }
}

const candidates = lanes.flatMap((lane) => lane.findings);
const important = candidates
  .filter((finding) => finding.severity !== "P2")
  .map((finding, index) => ({ id: `candidate-${index + 1}`, ...finding }));
let verified = [];
let dropped = 0;
if (important.length) {
  phase("Verify");
  const result = await agent(
    `${safety()}
You are the independent verification agent, not a finder or fixer. Context: ${JSON.stringify(context)}. Mode: ${mode}. Goals: ${JSON.stringify(goals)}.
Rerun EVERY supplied P0/P1 candidate on baseline/dist AND source/dist, using identical input bytes and your own scratch/verify/ probes. Read each lane's artifacts, but do not trust its conclusions. For test gaps, verify the missing assertion in both revisions and rerun the underlying consumer probe; for epochs, inspect both constants and persisted facts; for performance, repeat paired measurements. Include exact base/head outputs and commands in each verdict's evidence.
Set confirmed only when current evidence establishes the stated problem. Set preexisting when baseline demonstrates the SAME defect/answer or missing guarantee; an intended head improvement is not a preexisting refactor violation. A baseline intended to reproduce the original task defect does not make a newly introduced regression preexisting. In refactor mode any confirmed base/head output difference is an introduced preservation failure. Missing prerequisites are incomplete verification, not evidence of absence: stop with an error if a required check cannot run.
Return exactly one verdict for every candidate id, no omissions or extra ids. Unconfirmed candidates will be dropped and counted only. Candidates: ${JSON.stringify(important)}`,
    agentOptions(VERDICTS, "Verify"),
  );
  const verdicts = new Map();
  const ids = new Set(important.map((finding) => finding.id));
  for (const verdict of result.verdicts) {
    if (!ids.has(verdict.id) || verdicts.has(verdict.id) || !verdict.evidence.trim())
      throw new Error("Invalid or duplicate verification verdict");
    verdicts.set(verdict.id, verdict);
  }
  if (verdicts.size !== important.length) throw new Error("Review incomplete: missing verification verdicts");
  for (const finding of important) {
    const verdict = verdicts.get(finding.id);
    if (!verdict.confirmed) {
      dropped++;
      continue;
    }
    const { id, ...detail } = finding;
    verified.push({
      ...detail,
      confirmed: verdict.confirmed,
      preexisting: verdict.preexisting,
      evidence: `${detail.evidence}\nVerification: ${verdict.evidence}`,
    });
  }
}
const blockers = verified.filter((finding) => !finding.preexisting);
const preexisting = verified.filter((finding) => finding.preexisting);
const minor = candidates.filter((finding) => finding.severity === "P2");
const skippedLanes = lanes
  .filter((lane) => lane.status === "skipped")
  .map((lane) => ({ lane: lane.lane, reason: lane.reason }));
const report = [
  "# Codegraph pre-merge review",
  `- Range: ${base}...${head}; mode: ${mode}.`,
  `- Confirmed blockers: ${blockers.length}; preexisting follow-ups: ${preexisting.length}; minor: ${minor.length}; unconfirmed dropped: ${dropped}.`,
  `- Edges: +${edgeChanges.added} / -${edgeChanges.removed}; classes: ${JSON.stringify(edgeChanges.byClass)}.`,
  ...lanes.map((lane) => `- ${lane.lane}: ${lane.status}. ${lane.reason} ${lane.evidence}`),
  ...timings.map(
    (timing) =>
      `- ${timing.operation}: base ${timing.baseMs} ms, head ${timing.headMs} ms (${timing.slowerPercent.toFixed(1)}% slower); ${timing.corpusFiles} files.`,
  ),
  ...blockers.map(
    (finding) =>
      `- BLOCKER ${finding.severity} ${finding.location}: ${finding.title}. ${finding.evidence} Fix: ${finding.suggestedFix}`,
  ),
  ...preexisting.map(
    (finding) => `- FOLLOW-UP ${finding.severity} ${finding.location}: ${finding.title}. ${finding.evidence}`,
  ),
  ...minor.map((finding) => `- MINOR ${finding.location}: ${finding.title}. ${finding.evidence}`),
  `- Evidence artifacts: ${lanes.flatMap((lane) => lane.artifacts).join(", ")}`,
].join("\n");
log(
  `Review complete: ${blockers.length} blockers, ${preexisting.length} preexisting, ${minor.length} minor; ${dropped} dropped`,
);
return { blockers, preexisting, minor, edgeChanges, timings, skippedLanes, report };
