// Summarize a V8 CPU profile (.cpuprofile), sampling heap profile (.heapprofile), or the precise call counts written by
// profile-operation.mjs (.coverage.json). Frames in a Codegraph dist file are mapped to TypeScript sources through
// the dist source maps, so results name src/<file>.ts:<line>.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: node scripts/benchmarks/summarize-profile.mjs <profile>... [--top N] [--json output.json]
  [--callers <frame substring>]
  <profile> is a .cpuprofile, .heapprofile, or .coverage.json file. Several CPU profiles (for example one per
  worker thread) are merged into one summary.`;

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["--top", "--json", "--callers"]);
const inputs = [];
for (let index = 0; index < argv.length; index += 1) {
  if (VALUE_FLAGS.has(argv[index])) {
    index += 1;
    continue;
  }
  if (!argv[index].startsWith("--")) inputs.push(argv[index]);
}
const input = inputs[0];
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : fallback;
};
if (!input) {
  console.error(USAGE);
  process.exit(2);
}
const top = Number(option("top", 30));
const jsonOutput = option("json");

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Map([...BASE64].map((character, index) => [character, index]));

// Decode a source map's mappings into, per generated line, [column, sourceIndex, sourceLine] segments.
function decodeMappings(mappings) {
  const lines = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;
  for (const lineText of mappings.split(";")) {
    const segments = [];
    let column = 0;
    for (const segmentText of lineText.split(",")) {
      if (!segmentText) continue;
      const values = [];
      let value = 0;
      let shift = 0;
      for (const character of segmentText) {
        const digit = BASE64_VALUES.get(character);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      column += values[0];
      if (values.length >= 4) {
        sourceIndex += values[1];
        sourceLine += values[2];
        sourceColumn += values[3];
        segments.push([column, sourceIndex, sourceLine]);
      }
    }
    lines.push(segments);
  }
  void sourceColumn;
  return lines;
}

const sourceMaps = new Map();
function sourceMapFor(file) {
  if (sourceMaps.has(file)) return sourceMaps.get(file);
  let map = null;
  try {
    const raw = JSON.parse(fs.readFileSync(`${file}.map`, "utf8"));
    map = {
      sources: raw.sources.map((source) => path.resolve(path.dirname(file), raw.sourceRoot ?? "", source)),
      lines: decodeMappings(raw.mappings),
    };
  } catch {
    map = null;
  }
  sourceMaps.set(file, map);
  return map;
}

const fileTexts = new Map();
function lineStarts(file) {
  if (!fileTexts.has(file)) {
    const starts = [0];
    try {
      const text = fs.readFileSync(file, "utf8");
      for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) starts.push(index + 1);
    } catch {
      // A missing file keeps the single start, so offsets map to line 0.
    }
    fileTexts.set(file, starts);
  }
  return fileTexts.get(file);
}

function offsetToPosition(file, offset) {
  const starts = lineStarts(file);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, column: offset - starts[low] };
}

// The repository-relative source of a generated position, or the generated file when no map covers it.
function originalLocation(url, line, column) {
  if (!url) return "";
  let file;
  try {
    file = url.startsWith("file:") ? fileURLToPath(url) : url;
  } catch {
    return url;
  }
  const map = sourceMapFor(file);
  const segments = map?.lines[line];
  if (segments?.length) {
    let chosen = segments[0];
    for (const segment of segments) {
      if (segment[0] <= column) chosen = segment;
      else break;
    }
    return `${shortPath(map.sources[chosen[1]])}:${chosen[2] + 1}`;
  }
  return `${shortPath(file)}:${line + 1}`;
}

function shortPath(file) {
  const normalized = file.replaceAll("\\", "/");
  for (const marker of ["/src/", "/dist/", "/node_modules/"]) {
    const at = normalized.lastIndexOf(marker);
    if (at >= 0) return normalized.slice(at + 1);
  }
  return normalized.startsWith("node:") ? normalized : path.basename(normalized);
}

function frameKey(callFrame) {
  const name = callFrame.functionName || "(anonymous)";
  if (!callFrame.url) return name;
  return `${name} ${originalLocation(callFrame.url, callFrame.lineNumber, callFrame.columnNumber)}`;
}

// Inclusive totals count a function once per stack, so recursion does not inflate them.
function aggregateTree(rootNode, childrenOf, selfOf, keyOf) {
  const self = new Map();
  const inclusive = new Map();
  const totals = new Map();
  const order = [];
  const stack = [rootNode];
  while (stack.length) {
    const node = stack.pop();
    order.push(node);
    for (const child of childrenOf(node)) stack.push(child);
  }
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const node = order[index];
    let total = selfOf(node);
    for (const child of childrenOf(node)) total += totals.get(child);
    totals.set(node, total);
    const key = keyOf(node);
    self.set(key, (self.get(key) ?? 0) + selfOf(node));
  }
  const onPath = new Map();
  const walk = [[rootNode, false]];
  while (walk.length) {
    const [node, leaving] = walk.pop();
    const key = keyOf(node);
    if (leaving) {
      onPath.set(key, onPath.get(key) - 1);
      continue;
    }
    if (!onPath.get(key)) inclusive.set(key, (inclusive.get(key) ?? 0) + totals.get(node));
    onPath.set(key, (onPath.get(key) ?? 0) + 1);
    walk.push([node, true]);
    for (const child of childrenOf(node)) walk.push([child, false]);
  }
  return { self, inclusive, total: totals.get(rootNode) };
}

const SPECIAL = new Set(["(root)", "(idle)", "(program)", "(garbage collector)"]);

function summarizeCpuProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfByNode = new Map();
  const timestamps = [];
  let time = profile.startTime;
  for (const delta of profile.timeDeltas) {
    time += delta;
    timestamps.push(time);
  }
  for (let index = 0; index < profile.samples.length; index += 1) {
    const next = index + 1 < timestamps.length ? timestamps[index + 1] : profile.endTime;
    const duration = Math.max(0, next - timestamps[index]);
    selfByNode.set(profile.samples[index], (selfByNode.get(profile.samples[index]) ?? 0) + duration);
  }
  const rootNode = profile.nodes[0];
  const { self, inclusive, total } = aggregateTree(
    rootNode,
    (node) => (node.children ?? []).map((id) => nodes.get(id)),
    (node) => (selfByNode.get(node.id) ?? 0) / 1000,
    (node) => frameKey(node.callFrame),
  );
  const idle = self.get("(idle)") ?? 0;
  const program = self.get("(program)") ?? 0;
  const gc = self.get("(garbage collector)") ?? 0;
  const busy = total - idle;
  const rows = [...self.entries()]
    .filter(([key]) => !SPECIAL.has(key))
    .map(([key, ms]) => ({ key, selfMs: ms, sharePct: (ms / busy) * 100, inclusiveMs: inclusive.get(key) ?? 0 }))
    .sort((left, right) => right.selfMs - left.selfMs);
  const byFile = new Map();
  for (const row of rows) {
    const location = row.key.includes(" ") ? row.key.slice(row.key.indexOf(" ") + 1) : "(native)";
    const file = location.replace(/:\d+$/, "");
    byFile.set(file, (byFile.get(file) ?? 0) + row.selfMs);
  }
  const inclusiveRows = [...inclusive.entries()]
    .filter(([key]) => !SPECIAL.has(key))
    .map(([key, ms]) => ({ key, inclusiveMs: ms, sharePct: (ms / busy) * 100 }))
    .sort((left, right) => right.inclusiveMs - left.inclusiveMs);
  return {
    kind: "cpu",
    totalMs: total,
    busyMs: busy,
    idleMs: idle,
    programMs: program,
    gcMs: gc,
    self: rows,
    files: [...byFile.entries()]
      .map(([file, ms]) => ({ file, selfMs: ms, sharePct: (ms / busy) * 100 }))
      .sort((left, right) => right.selfMs - left.selfMs),
    inclusive: inclusiveRows,
  };
}

function summarizeHeapProfile(profile) {
  const { self, inclusive, total } = aggregateTree(
    profile.head,
    (node) => node.children ?? [],
    (node) => node.selfSize / 2 ** 20,
    (node) => frameKey(node.callFrame),
  );
  return {
    kind: "heap",
    totalMiB: total,
    self: [...self.entries()]
      .filter(([key]) => !SPECIAL.has(key))
      .map(([key, mib]) => ({ key, selfMiB: mib, sharePct: (mib / total) * 100, inclusiveMiB: inclusive.get(key) }))
      .sort((left, right) => right.selfMiB - left.selfMiB),
  };
}

// For frames whose key contains `needle`, the time under them grouped by the first two caller frames.
function cpuCallers(profile, needle) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const selfByNode = new Map();
  let time = profile.startTime;
  const timestamps = profile.timeDeltas.map((delta) => (time += delta));
  for (let index = 0; index < profile.samples.length; index += 1) {
    const next = index + 1 < timestamps.length ? timestamps[index + 1] : profile.endTime;
    selfByNode.set(profile.samples[index], (selfByNode.get(profile.samples[index]) ?? 0) + next - timestamps[index]);
  }
  const totals = new Map();
  const totalOf = (id) => {
    if (totals.has(id)) return totals.get(id);
    let total = selfByNode.get(id) ?? 0;
    for (const child of nodes.get(id).children ?? []) total += totalOf(child);
    totals.set(id, total);
    return total;
  };
  const byCaller = new Map();
  for (const node of profile.nodes) {
    const key = frameKey(node.callFrame);
    if (!key.includes(needle)) continue;
    const parentId = parents.get(node.id);
    if (parentId !== undefined && frameKey(nodes.get(parentId).callFrame).includes(needle)) continue;
    const callers = [];
    let at = parentId;
    while (at !== undefined && callers.length < 2) {
      callers.push(frameKey(nodes.get(at).callFrame));
      at = parents.get(at);
    }
    const caller = callers.join(" <- ");
    byCaller.set(caller, (byCaller.get(caller) ?? 0) + totalOf(node.id) / 1000);
  }
  return [...byCaller.entries()].sort((left, right) => right[1] - left[1]);
}

function summarizeCoverage(coverage, distRoot) {
  const rows = coverage.functions.map((fn) => {
    const file = path.join(distRoot, fn.file);
    const position = offsetToPosition(file, fn.offset);
    const location = originalLocation(`file:///${file.replaceAll("\\", "/")}`, position.line, position.column);
    return { key: `${fn.name} ${location}`, count: fn.count };
  });
  return { kind: "coverage", totalCalls: coverage.totalCalls, calls: rows };
}

// Sum per-key times of several CPU summaries; shares are recomputed against the combined busy time.
function mergeCpuSummaries(summaries) {
  if (summaries.length === 1) return summaries[0];
  const totals = { totalMs: 0, busyMs: 0, idleMs: 0, programMs: 0, gcMs: 0 };
  const self = new Map();
  const files = new Map();
  const inclusive = new Map();
  for (const summary of summaries) {
    for (const key of Object.keys(totals)) totals[key] += summary[key];
    for (const row of summary.self) {
      const entry = self.get(row.key) ?? { key: row.key, selfMs: 0, inclusiveMs: 0 };
      entry.selfMs += row.selfMs;
      entry.inclusiveMs += row.inclusiveMs;
      self.set(row.key, entry);
    }
    for (const row of summary.files) files.set(row.file, (files.get(row.file) ?? 0) + row.selfMs);
    for (const row of summary.inclusive) inclusive.set(row.key, (inclusive.get(row.key) ?? 0) + row.inclusiveMs);
  }
  const share = (ms) => (ms / totals.busyMs) * 100;
  return {
    kind: "cpu",
    ...totals,
    profiles: summaries.length,
    self: [...self.values()]
      .map((row) => ({ ...row, sharePct: share(row.selfMs) }))
      .sort((left, right) => right.selfMs - left.selfMs),
    files: [...files.entries()]
      .map(([file, selfMs]) => ({ file, selfMs, sharePct: share(selfMs) }))
      .sort((left, right) => right.selfMs - left.selfMs),
    inclusive: [...inclusive.entries()]
      .map(([key, inclusiveMs]) => ({ key, inclusiveMs, sharePct: share(inclusiveMs) }))
      .sort((left, right) => right.inclusiveMs - left.inclusiveMs),
  };
}

const raw = JSON.parse(fs.readFileSync(input, "utf8"));
let summary;
if (input.endsWith(".cpuprofile")) {
  summary = mergeCpuSummaries(
    inputs.map((file, index) => summarizeCpuProfile(index ? JSON.parse(fs.readFileSync(file, "utf8")) : raw)),
  );
} else if (input.endsWith(".heapprofile")) {
  summary = summarizeHeapProfile(raw);
} else {
  const resultFile = input.replace(/\.coverage\.json$/, ".json");
  const checkout = JSON.parse(fs.readFileSync(resultFile, "utf8")).checkout;
  summary = summarizeCoverage(raw, path.join(checkout, "dist"));
}

const fixed = (value, digits = 1) => value.toFixed(digits);
if (summary.kind === "cpu") {
  console.log(
    `total ${fixed(summary.totalMs)} ms, busy ${fixed(summary.busyMs)} ms, idle ${fixed(summary.idleMs)} ms, ` +
      `program ${fixed(summary.programMs)} ms, GC ${fixed(summary.gcMs)} ms`,
  );
  console.log("\nself ms  share%  incl ms  function");
  for (const row of summary.self.slice(0, top)) {
    console.log(
      `${fixed(row.selfMs).padStart(7)} ${fixed(row.sharePct).padStart(7)} ${fixed(row.inclusiveMs).padStart(8)}  ${row.key}`,
    );
  }
  console.log("\nself ms  share%  file");
  for (const row of summary.files.slice(0, Math.ceil(top / 2))) {
    console.log(`${fixed(row.selfMs).padStart(7)} ${fixed(row.sharePct).padStart(7)}  ${row.file}`);
  }
  console.log("\nincl ms  share%  function");
  for (const row of summary.inclusive.slice(0, top)) {
    console.log(`${fixed(row.inclusiveMs).padStart(7)} ${fixed(row.sharePct).padStart(7)}  ${row.key}`);
  }
  const needle = option("callers");
  if (needle) {
    console.log(`\nincl ms  callers of frames matching "${needle}"`);
    for (const [caller, ms] of cpuCallers(raw, needle).slice(0, top)) {
      console.log(`${fixed(ms).padStart(7)}  ${caller}`);
    }
  }
} else if (summary.kind === "heap") {
  console.log(`sampled ${fixed(summary.totalMiB)} MiB`);
  console.log("\nself MiB  share%  incl MiB  allocation site");
  for (const row of summary.self.slice(0, top)) {
    console.log(
      `${fixed(row.selfMiB, 2).padStart(8)} ${fixed(row.sharePct).padStart(7)} ${fixed(row.inclusiveMiB, 2).padStart(9)}  ${row.key}`,
    );
  }
} else {
  console.log(`total calls ${summary.totalCalls}`);
  console.log("\n     calls  function");
  for (const row of summary.calls.slice(0, top)) console.log(`${String(row.count).padStart(10)}  ${row.key}`);
}
if (jsonOutput) fs.writeFileSync(jsonOutput, `${JSON.stringify(summary)}\n`);
