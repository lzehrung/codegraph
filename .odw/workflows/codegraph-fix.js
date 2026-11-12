export const meta = {
  name: "codegraph-fix",
  description:
    "Reproduce, implement, and differentially review a Codegraph fix or behavior-preserving refactor in place.",
  whenToUse:
    "Run in a prepared worktree with a built baseline. Pass task and baseline; optionally reserve epochs, select implement/review models, and request the final full gate. The host owns publishing.",
  phases: [
    {
      title: "Reproduce",
      detail: "Probe the built baseline and triage every task item against the Semantic Accuracy Bar.",
    },
    { title: "Implement", detail: "Implement and verify in place, then create exactly one local commit." },
    { title: "Review and correct", detail: "Run codegraph-pre-merge and amend only confirmed introduced blockers." },
    {
      title: "Full gate",
      detail: "Optionally run npm run check and distinguish isolated load flakes from real failures.",
    },
  ],
};

// args: { task, baseline, mode?, base?, oracle?, epochs?: { core?, language? },
//         maxRounds?, fullGate?, corpora?, scratch?,
//         models?: { implement?, review? }, adapters?: { implement?, review? } }
const TEXT = { type: "string" };
const TEXTS = { type: "array", items: TEXT };
const COMMAND = {
  type: "object",
  additionalProperties: false,
  properties: { command: TEXT, result: TEXT },
  required: ["command", "result"],
};
const COMMANDS = { type: "array", items: COMMAND };
const ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: TEXT,
    task: TEXT,
    triage: { type: "string", enum: ["fix", "conservative", "document-limit"] },
    reproduced: { type: "boolean" },
    baselineEvidence: TEXT,
    expected: TEXT,
    oracleEvidence: TEXT,
    probes: TEXTS,
  },
  required: ["id", "task", "triage", "reproduced", "baselineEvidence", "expected", "oracleEvidence", "probes"],
};
const REPRODUCTION = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: TEXT,
    baseline: TEXT,
    scratch: TEXT,
    corpora: TEXTS,
    baseCommit: TEXT,
    initialHead: TEXT,
    branch: TEXT,
    items: { type: "array", items: ITEM, minItems: 1 },
    preservedBehavior: TEXTS,
    commands: COMMANDS,
    report: TEXT,
    blocker: TEXT,
  },
  required: [
    "source",
    "baseline",
    "scratch",
    "corpora",
    "baseCommit",
    "initialHead",
    "branch",
    "items",
    "preservedBehavior",
    "commands",
    "report",
    "blocker",
  ],
};
const IMPLEMENTATION = {
  type: "object",
  additionalProperties: false,
  properties: {
    commit: TEXT,
    changedFiles: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: { file: TEXT, why: TEXT },
        required: ["file", "why"],
      },
    },
    tests: TEXTS,
    commands: COMMANDS,
    snapshotDiff: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          location: TEXT,
          classification: { type: "string", enum: ["fix", "regression", "conservative-loss", "unclear"] },
          evidence: TEXT,
        },
        required: ["location", "classification", "evidence"],
      },
    },
    notFixed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: TEXT, reason: TEXT },
        required: ["id", "reason"],
      },
    },
    residual: TEXTS,
  },
  required: ["commit", "changedFiles", "tests", "commands", "snapshotDiff", "notFixed", "residual"],
};
const GATE = {
  type: "object",
  additionalProperties: false,
  properties: {
    status: { type: "string", enum: ["passed", "load-flake", "failed"] },
    commands: COMMANDS,
    failures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { id: TEXT, title: TEXT, location: TEXT, evidence: TEXT, suggestedFix: TEXT },
        required: ["id", "title", "location", "evidence", "suggestedFix"],
      },
    },
    flakes: TEXTS,
    report: TEXT,
  },
  required: ["status", "commands", "failures", "flakes", "report"],
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
  if (input.models?.implement !== undefined) options.model = requiredText(input.models.implement, "models.implement");
  if (input.adapters?.implement !== undefined)
    options.adapter = requiredText(input.adapters.implement, "adapters.implement");
  return options;
}
function safety() {
  return `Read AGENTS.md first and follow it, especially Semantic Accuracy Bar, Parsing and Language Support, and Path, Cache, and Review Safety. Use absolute paths for all commands, files, and probes.
All agents run in place in the prepared source worktree. Never use npm ci or npm install. Never create junctions or symlinks in scratch. Scripts, logs, generated indexes, cache experiments, and temporary project copies go only under the supplied external scratch directory, with scripts and caches outside indexed project copies. Never touch other checkouts: baseline and corpora are strictly read-only; load their compiled dist or read their files, never edit/build/install there.
No push, rebase, stash, checkout, reset, restore, switch, or clean. No branch creation, tags, remote operations, release automation, or issue/PR creation. Git writes are limited to the exact add/commit instructions of your phase. Do not stage anyone else's edits. Stop if the branch, expected HEAD, or unrelated working files changed underneath you.
Docs and all committed text must be ASCII-only. No local paths, machine names, usernames, or session details in committed text. Report observed command output, never guessed success. Native runtime is required; inspect the real APIs and existing consumer test patterns before writing probes.`;
}
function contextText() {
  return `Task: ${task}\nMode: ${mode}; base: ${base}.\nPrepared reproduction: ${JSON.stringify(reproduction)}\nEpoch reservations: ${JSON.stringify(input.epochs ?? {})}\nOracle instructions: ${JSON.stringify(input.oracle ?? "")}`;
}
function verificationInstructions() {
  return `Follow existing shared resolution modules; never establish a consumer-specific rule or a new mechanism for a rare form. Cover inclusion AND exclusion through goto, references including referenceCoverage.state, detailed graph, and rename-preview when relevant, with same-named decoys and cold/reopened disk-cache consumers. Update the relevant call-form matrix cell and regenerate docs/coverage/call-forms.md with the AGENTS.md command when call forms change. Preserve edge-corpus assertion meaning; never turn a real @known-gap into @not-ref or drop passing assertions.
Update the applicable canonical docs, language parity/scenario coverage, and CHANGELOG per AGENTS.md. Bump CORE_ALGORITHM_EPOCH or LANGUAGE_BEHAVIOR_EPOCH only when changed persisted facts or language hooks require it. If a reservation is supplied for a needed epoch, use exactly that value and reject a stale/non-advancing reservation; otherwise follow the repository's normal epoch increment. Never consume an epoch for unrelated work.
Run npm run build before worker/native consumer tests. Run focused affected suites, both TypeScript configs (npx tsc --noEmit -p tsconfig.json and npx tsc --noEmit -p tsconfig.tests.json), ESLint and Prettier checks on changed applicable files using the repository's configuration, and npm run graph:snapshot:check. Do not run npm run check here; the separate optional full gate owns it. If test counts require fixture-report regeneration per repository guidance, regenerate that report too.
If snapshots differ, classify EVERY diff line with file:line and base/head evidence. Regenerate with npm run graph:snapshot ONLY if every changed line is a proven fix; never bless regression, conservative-loss, or unclear changes. In refactor mode ANY answer/edge difference violates preservation: correct the implementation instead of regenerating snapshots. Rerun snapshot:check after justified regeneration. Report [] for an unchanged snapshot.
Before committing, require your requested verification to pass, inspect the full intended diff, and remove only your own throwaway artifacts. Record exact commands and observed results. notFixed must list ALL still-unfixed ORIGINAL reproduction task ids with reasons, not review-candidate ids; residual includes unresolved review candidates and explicit remaining risks. Never claim completion for unimplemented work.`;
}
function correctionPrompt(blockers, expectedCommit, label) {
  return `${safety()}
${contextText()}
Correction phase: ${label}. Expected source HEAD: ${expectedCommit}. These are the ONLY defects to fix: ${JSON.stringify(blockers)}
Reproduce each confirmed introduced blocker before editing and fix it at the shared seam. Do not fix preexisting findings or draft-follow-up limits. Do not add new mechanisms for rare forms. Preserve all prior intended fixes and the recorded base behavior in refactor mode.
Previously unresolved original task ids: ${JSON.stringify(implementations[implementations.length - 1].notFixed)}. Carry them into notFixed unless current consumer evidence proves them resolved; do not silently drop them when reporting this round.
${verificationInstructions()}
Git: this is the only phase allowed to amend. After focused verification, use git add -A and git commit --amend --no-edit, once, to update the existing implementation commit. Never create an additional commit. Confirm the parent remains unchanged and return the amended commit hash, changedFiles with reasons, tests, command evidence, snapshotDiff, notFixed, and residual.`;
}
function checkImplementation(result) {
  if (!/^[0-9a-f]{40,64}$/i.test(result.commit)) throw new Error("Implementation did not return a full commit hash");
  if (result.snapshotDiff.some((line) => line.classification !== "fix"))
    throw new Error("Implementation left an unapproved snapshot difference");
  if (mode === "refactor" && result.snapshotDiff.length) throw new Error("Refactor changed the graph snapshot");
  const unresolvedIds = new Set();
  for (const item of result.notFixed) {
    if (!itemIds.has(item.id) || unresolvedIds.has(item.id)) throw new Error("Invalid or duplicate unresolved task id");
    unresolvedIds.add(item.id);
  }
}
function addFollowUp(finding) {
  const key = `${finding.location}|${finding.title}`;
  if (followUpKeys.has(key)) return;
  followUpKeys.add(key);
  followUps.push({
    title: finding.title,
    body: `Preexisting or documented limit; not part of this change.\nLocation: ${finding.location}\nEvidence: ${finding.evidence}\nSuggested follow-up: ${finding.suggestedFix}`,
  });
}
async function review() {
  phase("Review and correct");
  const reviewArgs = {
    base,
    head: "HEAD",
    baseline: reproduction.baseline,
    goals: `${task}\n\nReproduction findings:\n${JSON.stringify(reproduction.items)}\nPreserved base behavior:\n${JSON.stringify(reproduction.preservedBehavior)}`,
    mode: reviewMode,
    corpora: reproduction.corpora,
    scratch: reproduction.scratch,
  };
  if (input.models?.review !== undefined)
    reviewArgs.models = { review: requiredText(input.models.review, "models.review") };
  if (input.adapters?.review !== undefined)
    reviewArgs.adapters = { review: requiredText(input.adapters.review, "adapters.review") };
  const result = await workflow({ scriptPath: ".odw/workflows/codegraph-pre-merge.js" }, reviewArgs);
  if (
    !result ||
    !Array.isArray(result.blockers) ||
    !Array.isArray(result.preexisting) ||
    !Array.isArray(result.minor) ||
    typeof result.report !== "string"
  ) {
    throw new Error("Pre-merge review did not return a complete result");
  }
  result.preexisting.forEach(addFollowUp);
  return result;
}
async function fullGate(label) {
  phase("Full gate");
  const result = await agent(
    `${safety()}
Run the final full gate, read-only apart from its normal generated verification artifacts. Source: ${reproduction.source}; scratch: ${reproduction.scratch}; expected HEAD: ${commit}.
Run npm run check exactly once and capture its actual output. Do not edit source, repair failures, build the baseline, or write Git. If it fails in a test file, run the narrow repository command for EACH failing file alone THREE times, sequentially, with the same native/runtime prerequisites. Only a failing file that passes all three isolated reruns is a load flake; record all three commands and outputs. A persistent failure, a non-test gate failure, or a failure that cannot be mapped to an isolated file is real, not a flake. Do not mask a failure by narrowing assertions or suppressing output.
status passed requires the full command passed. status load-flake requires every failure passed its three isolated reruns and failures: []. status failed requires a nonempty failures list with stable ids, real file:line locations, concrete evidence, and suggested fixes. Preserve flakes separately when real failures coexist. Return the requested gate schema.`,
    agentOptions(GATE, label),
  );
  if (result.status === "failed" && !result.failures.length) throw new Error("Failed full gate omitted its failures");
  if (result.status !== "failed" && result.failures.length) throw new Error("Full gate hid real failures");
  if (result.status === "load-flake" && !result.flakes.length) throw new Error("Load-flake verdict omitted evidence");
  gates.push(result);
  return result;
}

const input = typeof args === "string" ? JSON.parse(args) : args;
if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Expected an args object");
const task = requiredText(input.task, "task");
const baseline = absolutePath(input.baseline, "baseline");
const base = requiredText(input.base ?? "origin/main", "base");
const mode = input.mode ?? "fix";
if (!["fix", "refactor"].includes(mode)) throw new Error("mode must be fix or refactor");
const reviewMode = mode === "refactor" ? "refactor" : "change";
const maxRounds = input.maxRounds ?? 3;
if (!Number.isInteger(maxRounds) || maxRounds < 0) throw new Error("maxRounds must be a nonnegative integer");
const runFullGate = input.fullGate ?? false;
if (typeof runFullGate !== "boolean") throw new Error("fullGate must be boolean");
if (input.oracle !== undefined) requiredText(input.oracle, "oracle");
if (input.scratch !== undefined) absolutePath(input.scratch, "scratch");
const corpora = input.corpora ?? [];
if (!Array.isArray(corpora)) throw new Error("corpora must be an array");
corpora.forEach((path) => absolutePath(path, "corpora entry"));
if (input.epochs !== undefined) {
  if (!input.epochs || typeof input.epochs !== "object" || Array.isArray(input.epochs))
    throw new Error("epochs must be an object");
  for (const [key, value] of Object.entries(input.epochs)) {
    if (!["core", "language"].includes(key) || !Number.isInteger(value) || value < 0)
      throw new Error("epochs accepts only nonnegative core/language integers");
  }
}

phase("Reproduce");
const reproduction = await agent(
  `${safety()}
Reproduce only; no source edits or git writes. Task: ${task}\nMode: ${mode}.
Inputs: ${JSON.stringify({ base, baseline, corpora, scratch: input.scratch, oracle: input.oracle })}
Resolve the source cwd and all paths absolutely. Verify baseline HEAD equals base resolved in source, baseline dist and native runtime are built/usable, the source has its prepared dependencies and built dist, and the source is a clean dedicated non-protected branch (not main, master, develop, trunk, or release/*). Save initial HEAD and branch. Do not install, rebuild baseline, or modify either checkout. Stop on a missing prerequisite rather than silently skipping task items.
Create a unique run directory below the supplied scratch parent, or below codegraph-odw in the OS temporary directory when omitted. Resolve real paths first and reject overlap with source, baseline, or any supplied indexed corpus, including aliases. All probes and caches must stay there, outside indexed project copies.
Reproduce EVERY task item on baseline/dist with real consumer probes in scratch. Confirm expected semantics with the supplied oracle when present; execute its reference implementation against scratch inputs, not merely quote the instructions. Read actual syntax/API contracts. Classify each item fix | conservative | document-limit under the AGENTS.md Semantic Accuracy Bar. Give each a stable id, reproduced boolean, exact baseline output, expected semantics, oracle evidence (or explicitly not supplied), and probe paths. A conservative item is an actionable exclusion/partial-coverage correction, not a new language mechanism.
In refactor mode, reproduced means a base behavior contract was actually recorded, not that a defect exists. Record the chosen goto/reference/coverage/graph probes and expected outputs in preservedBehavior; require npm run graph:snapshot:check to be clean on base, using scratch cache paths without changing base files. Head must reproduce these outputs exactly.
Return schema-validated reproduction evidence. If nothing is reproduced or every item is document-limit the workflow returns without edits. Never invent a reproduced result to enter implementation.
Set blocker to an empty string when every prerequisite check passed. If a prerequisite fails (for example, baseline HEAD differs from base, a dist is missing, or the source branch is protected or dirty), stop there: set blocker to the failed check with the expected and observed values, list each task item with reproduced false, and return empty strings or arrays for anything not established.`,
  agentOptions(REPRODUCTION, "Reproduce"),
);
if (reproduction.blocker.trim())
  throw new Error(`Reproduction stopped: ${reproduction.blocker}\n${reproduction.report}`);
absolutePath(reproduction.source, "prepared source");
absolutePath(reproduction.baseline, "prepared baseline");
absolutePath(reproduction.scratch, "prepared scratch");
const itemIds = new Set(reproduction.items.map((item) => item.id));
if (itemIds.size !== reproduction.items.length) throw new Error("Reproduction returned duplicate task ids");
const followUps = [];
const followUpKeys = new Set();
for (const item of reproduction.items) {
  if (item.triage === "document-limit")
    addFollowUp({
      location: item.id,
      title: item.task,
      evidence: `${item.baselineEvidence}\n${item.expected}`,
      suggestedFix: "Document the Semantic Accuracy Bar limit or open a separate scoped issue.",
    });
}
const actionable = reproduction.items.filter((item) => item.reproduced && item.triage !== "document-limit");
if (!actionable.length) {
  const allLimits = reproduction.items.every((item) => item.triage === "document-limit");
  let status = "not-reproduced";
  if (allLimits) status = "document-limit";
  return {
    status,
    commit: "",
    rounds: 0,
    fixed: [],
    followUps,
    residual: reproduction.items
      .filter((item) => !item.reproduced)
      .map((item) => `${item.id}: ${item.task}: ${item.baselineEvidence}`),
    report: `# Codegraph fix\n- Status: ${status}; no edits or commits.\n${reproduction.report}`,
  };
}

phase("Implement");
const implementation = await agent(
  `${safety()}
${contextText()}
Implement ONLY the reproduced actionable items: ${JSON.stringify(actionable)}. Initial source HEAD must still equal ${reproduction.initialHead}. Preserve unrelated user changes; the initial clean worktree must not have acquired unrelated edits.
${verificationInstructions()}
Git: only git add for your intended changed files and ONE git commit are allowed in this phase. Create one local implementation commit after successful focused verification, without amending or touching other checkouts. Return its full hash plus changedFiles [{file, why}], tests, commands [{command, result}], snapshotDiff, notFixed [{id, reason}], and residual. Do not claim a task fixed when any required consumer assertion still fails.`,
  agentOptions(IMPLEMENTATION, "Implement"),
);
checkImplementation(implementation);
let commit = implementation.commit;
const implementations = [implementation];
const gates = [];
let rounds = 0;
let currentReview = await review();
const fixedCandidates = [];
while (currentReview.blockers.length && rounds < maxRounds) {
  const blockers = currentReview.blockers;
  rounds++;
  phase("Review and correct");
  const correction = await agent(
    correctionPrompt(blockers, commit, `blocker round ${rounds}`),
    agentOptions(IMPLEMENTATION, `Correct ${rounds}`),
  );
  checkImplementation(correction);
  commit = correction.commit;
  implementations.push(correction);
  currentReview = await review();
  for (const finding of blockers) {
    const stillBlocked = currentReview.blockers.some(
      (remaining) => remaining.title === finding.title && remaining.lane === finding.lane,
    );
    if (!stillBlocked) fixedCandidates.push(finding.title);
  }
}

let gate = null;
if (runFullGate) {
  gate = await fullGate("Full gate");
  if (gate.status === "failed") {
    // One additional correction is allowed for real full-gate failures, not an unbounded retry loop.
    rounds++;
    const failures = gate.failures;
    const correction = await agent(
      correctionPrompt(failures, commit, "full-gate correction"),
      agentOptions(IMPLEMENTATION, "Correct full gate"),
    );
    checkImplementation(correction);
    commit = correction.commit;
    implementations.push(correction);
    currentReview = await review();
    gate = await fullGate("Full gate after correction");
    if (gate.status !== "failed") fixedCandidates.push(...failures.map((failure) => failure.title));
  }
}

const latestImplementation = implementations[implementations.length - 1];
const notFixed = new Map(latestImplementation.notFixed.map((item) => [item.id, item.reason]));
const fixed = actionable.filter((item) => !notFixed.has(item.id)).map((item) => item.task);
const resolvedTitles = fixedCandidates.filter(
  (title) => !currentReview.blockers.some((finding) => finding.title === title),
);
fixed.push(...new Set(resolvedTitles));
const residual = [
  ...reproduction.items
    .filter((item) => !item.reproduced && item.triage !== "document-limit")
    .map((item) => `${item.id}: not reproduced: ${item.task}`),
  ...Array.from(notFixed, ([id, reason]) => `${id}: ${reason}`),
  ...implementations[implementations.length - 1].residual,
  ...currentReview.blockers.map((finding) => `${finding.severity} ${finding.location}: ${finding.title}`),
  ...currentReview.minor.map((finding) => `Minor ${finding.location}: ${finding.title}`),
  ...gates.flatMap((result) => result.flakes.map((flake) => `Load flake: ${flake}`)),
];
let status = "ready";
if (currentReview.blockers.length || notFixed.size) status = "blocked";
if (reproduction.items.some((item) => !item.reproduced && item.triage !== "document-limit")) status = "blocked";
if (gate?.status === "failed") {
  status = "blocked";
  residual.push(...gate.failures.map((failure) => `${failure.location}: ${failure.title}: ${failure.evidence}`));
}
const report = [
  "# Codegraph fix",
  `- Status: ${status}; local commit: ${commit}; correction rounds: ${rounds}.`,
  `- Fixed: ${fixed.length}; follow-up drafts: ${followUps.length}; residual: ${residual.length}.`,
  ...implementations.flatMap((result) => result.changedFiles.map((change) => `- ${change.file}: ${change.why}`)),
  ...implementations.flatMap((result) =>
    result.commands.map((command) => `- Command: ${command.command}\n  Result: ${command.result}`),
  ),
  ...followUps.map((draft) => `- Follow-up draft: ${draft.title}\n${draft.body}`),
  ...residual.map((item) => `- Residual: ${item}`),
  currentReview.report,
  ...gates.map((result) => result.report),
  "- The host owns pushing, PRs, stacking, and merging. No publishing was performed.",
].join("\n");
log(`Fix workflow ${status}: ${rounds} correction rounds, ${followUps.length} follow-up drafts`);
return { status, commit, rounds, fixed, followUps, residual, report };
