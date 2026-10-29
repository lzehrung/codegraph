import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildCandidatePairs, prepareDuplicateCandidateBuckets } from "../src/duplicates/candidates.js";
import type { DuplicateInternalUnit, PairEvidence } from "../src/duplicates/types.js";
import { buildInternalUnit } from "../src/duplicates/units.js";
import { buildProjectIndex, findDuplicates } from "../src/index.js";
import type { ProgressUpdate } from "../src/types.js";
import { captureCli } from "./helpers/cli.js";

const SHINGLE_SIZE = 3;
const WINDOW_SIZE = 2;
const WORDS = ["if", "else", "return", "for", "while", "(", ")", "{", "}", ";", "=", "+", "x", "y", "z", "1", "2"];

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWords(random: () => number, length: number): string[] {
  return Array.from({ length }, () => WORDS[Math.floor(random() * WORDS.length)]!);
}

type UnitSpec = { file: string; text: string; astShapeHash?: string; name?: string; startLine?: number };

function makeUnit(spec: UnitSpec): DuplicateInternalUnit {
  const startLine = spec.startLine ?? 1;
  return buildInternalUnit(
    {
      file: spec.file,
      startLine,
      endLine: startLine + 9,
      languageId: "typescript",
      kind: "chunk",
      ...(spec.name !== undefined ? { name: spec.name } : {}),
    },
    `/repo/${spec.file}`,
    spec.text,
    SHINGLE_SIZE,
    WINDOW_SIZE,
    {},
    spec.astShapeHash,
  );
}

type Expected = {
  rawHash: boolean;
  normalizedHash: boolean;
  astShape: boolean;
  signature: boolean;
  signatureMatches: number;
};

function idPair(left: DuplicateInternalUnit, right: DuplicateInternalUnit): string {
  return left.id < right.id ? `${left.id}|${right.id}` : `${right.id}|${left.id}`;
}

function bucketsOf<T extends string>(
  units: readonly DuplicateInternalUnit[],
  keys: (unit: DuplicateInternalUnit) => T[],
) {
  const buckets = new Map<T, DuplicateInternalUnit[]>();
  for (const unit of units) {
    for (const key of keys(unit)) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(unit);
      else buckets.set(key, [unit]);
    }
  }
  return buckets;
}

/** Counts, per pair, the eligible fingerprint buckets two units share, with every pair compared directly. */
function referenceCandidates(units: readonly DuplicateInternalUnit[], maxBucketSize: number) {
  const eligible = (bucket: readonly DuplicateInternalUnit[]) => bucket.length >= 2 && bucket.length <= maxBucketSize;
  const raw = bucketsOf(units, (unit) => [unit.rawHash]);
  const normalized = bucketsOf(units, (unit) => [unit.normalizedHash]);
  const astShape = bucketsOf(units, (unit) => (unit.astShapeHash === undefined ? [] : [unit.astShapeHash]));
  const fingerprints = bucketsOf(units, (unit) => [...unit.signatures]);
  const eligibleFingerprints = [...fingerprints.values()].filter(eligible);
  const considered = new Map<string, number>();
  for (const bucket of eligibleFingerprints) {
    for (const unit of bucket) considered.set(unit.id, (considered.get(unit.id) ?? 0) + 1);
  }
  const oversizedBuckets = [raw, normalized, astShape, fingerprints]
    .flatMap((buckets) => [...buckets.values()])
    .filter((bucket) => bucket.length > maxBucketSize).length;

  const expected = new Map<string, Expected & { left: string; right: string; priority: number }>();
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const left = units[i]!;
      const right = units[j]!;
      const inBucket = (buckets: Map<string, DuplicateInternalUnit[]>, key: string | undefined) => {
        if (key === undefined) return false;
        const bucket = buckets.get(key);
        return !!bucket && eligible(bucket);
      };
      const rawHash = left.rawHash === right.rawHash && inBucket(raw, left.rawHash);
      const normalizedHash = left.normalizedHash === right.normalizedHash && inBucket(normalized, left.normalizedHash);
      const astShapeHash =
        left.astShapeHash !== undefined &&
        left.astShapeHash === right.astShapeHash &&
        inBucket(astShape, left.astShapeHash);
      const shared = eligibleFingerprints.filter((bucket) => bucket.includes(left) && bucket.includes(right)).length;
      const smaller = Math.min(considered.get(left.id) ?? 0, considered.get(right.id) ?? 0);
      const signature = shared >= 2 && smaller > 0 && shared >= Math.max(2, Math.ceil(smaller * 0.25));
      if (!rawHash && !normalizedHash && !astShapeHash && !signature) continue;
      expected.set(idPair(left, right), {
        rawHash,
        normalizedHash,
        astShape: astShapeHash,
        signature,
        signatureMatches: shared,
        left: left.id,
        right: right.id,
        priority: smaller ? shared / smaller : 0,
      });
    }
  }
  return { expected, oversizedBuckets };
}

function describePairs(pairs: ReadonlyMap<number, PairEvidence>): Map<string, Expected> {
  const described = new Map<string, Expected>();
  for (const evidence of pairs.values()) {
    const key = idPair(evidence.left, evidence.right);
    expect(described.has(key)).toBe(false);
    described.set(key, {
      rawHash: evidence.rawHash,
      normalizedHash: evidence.normalizedHash,
      astShape: evidence.astShape,
      signature: evidence.signature,
      signatureMatches: evidence.signatureMatches,
    });
  }
  return described;
}

/** Units made of reused base texts: exact copies, identifier renames, and a token or two changed. */
function makeVariedUnits(seed: number): DuplicateInternalUnit[] {
  const random = seededRandom(seed);
  const bases = Array.from({ length: 10 }, () => randomWords(random, 26));
  const specs: UnitSpec[] = [];
  for (let index = 0; index < 44; index++) {
    const base = bases[Math.floor(random() * bases.length)]!;
    const words = [...base];
    const roll = random();
    if (roll > 0.35 && roll <= 0.6) {
      words.forEach((word, position) => {
        if (word === "x") words[position] = "renamed";
      });
    } else if (roll > 0.6) {
      for (let edit = 0; edit < 1 + Math.floor(random() * 3); edit++) {
        words[Math.floor(random() * words.length)] = WORDS[Math.floor(random() * WORDS.length)]!;
      }
    }
    const group = bases.indexOf(base) % 4;
    specs.push({
      file: `src/unit${index}.ts`,
      text: words.join(" "),
      ...(group < 2 ? { astShapeHash: `shape-${group}` } : {}),
    });
  }
  return specs.map(makeUnit);
}

describe("duplicate candidate pairs", () => {
  test.each([
    { seed: 3, maxBucketSize: 200 },
    { seed: 11, maxBucketSize: 6 },
    { seed: 29, maxBucketSize: 3 },
  ])("keeps exactly the pairs that share evidence (seed $seed, bucket limit $maxBucketSize)", async (scenario) => {
    const units = makeVariedUnits(scenario.seed);
    const { expected, oversizedBuckets } = referenceCandidates(units, scenario.maxBucketSize);
    // Guard the scenario itself: it must exercise every kind of evidence, not an empty comparison.
    expect([...expected.values()].some((pair) => pair.rawHash)).toBe(true);
    expect([...expected.values()].some((pair) => pair.signature && !pair.rawHash && !pair.normalizedHash)).toBe(true);

    const result = await buildCandidatePairs(prepareDuplicateCandidateBuckets(units), {
      maxBucketSize: scenario.maxBucketSize,
      maxCandidatePairs: 1_000_000,
    });
    const actual = describePairs(result.pairs);

    expect(result.skippedPairs).toBe(0);
    expect(result.oversizedBuckets).toBe(oversizedBuckets);
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [key, pair] of expected) {
      const found = actual.get(key)!;
      expect({ key, rawHash: found.rawHash, normalizedHash: found.normalizedHash, astShape: found.astShape }).toEqual({
        key,
        rawHash: pair.rawHash,
        normalizedHash: pair.normalizedHash,
        astShape: pair.astShape,
      });
      expect({ key, signature: found.signature }).toEqual({ key, signature: pair.signature });
      if (pair.signature)
        expect({ key, shared: found.signatureMatches }).toEqual({ key, shared: pair.signatureMatches });
    }
    // Fingerprint-only pairs are admitted after every pair that has stronger evidence.
    const flags = [...result.pairs.values()].map((pair) => pair.rawHash || pair.normalizedHash || pair.astShape);
    expect(flags.lastIndexOf(true)).toBeLessThan(flags.indexOf(false) === -1 ? flags.length : flags.indexOf(false));
  });

  test("treats units that share an id as one identity", async () => {
    const shared = "if ( x ) { return y ; } else { return z + 1 ; } for ( x = 1 ; x ; ) { y = 2 ; }";
    const units = [
      makeUnit({ file: "src/a.ts", text: shared, name: "alpha" }),
      // A long line split into chunks yields units with one range and name but different text.
      makeUnit({ file: "src/b.ts", text: shared, name: "beta" }),
      makeUnit({ file: "src/b.ts", text: `${shared} while ( y ) { x = 1 ; }`, name: "beta" }),
      makeUnit({ file: "src/c.ts", text: shared, name: "gamma" }),
    ];
    expect(units[1]!.id).toBe(units[2]!.id);

    const result = await buildCandidatePairs(prepareDuplicateCandidateBuckets(units), {
      maxBucketSize: 200,
      maxCandidatePairs: 1_000_000,
    });

    const described = describePairs(result.pairs);
    expect(described.size).toBe(result.pairs.size);
    expect(described.has(idPair(units[0]!, units[1]!))).toBe(true);
    expect(described.has(idPair(units[0]!, units[3]!))).toBe(true);
    expect(described.has(idPair(units[1]!, units[3]!))).toBe(true);
  });

  describe("pair limit", () => {
    // Four identical units give six pairs with exact evidence; the near copies share only fingerprints.
    const exact =
      "if ( x ) { return y ; } else { return z + 1 ; } for ( x = 1 ; x ; ) { y = 2 ; } while ( z ) { x = 1 ; }";
    const near = (edits: number) => {
      const words =
        "for ( x = 1 ; x ; ) { y = y + 2 ; z = x + y ; } return z ; if ( y ) { x = 1 ; } while ( z ) { y = 2 ; }".split(
          " ",
        );
      for (let edit = 0; edit < edits; edit++) words[3 + edit * 4] = "+";
      return words.join(" ");
    };
    const units = [
      ...["a", "b", "c", "d"].map((name) => makeUnit({ file: `src/exact-${name}.ts`, text: exact })),
      ...[0, 1, 2, 3, 4].map((edits) => makeUnit({ file: `src/near-${edits}.ts`, text: near(edits) })),
    ];
    const options = { maxBucketSize: 200 };

    async function candidates(maxCandidatePairs: number) {
      return await buildCandidatePairs(prepareDuplicateCandidateBuckets(units), { ...options, maxCandidatePairs });
    }

    test("keeps stronger evidence first and counts every fingerprint pair it skips", async () => {
      const all = await candidates(1_000_000);
      const strong = [...all.pairs.values()].filter((pair) => pair.rawHash || pair.normalizedHash || pair.astShape);
      const fingerprintOnly = [...all.pairs.values()].filter(
        (pair) => !pair.rawHash && !pair.normalizedHash && !pair.astShape,
      );
      expect(strong).toHaveLength(6);
      expect(fingerprintOnly.length).toBeGreaterThan(4);

      const atStrong = await candidates(strong.length);
      expect(atStrong.pairs.size).toBe(strong.length);
      expect([...atStrong.pairs.values()].every((pair) => pair.rawHash)).toBe(true);
      expect(atStrong.skippedPairs).toBe(fingerprintOnly.length);

      const roomForTwo = await candidates(strong.length + 2);
      expect(roomForTwo.pairs.size).toBe(strong.length + 2);
      expect(roomForTwo.skippedPairs).toBe(fingerprintOnly.length - 2);
    });

    test("keeps the fingerprint pairs that share the largest fraction of their fingerprints", async () => {
      const all = await candidates(1_000_000);
      const strongCount = [...all.pairs.values()].filter((pair) => pair.rawHash).length;
      const reference = referenceCandidates(units, options.maxBucketSize).expected;
      const fingerprintOnly = [...reference.entries()].filter(
        ([, pair]) => !pair.rawHash && !pair.normalizedHash && !pair.astShape,
      );

      const limited = await candidates(strongCount + 3);
      const keptKeys = new Set(
        [...limited.pairs.values()].filter((pair) => !pair.rawHash).map((pair) => idPair(pair.left, pair.right)),
      );
      expect(keptKeys.size).toBe(3);
      const kept = fingerprintOnly.filter(([key]) => keptKeys.has(key)).map(([, pair]) => pair.priority);
      const skipped = fingerprintOnly.filter(([key]) => !keptKeys.has(key)).map(([, pair]) => pair.priority);
      expect(Math.min(...kept)).toBeGreaterThanOrEqual(Math.max(...skipped));
    });

    test("is deterministic and never exceeds the limit", async () => {
      for (const limit of [1, 2, 5, 9, 12]) {
        const first = await candidates(limit);
        const second = await candidates(limit);
        expect(first.pairs.size).toBeLessThanOrEqual(limit);
        expect(first.skippedPairs).toBeGreaterThan(0);
        expect([...first.pairs.values()].map((pair) => idPair(pair.left, pair.right))).toEqual(
          [...second.pairs.values()].map((pair) => idPair(pair.left, pair.right)),
        );
      }
    });
  });
});

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => await fsp.rm(root, { recursive: true, force: true })));
});

const CLONED_FUNCTION = `
export function normalizeScaleRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  return totals.map((value, index) => labels[index] + ":" + value.toFixed(2)).join(",");
}
`;

async function makeClonedProject(copies: number): Promise<string> {
  const root = (await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-candidates-"))).replace(/\\/g, "/");
  tempRoots.push(root);
  await fsp.mkdir(path.join(root, "src"), { recursive: true });
  for (let copy = 0; copy < copies; copy++) {
    await fsp.writeFile(path.join(root, `src/copy${copy}.ts`), CLONED_FUNCTION);
  }
  return root;
}

describe("duplicate detection at scale", () => {
  test("reports the candidate pairs the limit skipped and stays silent when nothing was skipped", async () => {
    const root = await makeClonedProject(4);
    const index = await buildProjectIndex(root);

    const unlimited = await findDuplicates(index, { minConfidence: "high", limit: 5 });
    const limited = await findDuplicates(index, { minConfidence: "high", limit: 5, maxCandidatePairs: 2 });

    expect(unlimited.stats.candidatePairs).toBeGreaterThan(2);
    expect(unlimited.stats.candidatePairBudget).toBeUndefined();
    expect(limited.stats.candidatePairs).toBe(2);
    expect(limited.stats.candidatePairBudget?.limit).toBe(2);
    expect(limited.stats.candidatePairBudget?.skipped).toBeGreaterThan(0);
    expect(limited.omittedCounts.candidatePairs).toBe(limited.stats.candidatePairBudget?.skipped);
    expect(limited.stats.comparedPairs).toBeLessThanOrEqual(2);
    expect(limited.groups.length).toBeGreaterThan(0);
  });

  test("rejects a candidate pair limit outside the supported range", async () => {
    const root = await makeClonedProject(2);
    const index = await buildProjectIndex(root);

    await expect(findDuplicates(index, { maxCandidatePairs: 0 })).rejects.toThrow(
      'Invalid maxCandidatePairs value "0"',
    );
    await expect(findDuplicates(index, { maxCandidatePairs: 16_000_001 })).rejects.toThrow(
      "Expected an integer from 1 to 16000000",
    );
  });

  test("reports unit collection, candidate pairs, scoring, and grouping in order, then the total elapsed time", async () => {
    const root = await makeClonedProject(3);
    const index = await buildProjectIndex(root);
    const events: ProgressUpdate[] = [];

    await findDuplicates(index, {
      minConfidence: "high",
      onProgress: (update) => events.push(update),
      progressStartedAt: performance.now() - 5_000,
    });

    const activities = events.map((event) => event.activity).filter((activity, at, all) => activity !== all[at - 1]);
    expect(activities).toEqual([
      "Collecting duplicate units",
      "Finding candidate pairs",
      "Scoring candidate pairs",
      "Grouping duplicate findings",
      "Detected duplicates",
    ]);
    expect(events[0]?.phase).toBe("start");
    expect(events.filter((event) => event.phase === "start")).toHaveLength(1);
    const last = events.at(-1);
    expect(last?.phase).toBe("complete");
    expect(events.filter((event) => event.phase === "complete")).toHaveLength(1);
    expect(last?.elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect(events.filter((event) => event.activity === "Collecting duplicate units").at(-1)).toMatchObject({
      current: 3,
      total: 3,
      unit: "file",
    });
  });

  test("duplicates CLI honors --max-candidate-pairs and says when results are partial", async () => {
    const root = await makeClonedProject(4);

    const json = await captureCli(
      ["duplicates", "--root", ".", "src", "--json", "--min-confidence", "high", "--max-candidate-pairs", "2"],
      { cwd: root },
    );
    const parsed = JSON.parse(json.stdout) as {
      stats: { candidatePairs: number; candidatePairBudget?: { limit: number; skipped: number } };
    };
    const pretty = await captureCli(
      ["duplicates", "--root", ".", "src", "--min-confidence", "high", "--max-candidate-pairs", "2"],
      { cwd: root },
    );
    const complete = await captureCli(["duplicates", "--root", ".", "src", "--min-confidence", "high"], { cwd: root });

    expect(json.exitCode).toBeUndefined();
    expect(parsed.stats.candidatePairs).toBe(2);
    expect(parsed.stats.candidatePairBudget?.limit).toBe(2);
    expect(parsed.stats.candidatePairBudget?.skipped).toBeGreaterThan(0);
    expect(pretty.stdout).toContain("Candidate pair limit reached: kept 2, skipped ");
    expect(pretty.stdout).toContain("candidatePairs=");
    expect(complete.stdout).not.toContain("Candidate pair limit reached");
  });

  test("duplicates CLI rejects an out-of-range --max-candidate-pairs", async () => {
    const root = await makeClonedProject(2);

    const zero = await captureCli(["duplicates", "--root", ".", "src", "--max-candidate-pairs", "0"], { cwd: root });
    const huge = await captureCli(["duplicates", "--root", ".", "src", "--max-candidate-pairs", "16000001"], {
      cwd: root,
    });

    expect(zero.exitCode).toBe(1);
    expect(zero.stderr).toContain('Invalid --max-candidate-pairs value "0". Expected an integer from 1 to 16000000.');
    expect(huge.exitCode).toBe(1);
    expect(huge.stderr).toContain('Invalid --max-candidate-pairs value "16000001"');
  });

  test("duplicates CLI reports duplicate stages on stderr only, ending with the total elapsed time", async () => {
    const root = await makeClonedProject(3);

    const result = await captureCli(
      ["duplicates", "--root", ".", "src", "--json", "--min-confidence", "high", "--progress"],
      {
        cwd: root,
      },
    );
    const quiet = await captureCli(
      ["duplicates", "--root", ".", "src", "--json", "--min-confidence", "high", "--no-progress"],
      { cwd: root },
    );

    const stages = [
      "[Progress] Collecting duplicate units.",
      "[Progress] Finding candidate pairs.",
      "[Progress] Scoring candidate pairs",
      "[Progress] Grouping duplicate findings.",
      "[Progress] Detected duplicates: ",
    ].map((stage) => result.stderr.indexOf(stage));
    expect(stages.every((at) => at >= 0)).toBe(true);
    expect([...stages].sort((left, right) => left - right)).toEqual(stages);
    expect(result.stderr).toMatch(/\[Progress\] Detected duplicates: \d+ units? in \d+(\.\d+)?(ms|s)\.\n/);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(quiet.stderr).toBe("");
  });
});
