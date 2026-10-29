import { appendToArrayMap } from "../util/collections.js";
import { compareUnitRefs, isScorablePair } from "./scoring.js";
import { normalizeDetectionFile } from "./units.js";
import type {
  DuplicateInternalUnit,
  DuplicateSimilarityHint,
  PairEvidence,
  PairFilter,
  PreparedDuplicateBuckets,
  UnitFilter,
} from "./types.js";

const MIN_SIMILARITY_HINT_INDEX = 80;

/**
 * Targeted analysis: only pairs that touch a target unit are candidates. Both predicates depend on a unit's id alone,
 * so all the units of one id are targets, or none is.
 */
export type CandidateFilter = {
  unit: UnitFilter;
  pair: PairFilter;
};

export type CandidatePairOptions = {
  maxBucketSize: number;
  /**
   * Upper bound on pairs kept. A pair the scorers can score that has the evidence to be a candidate but does not fit is
   * skipped and counted.
   */
  maxCandidatePairs: number;
  /** Whether the scorers skip two units of one file, which decides which pairs they can score. */
  crossFileOnly: boolean;
  similarityHints?: readonly DuplicateSimilarityHint[] | undefined;
  projectRoot?: string | undefined;
  filter?: CandidateFilter | undefined;
  /** Reports how many units the fingerprint pass has paired. */
  onFingerprintProgress?: ((current: number, total: number) => void) | undefined;
  /** Returns a promise when a long pass should let the event loop turn. */
  yieldPoint?: (() => Promise<void> | undefined) | undefined;
};

export type CandidatePairResult = {
  /** Kept pairs the scorers can score, keyed by a number derived from the unit ids, in the order evidence was admitted. */
  pairs: Map<number, PairEvidence>;
  oversizedBuckets: number;
  /**
   * Candidate pairs the scorers can score that were dropped because `maxCandidatePairs` was reached. Only pairs with the
   * evidence to be candidates count, and a pair that several kinds of evidence propose counts once per kind.
   */
  skippedPairs: number;
  /**
   * Pairs with the evidence to be candidates that the scorers can never score: two units of one file in a cross-file run,
   * and two units that overlap. They take no slot and are never skipped. Each counts once, but only up to
   * `maxCandidatePairs`, so a run with more of them reports a lower bound.
   */
  unscorablePairs: number;
  /**
   * How many of those the scorers report as overlapping. A cross-file run skips two units of one file before it compares
   * their lines, so it reports none.
   */
  overlappingPairs: number;
};

type StrongEvidenceKind = "rawHash" | "normalizedHash" | "astShape";

/** Groups units by cheap fingerprints before expensive pair scoring. */
export function prepareDuplicateCandidateBuckets(units: readonly DuplicateInternalUnit[]): PreparedDuplicateBuckets {
  const rawHashBuckets = new Map<string, DuplicateInternalUnit[]>();
  const normalizedHashBuckets = new Map<string, DuplicateInternalUnit[]>();
  const astShapeBuckets = new Map<string, DuplicateInternalUnit[]>();
  const signatureBuckets = new Map<string, DuplicateInternalUnit[]>();

  for (const unit of units) {
    const languagePrefix = `${unit.languageId}:`;
    appendToArrayMap(rawHashBuckets, `${languagePrefix}${unit.rawHash}`, unit);
    appendToArrayMap(normalizedHashBuckets, `${languagePrefix}${unit.normalizedHash}`, unit);
    if (unit.astShapeHash !== undefined) {
      appendToArrayMap(astShapeBuckets, `${languagePrefix}${unit.astShapeHash}`, unit);
    }
    for (const signature of unit.signatures) {
      appendToArrayMap(signatureBuckets, `${languagePrefix}${signature}`, unit);
    }
  }

  return {
    units,
    rawHashBuckets,
    normalizedHashBuckets,
    astShapeBuckets,
    signatureBuckets,
  };
}

function filterPreparedDuplicateBucketMap(
  buckets: ReadonlyMap<string, DuplicateInternalUnit[]>,
  unitFilter: UnitFilter,
): Map<string, DuplicateInternalUnit[]> {
  const filteredBuckets = new Map<string, DuplicateInternalUnit[]>();
  for (const [key, bucket] of buckets) {
    const filteredBucket = bucket.filter(unitFilter);
    if (filteredBucket.length) filteredBuckets.set(key, filteredBucket);
  }
  return filteredBuckets;
}

export function filterPreparedDuplicateBuckets(
  preparedBuckets: PreparedDuplicateBuckets,
  unitFilter: UnitFilter,
): PreparedDuplicateBuckets {
  return {
    units: preparedBuckets.units.filter(unitFilter),
    rawHashBuckets: filterPreparedDuplicateBucketMap(preparedBuckets.rawHashBuckets, unitFilter),
    normalizedHashBuckets: filterPreparedDuplicateBucketMap(preparedBuckets.normalizedHashBuckets, unitFilter),
    astShapeBuckets: filterPreparedDuplicateBucketMap(preparedBuckets.astShapeBuckets, unitFilter),
    signatureBuckets: filterPreparedDuplicateBucketMap(preparedBuckets.signatureBuckets, unitFilter),
  };
}

/**
 * Gives every unit a position and every unit id a canonical position, so a pair is one number.
 *
 * Unit ids are not unique: a long text line splits into chunks that share one range and name, and
 * pair identity has always followed the id. The canonical position is the first unit with that id.
 */
type UnitIndex = {
  units: readonly DuplicateInternalUnit[];
  positions: Map<DuplicateInternalUnit, number>;
  canon: Int32Array;
  hasSharedIds: boolean;
};

function createUnitIndex(units: readonly DuplicateInternalUnit[]): UnitIndex {
  const positions = new Map<DuplicateInternalUnit, number>();
  const firstById = new Map<string, number>();
  const canon = new Int32Array(units.length);
  let hasSharedIds = false;
  for (let position = 0; position < units.length; position++) {
    const unit = units[position]!;
    positions.set(unit, position);
    const first = firstById.get(unit.id);
    if (first === undefined) {
      firstById.set(unit.id, position);
      canon[position] = position;
    } else {
      canon[position] = first;
      hasSharedIds = true;
    }
  }
  return { units, positions, canon, hasSharedIds };
}

function positionOf(index: UnitIndex, unit: DuplicateInternalUnit): number {
  const position = index.positions.get(unit);
  if (position === undefined) throw new Error(`Duplicate unit ${unit.id} is not part of the prepared candidates.`);
  return position;
}

function canonOf(index: UnitIndex, unit: DuplicateInternalUnit): number {
  return index.canon[positionOf(index, unit)]!;
}

/** The pair identity for two canonical positions. Positions stay below 2^26, so the number is exact. */
function pairNumber(index: UnitIndex, left: number, right: number): number {
  const radix = index.units.length;
  return left <= right ? left * radix + right : right * radix + left;
}

type PairState = {
  index: UnitIndex;
  crossFileOnly: boolean;
  /** The kept pairs, every one of them a pair the scorers can score. */
  pairs: Map<number, PairEvidence>;
  /** The pairs the scorers can never score that had the evidence to be candidates, tallied up to the limit. */
  unscorable: Set<number>;
  limit: number;
  skipped: number;
};

export function orderedPair(
  left: DuplicateInternalUnit,
  right: DuplicateInternalUnit,
): [DuplicateInternalUnit, DuplicateInternalUnit] {
  if (left.absoluteFile < right.absoluteFile) return [left, right];
  if (left.absoluteFile > right.absoluteFile) return [right, left];
  if (left.startLine <= right.startLine) return [left, right];
  return [right, left];
}

function blankEvidence(left: DuplicateInternalUnit, right: DuplicateInternalUnit): PairEvidence {
  return { left, right, rawHash: false, normalizedHash: false, astShape: false, signature: false, signatureMatches: 0 };
}

/** Tallies a pair the scorers can never score, once, while the tally has room. */
function tallyUnscorable(state: PairState, key: number): void {
  if (state.unscorable.size < state.limit) state.unscorable.add(key);
}

/**
 * Where a pair that has the evidence to be a candidate goes. A pair already kept is returned to gain the evidence. A pair
 * the scorers can never score is only tallied, so it never takes a slot from one they can. Any other pair takes a slot
 * while one is free and counts as skipped when none is. Returns the evidence to complete, or nothing when the pair is
 * not kept.
 */
function takePair(
  state: PairState,
  key: number,
  first: DuplicateInternalUnit,
  second: DuplicateInternalUnit,
): PairEvidence | undefined {
  const existing = state.pairs.get(key);
  if (existing) return existing;
  if (!isScorablePair(first, second, state.crossFileOnly)) {
    tallyUnscorable(state, key);
    return undefined;
  }
  if (state.pairs.size >= state.limit) {
    state.skipped++;
    return undefined;
  }
  const [left, right] = orderedPair(first, second);
  const evidence = blankEvidence(left, right);
  state.pairs.set(key, evidence);
  return evidence;
}

function addStrongEvidence(
  state: PairState,
  kind: StrongEvidenceKind,
  first: DuplicateInternalUnit,
  second: DuplicateInternalUnit,
  key: number,
): void {
  const evidence = takePair(state, key, first, second);
  if (evidence) evidence[kind] = true;
}

/** Visits each pair that touches a target unit once per bucket, target first. */
function forEachFilteredBucketPair(
  index: UnitIndex,
  bucket: readonly DuplicateInternalUnit[],
  filter: CandidateFilter,
  visit: (left: DuplicateInternalUnit, right: DuplicateInternalUnit, key: number) => void,
): void {
  const targetUnits = bucket.filter(filter.unit);
  const seenPairs = new Set<number>();
  for (const targetUnit of targetUnits) {
    const targetCanon = canonOf(index, targetUnit);
    for (const otherUnit of bucket) {
      if (targetUnit.id === otherUnit.id) continue;
      const [left, right] = orderedPair(targetUnit, otherUnit);
      const key = pairNumber(index, targetCanon, canonOf(index, otherUnit));
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      if (!filter.pair(left, right)) continue;
      visit(left, right, key);
    }
  }
}

function filteredPairCountExceeds(
  index: UnitIndex,
  bucket: readonly DuplicateInternalUnit[],
  limit: number,
  filter: CandidateFilter,
): boolean {
  let count = 0;
  const targetUnits = bucket.filter(filter.unit);
  if (!targetUnits.length) return false;
  const seenPairs = new Set<number>();
  for (const targetUnit of targetUnits) {
    const targetCanon = canonOf(index, targetUnit);
    for (const otherUnit of bucket) {
      if (targetUnit.id === otherUnit.id) continue;
      const [left, right] = orderedPair(targetUnit, otherUnit);
      const key = pairNumber(index, targetCanon, canonOf(index, otherUnit));
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      if (!filter.pair(left, right)) continue;
      count++;
      if (count > limit) return true;
    }
  }
  return false;
}

type BucketVerdict = "skip" | "oversized" | "pair";

/** A bucket is paired when it is small enough, or when a targeted run touches few enough of its pairs. */
function classifyBucket(
  index: UnitIndex,
  bucket: readonly DuplicateInternalUnit[],
  maxBucketSize: number,
  filter: CandidateFilter | undefined,
): BucketVerdict {
  if (bucket.length < 2) return "skip";
  if (filter && !bucket.some(filter.unit)) return "skip";
  if (bucket.length > maxBucketSize) {
    if (!filter || filteredPairCountExceeds(index, bucket, maxBucketSize, filter)) return "oversized";
  }
  return "pair";
}

/** Adds one shared-evidence bucket in the order its pairs were always visited. */
function addBucketPairs(
  state: PairState,
  bucket: readonly DuplicateInternalUnit[],
  kind: StrongEvidenceKind,
  filter: CandidateFilter | undefined,
): void {
  const { index } = state;
  if (filter) {
    forEachFilteredBucketPair(index, bucket, filter, (left, right, key) => {
      addStrongEvidence(state, kind, left, right, key);
    });
    return;
  }
  const canons = new Int32Array(bucket.length);
  for (let i = 0; i < bucket.length; i++) canons[i] = canonOf(index, bucket[i]!);
  for (let i = 0; i < bucket.length; i++) {
    for (let j = i + 1; j < bucket.length; j++) {
      addStrongEvidence(state, kind, bucket[i]!, bucket[j]!, pairNumber(index, canons[i]!, canons[j]!));
    }
  }
}

async function addEvidenceBuckets(
  state: PairState,
  buckets: ReadonlyMap<string, DuplicateInternalUnit[]>,
  kind: StrongEvidenceKind,
  options: CandidatePairOptions,
): Promise<number> {
  let oversizedBuckets = 0;
  for (const bucket of buckets.values()) {
    const verdict = classifyBucket(state.index, bucket, options.maxBucketSize, options.filter);
    if (verdict === "skip") continue;
    if (verdict === "oversized") {
      oversizedBuckets++;
      continue;
    }
    addBucketPairs(state, bucket, kind, options.filter);
    const pending = options.yieldPoint?.();
    if (pending) await pending;
  }
  return oversizedBuckets;
}

/** Requires enough shared fingerprints to avoid incidental syntax matches. */
function hasEnoughFingerprints(sharedFingerprints: number, smallerConsideredCount: number): boolean {
  if (!sharedFingerprints || !smallerConsideredCount) return false;
  return sharedFingerprints >= Math.max(2, Math.ceil(smallerConsideredCount * 0.25));
}

/** Keeps the best few pairs seen: the worst kept pair sits at the root so a better one can replace it. */
class BestPairs {
  size = 0;
  private priority: Float64Array;
  private first: Int32Array;
  private second: Int32Array;
  private matches: Int32Array;

  constructor(private readonly capacity: number) {
    const initial = Math.min(capacity, 1024);
    this.priority = new Float64Array(initial);
    this.first = new Int32Array(initial);
    this.second = new Int32Array(initial);
    this.matches = new Int32Array(initial);
  }

  /** Better means more of the smaller unit's fingerprints shared, then the earlier unit ids. */
  private isWorse(a: number, b: number): boolean {
    if (this.priority[a]! !== this.priority[b]!) return this.priority[a]! < this.priority[b]!;
    if (this.first[a]! !== this.first[b]!) return this.first[a]! > this.first[b]!;
    return this.second[a]! > this.second[b]!;
  }

  private swap(a: number, b: number): void {
    const priority = this.priority[a]!;
    this.priority[a] = this.priority[b]!;
    this.priority[b] = priority;
    const first = this.first[a]!;
    this.first[a] = this.first[b]!;
    this.first[b] = first;
    const second = this.second[a]!;
    this.second[a] = this.second[b]!;
    this.second[b] = second;
    const matches = this.matches[a]!;
    this.matches[a] = this.matches[b]!;
    this.matches[b] = matches;
  }

  private grow(): void {
    const next = Math.min(this.capacity, this.priority.length * 2);
    const priority = new Float64Array(next);
    priority.set(this.priority);
    this.priority = priority;
    for (const name of ["first", "second", "matches"] as const) {
      const grown = new Int32Array(next);
      grown.set(this[name]);
      this[name] = grown;
    }
  }

  private siftUp(start: number): void {
    let slot = start;
    while (slot > 0) {
      const parent = (slot - 1) >> 1;
      if (!this.isWorse(slot, parent)) return;
      this.swap(slot, parent);
      slot = parent;
    }
  }

  private siftDown(start: number): void {
    let slot = start;
    for (;;) {
      const left = slot * 2 + 1;
      const right = left + 1;
      let worst = slot;
      if (left < this.size && this.isWorse(left, worst)) worst = left;
      if (right < this.size && this.isWorse(right, worst)) worst = right;
      if (worst === slot) return;
      this.swap(slot, worst);
      slot = worst;
    }
  }

  /** Whether a pair ranks above the worst pair kept, by the same order `isWorse` uses. */
  private beatsWorst(priority: number, first: number, second: number): boolean {
    if (priority !== this.priority[0]!) return priority > this.priority[0]!;
    if (first !== this.first[0]!) return first < this.first[0]!;
    return second < this.second[0]!;
  }

  offer(priority: number, first: number, second: number, matches: number): void {
    if (!this.capacity) return;
    if (this.size === this.capacity) {
      if (!this.beatsWorst(priority, first, second)) return;
      this.priority[0] = priority;
      this.first[0] = first;
      this.second[0] = second;
      this.matches[0] = matches;
      this.siftDown(0);
      return;
    }
    if (this.size === this.priority.length) this.grow();
    const slot = this.size++;
    this.priority[slot] = priority;
    this.first[slot] = first;
    this.second[slot] = second;
    this.matches[slot] = matches;
    this.siftUp(slot);
  }

  entries(): Array<{ first: number; second: number; matches: number }> {
    const entries: Array<{ first: number; second: number; matches: number }> = [];
    for (let slot = 0; slot < this.size; slot++) {
      entries.push({ first: this.first[slot]!, second: this.second[slot]!, matches: this.matches[slot]! });
    }
    return entries;
  }
}

/** Buckets whose pairs count toward fingerprint evidence, and how many were too large. */
function eligibleFingerprintBuckets(
  state: PairState,
  buckets: ReadonlyMap<string, DuplicateInternalUnit[]>,
  options: CandidatePairOptions,
): { eligible: Array<readonly DuplicateInternalUnit[]>; oversizedBuckets: number } {
  const eligible: Array<readonly DuplicateInternalUnit[]> = [];
  let oversizedBuckets = 0;
  for (const bucket of buckets.values()) {
    const verdict = classifyBucket(state.index, bucket, options.maxBucketSize, options.filter);
    if (verdict === "skip") continue;
    if (verdict === "oversized") {
      oversizedBuckets++;
      continue;
    }
    eligible.push(bucket);
  }
  return { eligible, oversizedBuckets };
}

/**
 * The eligible fingerprint buckets flattened into typed arrays, so counting the buckets two units share needs no object
 * per pair.
 */
type FingerprintLayout = {
  /** The members of bucket `b` are the slots `bucketStart[b]` up to `bucketStart[b + 1]`, in unit order. */
  bucketStart: Int32Array;
  /** Where the visits of a bucket begin in a walk of all buckets: the squared sizes of the buckets before it. */
  rankBase: Float64Array;
  /** The unit position and the canonical unit of each member slot. */
  memberUnit: Int32Array;
  memberCanon: Int32Array;
  /**
   * The member slots of canonical unit `u`, in bucket order, are `entryMember` from `entryStart[u]` up to
   * `entryStart[u + 1]`; `entryBucket` holds the bucket of each.
   */
  entryStart: Int32Array;
  entryMember: Int32Array;
  entryBucket: Int32Array;
  /** How many eligible buckets each canonical unit is in. */
  consideredCount: Int32Array;
};

function layoutFingerprintBuckets(
  index: UnitIndex,
  eligible: ReadonlyArray<readonly DuplicateInternalUnit[]>,
): FingerprintLayout {
  const unitCount = index.units.length;
  const bucketCount = eligible.length;

  const bucketStart = new Int32Array(bucketCount + 1);
  const rankBase = new Float64Array(bucketCount);
  let total = 0;
  let rank = 0;
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const size = eligible[bucket]!.length;
    bucketStart[bucket] = total;
    rankBase[bucket] = rank;
    total += size;
    rank += size * size;
  }
  bucketStart[bucketCount] = total;

  const memberUnit = new Int32Array(total);
  const memberCanon = new Int32Array(total);
  const entryStart = new Int32Array(unitCount + 1);
  const consideredCount = new Int32Array(unitCount);
  const lastBucket = new Int32Array(unitCount).fill(-1);
  for (let bucket = 0, member = 0; bucket < bucketCount; bucket++) {
    for (const unit of eligible[bucket]!) {
      const position = positionOf(index, unit);
      const unitCanon = index.canon[position]!;
      memberUnit[member] = position;
      memberCanon[member] = unitCanon;
      member++;
      entryStart[unitCanon + 1] = entryStart[unitCanon + 1]! + 1;
      if (lastBucket[unitCanon] !== bucket) {
        lastBucket[unitCanon] = bucket;
        consideredCount[unitCanon] = consideredCount[unitCanon]! + 1;
      }
    }
  }
  for (let unit = 0; unit < unitCount; unit++) entryStart[unit + 1] = entryStart[unit + 1]! + entryStart[unit]!;

  const entryMember = new Int32Array(total);
  const entryBucket = new Int32Array(total);
  const nextEntry = entryStart.slice(0, unitCount);
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    for (let member = bucketStart[bucket]!; member < bucketStart[bucket + 1]!; member++) {
      const unitCanon = memberCanon[member]!;
      const slot = nextEntry[unitCanon]!;
      nextEntry[unitCanon] = slot + 1;
      entryMember[slot] = member;
      entryBucket[slot] = bucket;
    }
  }
  return { bucketStart, rankBase, memberUnit, memberCanon, entryStart, entryMember, entryBucket, consideredCount };
}

/** Where a pair is admitted, and the units it is admitted with: the walk that first meets the pair fixes both. */
type PairVisit = { rank: number; left: DuplicateInternalUnit; right: DuplicateInternalUnit };

/**
 * Decides which pairs that share fingerprint buckets become candidates, for the whole project and for a targeted run
 * alike. A pair qualifies when it shares at least two eligible buckets and a quarter of the smaller unit's. One that
 * already has stronger evidence only gains the fingerprint evidence, and one the scorers can never score is only
 * tallied. The rest compete for the room the limit leaves, the pairs that share the largest fraction of their buckets
 * first, and only a qualifying pair that does not fit counts as skipped.
 */
class FingerprintSelection {
  private readonly best: BestPairs;
  private qualifying = 0;

  constructor(
    private readonly state: PairState,
    private readonly layout: FingerprintLayout,
    private readonly pairFilter: PairFilter | undefined,
  ) {
    this.best = new BestPairs(Math.max(0, state.limit - state.pairs.size));
  }

  /** Takes two canonical units that share `count` eligible buckets; fewer than two cannot qualify. */
  consider(first: number, second: number, count: number): void {
    if (count < 2) return;
    const { index, pairs } = this.state;
    const smaller = Math.min(this.layout.consideredCount[first]!, this.layout.consideredCount[second]!);
    if (!hasEnoughFingerprints(count, smaller)) return;
    const firstUnit = index.units[first]!;
    const secondUnit = index.units[second]!;
    if (this.pairFilter) {
      const [left, right] = orderedPair(firstUnit, secondUnit);
      if (!this.pairFilter(left, right)) return;
    }
    const key = pairNumber(index, first, second);
    const existing = pairs.get(key);
    if (existing) {
      existing.signatureMatches = count;
      existing.signature = true;
      return;
    }
    if (!isScorablePair(firstUnit, secondUnit, this.state.crossFileOnly)) {
      tallyUnscorable(this.state, key);
      return;
    }
    this.qualifying++;
    this.best.offer(count / smaller, Math.min(first, second), Math.max(first, second), count);
  }

  /** Adds the kept pairs in the order a walk of the buckets would first have met them, and counts the rest skipped. */
  admit(visitOf: (first: number, second: number) => PairVisit): void {
    const { index, pairs } = this.state;
    const admissions = this.best.entries().map(({ first, second, matches }) => ({
      ...visitOf(first, second),
      key: pairNumber(index, first, second),
      count: matches,
    }));
    admissions.sort((left, right) => left.rank - right.rank);
    for (const admission of admissions) {
      pairs.set(admission.key, {
        left: admission.left,
        right: admission.right,
        rawHash: false,
        normalizedHash: false,
        astShape: false,
        signature: true,
        signatureMatches: admission.count,
      });
    }
    this.state.skipped += this.qualifying - admissions.length;
  }
}

/**
 * Where a pair-by-pair walk of every bucket first meets two canonical units, and the units of its second visit. The walk
 * visits each pair of a bucket in unit order, and units that share an id can meet more than once in one bucket.
 */
function wholeProjectVisit(
  layout: FingerprintLayout,
  units: readonly DuplicateInternalUnit[],
  first: number,
  second: number,
): PairVisit {
  const { bucketStart, rankBase, memberUnit, entryStart, entryMember, entryBucket } = layout;
  const visits: Array<{ rank: number; low: number; high: number }> = [];
  let a = entryStart[first]!;
  const aEnd = entryStart[first + 1]!;
  let b = entryStart[second]!;
  const bEnd = entryStart[second + 1]!;
  while (a < aEnd && b < bEnd && visits.length < 2) {
    const bucketA = entryBucket[a]!;
    const bucketB = entryBucket[b]!;
    if (bucketA < bucketB) {
      a++;
      continue;
    }
    if (bucketB < bucketA) {
      b++;
      continue;
    }
    let aNext = a;
    while (aNext < aEnd && entryBucket[aNext] === bucketA) aNext++;
    let bNext = b;
    while (bNext < bEnd && entryBucket[bNext] === bucketA) bNext++;
    const start = bucketStart[bucketA]!;
    const size = bucketStart[bucketA + 1]! - start;
    for (let x = a; x < aNext; x++) {
      for (let y = b; y < bNext; y++) {
        if (first === second && y <= x) continue;
        const low = Math.min(entryMember[x]!, entryMember[y]!);
        const high = Math.max(entryMember[x]!, entryMember[y]!);
        visits.push({ rank: rankBase[bucketA]! + (low - start) * size + (high - start), low, high });
      }
    }
    a = aNext;
    b = bNext;
  }
  visits.sort((left, right) => left.rank - right.rank);
  const firstVisit = visits[0]!;
  const secondVisit = visits[1]!;
  const [left, right] = orderedPair(units[memberUnit[secondVisit.low]!]!, units[memberUnit[secondVisit.high]!]!);
  return { rank: firstVisit.rank, left, right };
}

/**
 * Fingerprint evidence for the whole project.
 *
 * Every unit counts, per other unit, the eligible buckets they share, using one counter per unit instead of a table
 * of all pairs that share a fingerprint. The kept pairs are then admitted in the order a pair-by-pair walk of the
 * buckets would have first met them.
 */
async function addProjectFingerprintPairs(
  state: PairState,
  layout: FingerprintLayout,
  options: CandidatePairOptions,
): Promise<void> {
  const { index } = state;
  const unitCount = index.units.length;
  const { bucketStart, memberUnit, memberCanon, entryStart, entryMember, entryBucket } = layout;
  const selection = new FingerprintSelection(state, layout, undefined);
  const sharedBuckets = new Int32Array(unitCount);
  const touched = new Int32Array(unitCount);
  const sharesIds = index.hasSharedIds;
  const reportEvery = Math.max(1, Math.floor(unitCount / 100));

  for (let unit = 0; unit < unitCount; unit++) {
    const firstEntry = entryStart[unit]!;
    const lastEntry = entryStart[unit + 1]!;
    let touchedCount = 0;
    // A visit between two bucket members belongs to the lower canonical unit. Units that share an id
    // can sit on either side of a visit, so a later copy also looks at the members before it.
    const lowestPartner = sharesIds ? unit : 0;
    for (let slot = firstEntry; slot < lastEntry; slot++) {
      const member = entryMember[slot]!;
      const bucket = entryBucket[slot]!;
      const bucketEnd = bucketStart[bucket + 1]!;
      for (let other = member + 1; other < bucketEnd; other++) {
        const partner = memberCanon[other]!;
        if (partner < lowestPartner) continue;
        const shared = sharedBuckets[partner]!;
        if (!shared) touched[touchedCount++] = partner;
        sharedBuckets[partner] = shared + 1;
      }
      if (sharesIds && memberUnit[member] !== unit) {
        for (let other = bucketStart[bucket]!; other < member; other++) {
          const partner = memberCanon[other]!;
          if (partner <= unit) continue;
          const shared = sharedBuckets[partner]!;
          if (!shared) touched[touchedCount++] = partner;
          sharedBuckets[partner] = shared + 1;
        }
      }
    }
    for (let at = 0; at < touchedCount; at++) {
      const partner = touched[at]!;
      const count = sharedBuckets[partner]!;
      sharedBuckets[partner] = 0;
      selection.consider(unit, partner, count);
    }
    if (unit % reportEvery === 0) options.onFingerprintProgress?.(unit + 1, unitCount);
    const pending = options.yieldPoint?.();
    if (pending) await pending;
  }
  options.onFingerprintProgress?.(unitCount, unitCount);

  selection.admit((first, second) => wholeProjectVisit(layout, index.units, first, second));
}

/**
 * Where a walk that starts from the targets first meets two canonical units, and the units of its second visit. That
 * walk of a bucket takes each target in turn and pairs it with every other member, so it meets a pair from the target
 * that comes first in the bucket, or from the pair's only target, and pairs it with the other unit's first member.
 */
function targetedVisit(
  layout: FingerprintLayout,
  units: readonly DuplicateInternalUnit[],
  targets: { isTarget: Uint8Array; before: Int32Array },
  first: number,
  second: number,
): PairVisit {
  const { bucketStart, rankBase, memberUnit, entryStart, entryMember, entryBucket } = layout;
  let a = entryStart[first]!;
  const aEnd = entryStart[first + 1]!;
  let b = entryStart[second]!;
  const bEnd = entryStart[second + 1]!;
  const firstIsTarget = targets.isTarget[first] === 1;
  const secondIsTarget = targets.isTarget[second] === 1;
  let firstRank = -1;
  while (a < aEnd && b < bEnd) {
    const bucket = entryBucket[a]!;
    if (bucket < entryBucket[b]!) {
      a++;
      continue;
    }
    if (entryBucket[b]! < bucket) {
      b++;
      continue;
    }
    // Both units are in this bucket, and `a` and `b` are their first members in it. The walk reaches the pair from its
    // only target, or from whichever of the two targets comes first.
    const slotA = entryMember[a]!;
    const slotB = entryMember[b]!;
    const walkedFromA = firstIsTarget && (!secondIsTarget || slotA < slotB);
    const targetSlot = walkedFromA ? slotA : slotB;
    const otherSlot = walkedFromA ? slotB : slotA;
    if (firstRank < 0) {
      const start = bucketStart[bucket]!;
      const size = bucketStart[bucket + 1]! - start;
      firstRank = rankBase[bucket]! + targets.before[targetSlot]! * size + (otherSlot - start);
    } else {
      const [left, right] = orderedPair(units[memberUnit[targetSlot]!]!, units[memberUnit[otherSlot]!]!);
      return { rank: firstRank, left, right };
    }
    while (a < aEnd && entryBucket[a] === bucket) a++;
    while (b < bEnd && entryBucket[b] === bucket) b++;
  }
  throw new Error("A candidate pair from shared fingerprints shares fewer than two buckets.");
}

/**
 * Fingerprint evidence for a targeted run.
 *
 * Every target counts, per other unit, the eligible buckets they share, with one counter per unit as in the
 * whole-project pass, and a pair of two targets is counted from the lower one. Pairs qualify, compete for the limit,
 * and are admitted exactly as they are there, in the order a walk that starts from the targets would first have met
 * them.
 */
function addTargetedFingerprintPairs(state: PairState, layout: FingerprintLayout, filter: CandidateFilter): void {
  const { index } = state;
  const unitCount = index.units.length;
  const { bucketStart, memberCanon, entryStart, entryBucket } = layout;
  const bucketCount = bucketStart.length - 1;

  const isTarget = new Uint8Array(unitCount);
  for (let unit = 0; unit < unitCount; unit++) {
    if (entryStart[unit + 1]! > entryStart[unit]! && filter.unit(index.units[unit]!)) isTarget[unit] = 1;
  }
  // How many targets come before each member of its bucket: where the walk of the bucket reaches it.
  const before = new Int32Array(memberCanon.length);
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    let targetsSoFar = 0;
    for (let member = bucketStart[bucket]!; member < bucketStart[bucket + 1]!; member++) {
      before[member] = targetsSoFar;
      targetsSoFar += isTarget[memberCanon[member]!]!;
    }
  }

  const selection = new FingerprintSelection(state, layout, filter.pair);
  const sharedBuckets = new Int32Array(unitCount);
  const touched = new Int32Array(unitCount);
  // Units that share an id can be in one bucket twice, and a pair counts once per bucket.
  const countedIn = index.hasSharedIds ? new Int32Array(unitCount) : undefined;
  let walk = 0;
  for (let target = 0; target < unitCount; target++) {
    if (!isTarget[target]) continue;
    let touchedCount = 0;
    let previousBucket = -1;
    for (let slot = entryStart[target]!; slot < entryStart[target + 1]!; slot++) {
      const bucket = entryBucket[slot]!;
      if (bucket === previousBucket) continue;
      previousBucket = bucket;
      walk++;
      for (let member = bucketStart[bucket]!; member < bucketStart[bucket + 1]!; member++) {
        const partner = memberCanon[member]!;
        // A unit is not paired with its own id, and a pair of two targets is counted from the lower one.
        if (partner === target || (partner < target && isTarget[partner])) continue;
        if (countedIn) {
          if (countedIn[partner] === walk) continue;
          countedIn[partner] = walk;
        }
        const shared = sharedBuckets[partner]!;
        if (!shared) touched[touchedCount++] = partner;
        sharedBuckets[partner] = shared + 1;
      }
    }
    for (let at = 0; at < touchedCount; at++) {
      const partner = touched[at]!;
      const count = sharedBuckets[partner]!;
      sharedBuckets[partner] = 0;
      selection.consider(target, partner, count);
    }
  }

  selection.admit((first, second) => targetedVisit(layout, index.units, { isTarget, before }, first, second));
}

function normalizeSimilarityIndex(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  if (bounded < MIN_SIMILARITY_HINT_INDEX) return undefined;
  return bounded;
}

function normalizeSimilarityHintFile(file: string, projectRoot: string | undefined): string | undefined {
  try {
    return normalizeDetectionFile(file, projectRoot);
  } catch {
    return undefined;
  }
}

function addSimilarityHintPair(
  state: PairState,
  left: DuplicateInternalUnit,
  right: DuplicateInternalUnit,
  similarityIndex: number,
): void {
  const key = pairNumber(state.index, canonOf(state.index, left), canonOf(state.index, right));
  const evidence = takePair(state, key, left, right);
  if (evidence) evidence.gitSimilarity = Math.max(evidence.gitSimilarity ?? 0, similarityIndex);
}

function similarityHintPairCountExceeds(
  leftUnits: readonly DuplicateInternalUnit[],
  rightUnits: readonly DuplicateInternalUnit[],
  limit: number,
  pairFilter?: PairFilter,
): boolean {
  let count = 0;
  for (const leftUnit of leftUnits) {
    for (const rightUnit of rightUnits) {
      if (leftUnit.languageId !== rightUnit.languageId) continue;
      const [left, right] = orderedPair(leftUnit, rightUnit);
      if (pairFilter && !pairFilter(left, right)) continue;
      count++;
      if (count > limit) return true;
    }
  }
  return false;
}

function similarityAlignmentKey(unit: DuplicateInternalUnit): string {
  return [unit.languageId, unit.kind, unit.symbolKind ?? ""].join(":");
}

function addAlignedSimilarityHintPairs(
  state: PairState,
  leftUnits: readonly DuplicateInternalUnit[],
  rightUnits: readonly DuplicateInternalUnit[],
  similarityIndex: number,
  maxPairs: number,
  pairFilter?: PairFilter,
): void {
  const rightByKey = new Map<string, DuplicateInternalUnit[]>();
  for (const unit of rightUnits) {
    const key = similarityAlignmentKey(unit);
    const bucket = rightByKey.get(key);
    if (bucket) bucket.push(unit);
    else rightByKey.set(key, [unit]);
  }
  for (const bucket of rightByKey.values()) {
    bucket.sort(compareUnitRefs);
  }

  const leftByKey = new Map<string, DuplicateInternalUnit[]>();
  for (const unit of leftUnits) {
    const key = similarityAlignmentKey(unit);
    const bucket = leftByKey.get(key);
    if (bucket) bucket.push(unit);
    else leftByKey.set(key, [unit]);
  }
  for (const bucket of leftByKey.values()) {
    bucket.sort(compareUnitRefs);
  }

  const seenPairs = new Set<number>();
  let addedPairs = 0;
  for (const [key, sortedLeftUnits] of Array.from(leftByKey.entries()).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const sortedRightUnits = rightByKey.get(key);
    if (!sortedRightUnits?.length) continue;
    const limit = Math.min(sortedLeftUnits.length, sortedRightUnits.length);
    for (let index = 0; index < limit; index++) {
      if (addedPairs >= maxPairs) return;
      const [left, right] = orderedPair(sortedLeftUnits[index]!, sortedRightUnits[index]!);
      const pairId = pairNumber(state.index, canonOf(state.index, left), canonOf(state.index, right));
      if (seenPairs.has(pairId)) continue;
      seenPairs.add(pairId);
      if (pairFilter && !pairFilter(left, right)) continue;
      addSimilarityHintPair(state, left, right, similarityIndex);
      addedPairs++;
    }
  }
}

function addSimilarityHintPairs(
  state: PairState,
  similarityHints: readonly DuplicateSimilarityHint[] | undefined,
  projectRoot: string | undefined,
  maxBucketSize: number,
  pairFilter?: PairFilter,
): number {
  if (!similarityHints?.length) return 0;
  const unitsByFile = new Map<string, DuplicateInternalUnit[]>();
  for (const unit of state.index.units) {
    const bucket = unitsByFile.get(unit.absoluteFile);
    if (bucket) {
      bucket.push(unit);
    } else {
      unitsByFile.set(unit.absoluteFile, [unit]);
    }
  }

  let oversizedHints = 0;
  for (const hint of similarityHints) {
    const similarityIndex = normalizeSimilarityIndex(hint.similarityIndex);
    if (similarityIndex === undefined) continue;
    const leftFile = normalizeSimilarityHintFile(hint.leftFile, projectRoot);
    const rightFile = normalizeSimilarityHintFile(hint.rightFile, projectRoot);
    if (!leftFile || !rightFile || leftFile === rightFile) continue;
    const leftUnits = unitsByFile.get(leftFile);
    const rightUnits = unitsByFile.get(rightFile);
    if (!leftUnits?.length || !rightUnits?.length) continue;

    if (similarityHintPairCountExceeds(leftUnits, rightUnits, maxBucketSize, pairFilter)) {
      oversizedHints++;
      addAlignedSimilarityHintPairs(state, leftUnits, rightUnits, similarityIndex, maxBucketSize, pairFilter);
      continue;
    }
    for (const leftUnit of leftUnits) {
      for (const rightUnit of rightUnits) {
        if (leftUnit.languageId !== rightUnit.languageId) continue;
        const [left, right] = orderedPair(leftUnit, rightUnit);
        if (pairFilter && !pairFilter(left, right)) continue;
        addSimilarityHintPair(state, left, right, similarityIndex);
      }
    }
  }
  return oversizedHints;
}

/**
 * Finds the unit pairs worth scoring from the prepared fingerprint buckets.
 *
 * Evidence is admitted from strongest to weakest: identical text, identical normalized tokens, identical AST shape,
 * Git similarity hints, then shared fingerprints. A pair the scorers can never score takes no part in the limit and is
 * only tallied. At most `maxCandidatePairs` of the others are kept; the rest are counted in `skippedPairs`, never
 * dropped silently.
 */
export async function buildCandidatePairs(
  preparedBuckets: PreparedDuplicateBuckets,
  options: CandidatePairOptions,
): Promise<CandidatePairResult> {
  const state: PairState = {
    index: createUnitIndex(preparedBuckets.units),
    crossFileOnly: options.crossFileOnly,
    pairs: new Map(),
    unscorable: new Set(),
    limit: options.maxCandidatePairs,
    skipped: 0,
  };
  let oversizedBuckets = 0;
  oversizedBuckets += await addEvidenceBuckets(state, preparedBuckets.rawHashBuckets, "rawHash", options);
  oversizedBuckets += await addEvidenceBuckets(state, preparedBuckets.normalizedHashBuckets, "normalizedHash", options);
  oversizedBuckets += await addEvidenceBuckets(state, preparedBuckets.astShapeBuckets, "astShape", options);
  oversizedBuckets += addSimilarityHintPairs(
    state,
    options.similarityHints,
    options.projectRoot,
    options.maxBucketSize,
    options.filter?.pair,
  );
  const fingerprints = eligibleFingerprintBuckets(state, preparedBuckets.signatureBuckets, options);
  oversizedBuckets += fingerprints.oversizedBuckets;
  const layout = layoutFingerprintBuckets(state.index, fingerprints.eligible);
  if (options.filter) {
    addTargetedFingerprintPairs(state, layout, options.filter);
  } else {
    await addProjectFingerprintPairs(state, layout, options);
  }
  return {
    pairs: state.pairs,
    oversizedBuckets,
    skippedPairs: state.skipped,
    unscorablePairs: state.unscorable.size,
    overlappingPairs: state.crossFileOnly ? 0 : state.unscorable.size,
  };
}
