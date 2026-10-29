import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { DEFAULT_MAX_CANDIDATE_PAIRS } from "../src/duplicates/scoring.js";
import {
  buildCandidatePairs,
  prepareDuplicateCandidateBuckets,
  type CandidateFilter,
  type CandidatePairResult,
} from "../src/duplicates/candidates.js";
import type { DuplicateInternalUnit, PairEvidence } from "../src/duplicates/types.js";
import { buildInternalUnit } from "../src/duplicates/units.js";
import {
  findDuplicateContextsWithPreparedAnalysis,
  findDuplicatesWithPreparedAnalysis,
  prepareDuplicateAnalysis,
} from "../src/duplicates.js";
import { buildProjectIndex, findDuplicateContext, findDuplicateContexts, findDuplicates } from "../src/index.js";
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

type SharedIds = "none" | "adjacent" | "late";

/**
 * Units made of reused base texts: exact copies, identifier renames, and a token or two changed. With shared ids, every
 * sixth unit gets a sibling of the same id and a longer text, as a long line split into chunks does, placed next to it
 * or after all the other units.
 */
function makeVariedUnits(seed: number, sharedIds: SharedIds = "none"): DuplicateInternalUnit[] {
  const random = seededRandom(seed);
  const bases = Array.from({ length: 10 }, () => randomWords(random, 26));
  const specs: UnitSpec[] = [];
  const lateSiblings: UnitSpec[] = [];
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
    const spec: UnitSpec = {
      file: `src/unit${index}.ts`,
      text: words.join(" "),
      ...(group < 2 ? { astShapeHash: `shape-${group}` } : {}),
    };
    specs.push(spec);
    if (sharedIds !== "none" && index % 6 === 0) {
      const sibling = { ...spec, text: `${spec.text} ${randomWords(random, 4).join(" ")}` };
      if (sharedIds === "adjacent") specs.push(sibling);
      else lateSiblings.push(sibling);
    }
  }
  return [...specs, ...lateSiblings].map(makeUnit);
}

/** A targeted run over the units of `count` randomly chosen files. */
function targetFilter(units: readonly DuplicateInternalUnit[], seed: number, count: number): CandidateFilter {
  const random = seededRandom(seed * 31 + 7);
  const files = [...new Set(units.map((unit) => unit.file))];
  const chosen = new Set<string>();
  while (chosen.size < Math.min(count, files.length)) chosen.add(files[Math.floor(random() * files.length)]!);
  const unit = (candidate: DuplicateInternalUnit) => chosen.has(candidate.file);
  return { unit, pair: (left, right) => unit(left) || unit(right) };
}

type OracleEntry = {
  left: DuplicateInternalUnit;
  right: DuplicateInternalUnit;
  rawHash: boolean;
  normalizedHash: boolean;
  astShape: boolean;
  signature: boolean;
  signatureMatches: number;
  /** The share of the smaller unit's eligible fingerprint buckets that the pair has in common. */
  priority: number;
};

/**
 * The candidate pairs the original algorithm produced, kept as a reference. Every bucket is walked pair by pair, a pair
 * is admitted where the walk first meets it, and every count lives in a map. A targeted walk starts from the target
 * units, visits each pair once per bucket, and never pairs a unit with another unit of its own id.
 */
function walkedCandidates(
  units: readonly DuplicateInternalUnit[],
  options: { maxBucketSize: number; isTarget?: (unit: DuplicateInternalUnit) => boolean },
): { pairs: OracleEntry[]; oversizedBuckets: number } {
  const { maxBucketSize, isTarget } = options;
  const identity = (left: DuplicateInternalUnit, right: DuplicateInternalUnit): string =>
    [left.id, right.id].sort().join("\u0000");
  const inWalkOrder = (
    left: DuplicateInternalUnit,
    right: DuplicateInternalUnit,
  ): [DuplicateInternalUnit, DuplicateInternalUnit] => {
    if (left.absoluteFile !== right.absoluteFile) {
      return left.absoluteFile < right.absoluteFile ? [left, right] : [right, left];
    }
    return left.startLine <= right.startLine ? [left, right] : [right, left];
  };
  const walk = (
    bucket: readonly DuplicateInternalUnit[],
    visit: (left: DuplicateInternalUnit, right: DuplicateInternalUnit, key: string) => void,
  ): void => {
    if (!isTarget) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const [left, right] = inWalkOrder(bucket[i]!, bucket[j]!);
          visit(left, right, identity(left, right));
        }
      }
      return;
    }
    const seen = new Set<string>();
    for (const target of bucket.filter(isTarget)) {
      for (const other of bucket) {
        if (target.id === other.id) continue;
        const key = identity(target, other);
        if (seen.has(key)) continue;
        seen.add(key);
        const [left, right] = inWalkOrder(target, other);
        visit(left, right, key);
      }
    }
  };

  let oversizedBuckets = 0;
  const walkable = (bucket: readonly DuplicateInternalUnit[]): boolean => {
    if (bucket.length < 2) return false;
    if (isTarget && !bucket.some(isTarget)) return false;
    if (bucket.length > maxBucketSize) {
      let visited = 0;
      if (isTarget) walk(bucket, () => visited++);
      if (!isTarget || visited > maxBucketSize) {
        oversizedBuckets++;
        return false;
      }
    }
    return true;
  };

  const pairs = new Map<string, OracleEntry>();
  const strongEvidence = [
    ["rawHash", bucketsOf(units, (unit) => [unit.rawHash])],
    ["normalizedHash", bucketsOf(units, (unit) => [unit.normalizedHash])],
    ["astShape", bucketsOf(units, (unit) => (unit.astShapeHash === undefined ? [] : [unit.astShapeHash]))],
  ] as const;
  for (const [kind, buckets] of strongEvidence) {
    for (const bucket of buckets.values()) {
      if (!walkable(bucket)) continue;
      walk(bucket, (left, right, key) => {
        const entry = pairs.get(key);
        if (entry) {
          entry[kind] = true;
          return;
        }
        pairs.set(key, {
          left,
          right,
          rawHash: kind === "rawHash",
          normalizedHash: kind === "normalizedHash",
          astShape: kind === "astShape",
          signature: false,
          signatureMatches: 0,
          priority: 0,
        });
      });
    }
  }

  const considered = new Map<string, Set<string>>();
  const sightings = new Map<string, number>();
  const secondSighting = new Map<string, [DuplicateInternalUnit, DuplicateInternalUnit]>();
  for (const [fingerprint, bucket] of bucketsOf(units, (unit) => [...unit.signatures])) {
    if (!walkable(bucket)) continue;
    for (const unit of bucket) considered.set(unit.id, (considered.get(unit.id) ?? new Set()).add(fingerprint));
    walk(bucket, (left, right, key) => {
      const count = (sightings.get(key) ?? 0) + 1;
      sightings.set(key, count);
      if (count === 2 && !pairs.has(key) && !secondSighting.has(key)) secondSighting.set(key, [left, right]);
    });
  }
  const smallerConsidered = (left: DuplicateInternalUnit, right: DuplicateInternalUnit): number =>
    Math.min(considered.get(left.id)?.size ?? 0, considered.get(right.id)?.size ?? 0);
  const sharesEnough = (shared: number, left: DuplicateInternalUnit, right: DuplicateInternalUnit): boolean => {
    const smaller = smallerConsidered(left, right);
    return shared > 0 && smaller > 0 && shared >= Math.max(2, Math.ceil(smaller * 0.25));
  };
  for (const [key, shared] of sightings) {
    const entry = pairs.get(key);
    if (entry) {
      entry.signatureMatches = shared;
      continue;
    }
    const units = secondSighting.get(key);
    if (shared < 2 || !units || !sharesEnough(shared, units[0], units[1])) continue;
    pairs.set(key, {
      left: units[0],
      right: units[1],
      rawHash: false,
      normalizedHash: false,
      astShape: false,
      signature: false,
      signatureMatches: shared,
      priority: 0,
    });
  }
  for (const entry of pairs.values()) {
    entry.signature = sharesEnough(entry.signatureMatches, entry.left, entry.right);
    const smaller = smallerConsidered(entry.left, entry.right);
    entry.priority = smaller ? entry.signatureMatches / smaller : 0;
  }
  return { pairs: [...pairs.values()], oversizedBuckets };
}

/** A pair as a test compares it: which units, in which order, and the evidence that brought it in. */
function pairSummary(units: readonly DuplicateInternalUnit[], pair: PairEvidence | OracleEntry) {
  return {
    left: units.indexOf(pair.left),
    right: units.indexOf(pair.right),
    rawHash: pair.rawHash,
    normalizedHash: pair.normalizedHash,
    astShape: pair.astShape,
    signature: pair.signature,
    shared: pair.signature ? pair.signatureMatches : 0,
  };
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

  describe("against the original pair-by-pair walk", () => {
    const scenarios: Array<{ seed: number; maxBucketSize: number; targets: number; sharedIds: SharedIds }> = [
      { seed: 5, maxBucketSize: 200, targets: 0, sharedIds: "adjacent" },
      { seed: 6, maxBucketSize: 200, targets: 0, sharedIds: "late" },
      { seed: 16, maxBucketSize: 200, targets: 1, sharedIds: "none" },
      { seed: 8, maxBucketSize: 200, targets: 6, sharedIds: "none" },
      { seed: 9, maxBucketSize: 200, targets: 6, sharedIds: "adjacent" },
      { seed: 10, maxBucketSize: 200, targets: 6, sharedIds: "late" },
      { seed: 11, maxBucketSize: 200, targets: 30, sharedIds: "adjacent" },
      { seed: 12, maxBucketSize: 8, targets: 6, sharedIds: "adjacent" },
      { seed: 13, maxBucketSize: 4, targets: 12, sharedIds: "late" },
    ];

    test.each(scenarios)(
      "admits the same pairs in the same order, in full and over the limit (seed $seed, bucket limit $maxBucketSize, $targets target files, $sharedIds shared ids)",
      async (scenario) => {
        const units = makeVariedUnits(scenario.seed, scenario.sharedIds);
        const filter = scenario.targets ? targetFilter(units, scenario.seed, scenario.targets) : undefined;
        const expected = walkedCandidates(units, {
          maxBucketSize: scenario.maxBucketSize,
          ...(filter ? { isTarget: filter.unit } : {}),
        });

        const prepared = prepareDuplicateCandidateBuckets(units);
        const candidates = async (maxCandidatePairs: number) =>
          await buildCandidatePairs(prepared, {
            maxBucketSize: scenario.maxBucketSize,
            maxCandidatePairs,
            ...(filter ? { filter } : {}),
          });
        const result = await candidates(1_000_000);

        // Guard the scenario: it has to compare real pairs of every kind, not an empty or one-sided result.
        expect(expected.pairs.some((pair) => pair.rawHash)).toBe(true);
        expect(expected.pairs.some((pair) => !pair.rawHash && !pair.normalizedHash && !pair.astShape)).toBe(true);
        expect(units.some((unit, at) => units.findIndex((other) => other.id === unit.id) !== at)).toBe(
          scenario.sharedIds !== "none",
        );
        expect(result.skippedPairs).toBe(0);
        expect(result.oversizedBuckets).toBe(expected.oversizedBuckets);
        const summaries = (pairs: Iterable<PairEvidence | OracleEntry>) =>
          [...pairs].map((pair) => pairSummary(units, pair));
        expect(summaries(result.pairs.values())).toEqual(summaries(expected.pairs));

        // Over the limit, every pair with stronger evidence stays and the fingerprint pairs that share the largest
        // share of their buckets fill the room. Only the qualifying pairs left out count as skipped, and the pairs
        // kept stay in the order the walk meets them.
        const fingerprintOnly = expected.pairs.filter(
          (pair) => !pair.rawHash && !pair.normalizedHash && !pair.astShape,
        );
        const room = Math.ceil(fingerprintOnly.length / 2);
        expect(fingerprintOnly.length - room).toBeGreaterThan(0);
        const firstOfId = (unit: DuplicateInternalUnit) => units.findIndex((other) => other.id === unit.id);
        const kept = new Set(
          [...fingerprintOnly]
            .sort(
              (left, right) =>
                right.priority - left.priority ||
                Math.min(firstOfId(left.left), firstOfId(left.right)) -
                  Math.min(firstOfId(right.left), firstOfId(right.right)) ||
                Math.max(firstOfId(left.left), firstOfId(left.right)) -
                  Math.max(firstOfId(right.left), firstOfId(right.right)),
            )
            .slice(0, room),
        );
        const limited = await candidates(expected.pairs.length - fingerprintOnly.length + room);
        expect(limited.skippedPairs).toBe(fingerprintOnly.length - room);
        expect(summaries(limited.pairs.values())).toEqual(
          summaries(expected.pairs.filter((pair) => !fingerprintOnly.includes(pair) || kept.has(pair))),
        );
      },
    );
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

    test("counts a targeted run's skipped pairs once per kind of evidence, however small the limit", async () => {
      const isTarget = (unit: DuplicateInternalUnit) => unit.file === "src/near-0.ts";
      const filter = {
        unit: isTarget,
        pair: (left: DuplicateInternalUnit, right: DuplicateInternalUnit) => isTarget(left) || isTarget(right),
      };
      const run = async (maxCandidatePairs: number) =>
        await buildCandidatePairs(prepareDuplicateCandidateBuckets(units), { ...options, maxCandidatePairs, filter });

      const all = await run(1_000_000);
      const limited = await run(1);

      const dropped = all.pairs.size - limited.pairs.size;
      // Identical text, identical normalized tokens, identical AST shape, and shared fingerprints each propose a pair.
      const evidenceKinds = 4;
      expect(all.skippedPairs).toBe(0);
      expect(limited.pairs.size).toBe(1);
      expect(dropped).toBeGreaterThan(0);
      expect(limited.skippedPairs).toBeGreaterThanOrEqual(dropped);
      expect(limited.skippedPairs).toBeLessThanOrEqual(dropped * evidenceKinds);
    });

    test("a targeted run keeps the fingerprint pairs that share the largest fraction too", async () => {
      const isTarget = (unit: DuplicateInternalUnit) => unit.file === "src/near-2.ts" || unit.file === "src/near-4.ts";
      const filter: CandidateFilter = { unit: isTarget, pair: (left, right) => isTarget(left) || isTarget(right) };
      const reference = walkedCandidates(units, { maxBucketSize: options.maxBucketSize, isTarget }).pairs;
      const strong = reference.filter((pair) => pair.rawHash || pair.normalizedHash || pair.astShape);
      const fingerprintOnly = reference.filter((pair) => !pair.rawHash && !pair.normalizedHash && !pair.astShape);
      expect(fingerprintOnly.length).toBeGreaterThan(3);

      const limited = await buildCandidatePairs(prepareDuplicateCandidateBuckets(units), {
        ...options,
        maxCandidatePairs: strong.length + 2,
        filter,
      });

      const keptKeys = new Set(
        [...limited.pairs.values()]
          .filter((pair) => !pair.rawHash && !pair.normalizedHash && !pair.astShape)
          .map((pair) => idPair(pair.left, pair.right)),
      );
      expect(keptKeys.size).toBe(2);
      // Each pair skipped after it qualified counts once; pairs that never qualified count for nothing.
      expect(limited.skippedPairs).toBe(fingerprintOnly.length - 2);
      const kept = fingerprintOnly.filter((pair) => keptKeys.has(idPair(pair.left, pair.right)));
      const skipped = fingerprintOnly.filter((pair) => !keptKeys.has(idPair(pair.left, pair.right)));
      expect(Math.min(...kept.map((pair) => pair.priority))).toBeGreaterThanOrEqual(
        Math.max(...skipped.map((pair) => pair.priority)),
      );
    });
  });

  describe("a targeted run where many pairs share only one fingerprint", () => {
    // 1,300 target units and 1,301 other units share one fingerprint bucket: more pairs than the default limit, each
    // sharing a single bucket, so none can ever qualify. They are met before everything below, so a count table that
    // filled up with them would drop the pairs that follow although the limit is still free.
    const TARGETS = 1_300;
    const OTHERS = 1_301;
    const bareUnit = (file: string, signatures: readonly string[], rawHash = `raw:${file}`): DuplicateInternalUnit => ({
      file,
      startLine: 1,
      endLine: 10,
      languageId: "typescript",
      kind: "chunk",
      tokenCount: 50,
      handle: `chunk:${file}:1`,
      fileHandle: `file:${file}`,
      chunkHandle: `chunk:${file}:1`,
      id: `/repo/${file}:1:10:chunk:`,
      absoluteFile: `/repo/${file}`,
      rawHash,
      normalizedHash: `normalized:${file}`,
      tokenSet: new Set(),
      signatures: new Set(signatures),
    });
    const isTarget = (unit: DuplicateInternalUnit) => unit.file.includes("-target");
    const filter: CandidateFilter = { unit: isTarget, pair: (left, right) => isTarget(left) || isTarget(right) };
    const crowd = (name: string, count: number) =>
      Array.from({ length: count }, (_, at) => bareUnit(`src/${name}-${at}.ts`, ["crowd"]));
    const units = [
      ...crowd("crowd-target", TARGETS),
      ...crowd("crowd-other", OTHERS),
      // Two buckets in common: the pair qualifies, and it first shows up after the crowd.
      bareUnit("src/late-target.ts", ["late-1", "late-2"]),
      bareUnit("src/late-other.ts", ["late-1", "late-2"]),
      // Identical text brings this pair in; two buckets in common add fingerprint evidence, again after the crowd.
      bareUnit("src/kept-target.ts", ["kept-1", "kept-2"], "same text"),
      bareUnit("src/kept-other.ts", ["kept-1", "kept-2"], "same text"),
    ];
    const runs = new Map<number, Promise<CandidatePairResult>>();
    const crowded = (maxCandidatePairs: number): Promise<CandidatePairResult> => {
      let run = runs.get(maxCandidatePairs);
      if (!run) {
        run = buildCandidatePairs(prepareDuplicateCandidateBuckets(units), {
          maxBucketSize: 5_000,
          maxCandidatePairs,
          filter,
        });
        runs.set(maxCandidatePairs, run);
      }
      return run;
    };
    const pairOf = (result: CandidatePairResult, name: string): PairEvidence | undefined =>
      [...result.pairs.values()].find((pair) => pair.left.file.includes(name));

    test("the crowd has more pairs than the default candidate pair limit", () => {
      expect(TARGETS * OTHERS + (TARGETS * (TARGETS - 1)) / 2).toBeGreaterThan(DEFAULT_MAX_CANDIDATE_PAIRS);
    });

    test(
      "still finds a pair that qualifies after them, and counts nothing as skipped",
      { timeout: 60_000 },
      async () => {
        const result = await crowded(DEFAULT_MAX_CANDIDATE_PAIRS);

        const late = pairOf(result, "late");
        expect(result.pairs.size).toBe(2);
        expect(late).toMatchObject({ signature: true, signatureMatches: 2, rawHash: false });
        expect(result.skippedPairs).toBe(0);
      },
    );

    test("keeps the fingerprint evidence of a pair that identical text brought in", { timeout: 60_000 }, async () => {
      const result = await crowded(DEFAULT_MAX_CANDIDATE_PAIRS);

      expect(pairOf(result, "kept")).toMatchObject({ rawHash: true, signature: true, signatureMatches: 2 });
    });

    test("counts a pair against the limit only once it qualifies", { timeout: 60_000 }, async () => {
      const result = await crowded(1);

      // The identical-text pair fills the limit, so the pair that qualifies afterwards is the only one skipped.
      expect(result.pairs.size).toBe(1);
      expect(pairOf(result, "kept")).toMatchObject({ rawHash: true, signature: true, signatureMatches: 2 });
      expect(result.skippedPairs).toBe(1);
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

  test("a count-only run adds the skipped candidate pairs to the pairs it leaves unscored", async () => {
    const root = await makeClonedProject(4);
    const index = await buildProjectIndex(root);

    const result = await findDuplicates(index, { countOnly: true, maxCandidatePairs: 2 });

    const skipped = result.stats.candidatePairBudget?.skipped ?? 0;
    expect(skipped).toBeGreaterThan(0);
    expect(result.stats.comparedPairs).toBe(0);
    expect(result.omittedCounts.candidatePairs).toBeGreaterThanOrEqual(skipped);
    expect(result.omittedCounts.candidatePairs).toBeLessThanOrEqual(skipped + result.stats.candidatePairs);
  });

  test("a duplicate context reports the candidate pairs the limit skipped, like the whole-project result", async () => {
    const root = await makeClonedProject(4);
    const index = await buildProjectIndex(root);
    const target = { file: "src/copy0.ts" };

    const unlimited = await findDuplicateContext(index, target, { minConfidence: "high", limit: 5 });
    const limited = await findDuplicateContext(index, target, {
      minConfidence: "high",
      limit: 5,
      maxCandidatePairs: 1,
    });

    expect(unlimited.stats.candidatePairBudget).toBeUndefined();
    expect(unlimited.omittedCounts.candidatePairs).toBe(0);
    expect(limited.stats.candidatePairBudget?.limit).toBe(1);
    expect(limited.stats.candidatePairBudget?.skipped).toBeGreaterThan(0);
    expect(limited.omittedCounts.candidatePairs).toBe(limited.stats.candidatePairBudget?.skipped);
  });

  test("a duplicate context adds the pairs the limit skipped to the pairs maxPairs left uncompared", async () => {
    const root = await makeClonedProject(4);
    const index = await buildProjectIndex(root);

    const result = await findDuplicateContext(
      index,
      { file: "src/copy0.ts" },
      { minConfidence: "high", limit: 5, maxPairs: 0, maxCandidatePairs: 3 },
    );

    const skippedByLimit = result.stats.candidatePairBudget?.skipped ?? 0;
    expect(result.stats.comparedPairs).toBe(0);
    expect(result.stats.candidatePairs).toBeGreaterThan(0);
    expect(skippedByLimit).toBeGreaterThan(0);
    expect(result.omittedCounts.candidatePairs).toBe(result.stats.candidatePairs + skippedByLimit);
  });

  test("duplicate contexts for several targets share one limit and each report its skips", async () => {
    const root = await makeClonedProject(4);
    const index = await buildProjectIndex(root);

    const contexts = await findDuplicateContexts(index, [{ file: "src/copy0.ts" }, { file: "src/copy1.ts" }], {
      minConfidence: "high",
      limit: 5,
      maxCandidatePairs: 2,
    });

    expect(contexts).toHaveLength(2);
    for (const context of contexts) {
      expect(context.stats.candidatePairBudget?.limit).toBe(2);
      expect(context.stats.candidatePairBudget?.skipped).toBeGreaterThan(0);
      expect(context.omittedCounts.candidatePairs).toBe(context.stats.candidatePairBudget?.skipped);
    }
    expect(contexts[1]?.stats.candidatePairBudget).toEqual(contexts[0]?.stats.candidatePairBudget);
  });

  test("a prepared analysis reports the same skipped candidate pairs as a direct call", async () => {
    const root = await makeClonedProject(4);
    const index = await buildProjectIndex(root);
    const prepared = await prepareDuplicateAnalysis(index);
    const targets = [{ file: "src/copy0.ts" }, { file: "src/copy2.ts" }];
    const options = { minConfidence: "high", limit: 5, maxCandidatePairs: 2 } as const;

    const direct = await findDuplicateContexts(index, targets, options);
    const viaPrepared = await findDuplicateContextsWithPreparedAnalysis(prepared, targets, options);
    const wholeProject = await findDuplicates(index, options);
    const wholeProjectViaPrepared = await findDuplicatesWithPreparedAnalysis(prepared, options);

    expect(direct[0]?.omittedCounts.candidatePairs).toBeGreaterThan(0);
    expect(viaPrepared).toEqual(direct);
    expect(wholeProject.omittedCounts.candidatePairs).toBeGreaterThan(0);
    expect(wholeProjectViaPrepared).toEqual(wholeProject);
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

  test("duplicates CLI paints every duplicate stage on an interactive terminal, even when each ends at once", async () => {
    const root = await makeClonedProject(3);

    const result = await captureCli(
      ["duplicates", "--root", ".", "src", "--json", "--min-confidence", "high", "--progress"],
      { cwd: root, stderrIsTTY: true, terminalSupportsControlSequences: true },
    );

    // A stage that finishes before the refresh timer fires can only be shown by painting when the stage changes.
    const stages = [
      "Collecting duplicate units... ",
      "Finding candidate pairs... ",
      "Scoring candidate pairs... ",
      "Grouping duplicate findings... ",
      "Detected duplicates: ",
    ].map((stage) => result.stderr.indexOf(stage));
    expect(stages.every((at) => at >= 0)).toBe(true);
    expect([...stages].sort((left, right) => left - right)).toEqual(stages);
    expect(result.stderr).not.toContain("[Progress]");
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });
});
