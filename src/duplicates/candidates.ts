import { appendToArrayMap } from "../util/collections.js";
import { compareUnitRefs } from "./scoring.js";
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

/** Targeted analysis: only pairs that touch a target unit are candidates. */
export type CandidateFilter = {
  unit: UnitFilter;
  pair: PairFilter;
};

export type CandidatePairOptions = {
  maxBucketSize: number;
  /** Upper bound on pairs kept. Pairs past it are skipped and counted. */
  maxCandidatePairs: number;
  similarityHints?: readonly DuplicateSimilarityHint[] | undefined;
  projectRoot?: string | undefined;
  filter?: CandidateFilter | undefined;
  /** Reports how many units the fingerprint pass has paired. */
  onFingerprintProgress?: ((current: number, total: number) => void) | undefined;
  /** Returns a promise when a long pass should let the event loop turn. */
  yieldPoint?: (() => Promise<void> | undefined) | undefined;
};

export type CandidatePairResult = {
  /** Kept pairs keyed by a number derived from the unit ids, in the order evidence was admitted. */
  pairs: Map<number, PairEvidence>;
  oversizedBuckets: number;
  /** Pair occurrences dropped because `maxCandidatePairs` was reached. A pair several kinds of evidence propose counts once per kind. */
  skippedPairs: number;
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
  pairs: Map<number, PairEvidence>;
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

function newEvidence(
  left: DuplicateInternalUnit,
  right: DuplicateInternalUnit,
  kind: StrongEvidenceKind,
): PairEvidence {
  return {
    left,
    right,
    rawHash: kind === "rawHash",
    normalizedHash: kind === "normalizedHash",
    astShape: kind === "astShape",
    signature: false,
    signatureMatches: 0,
  };
}

function addStrongEvidence(
  state: PairState,
  kind: StrongEvidenceKind,
  left: DuplicateInternalUnit,
  right: DuplicateInternalUnit,
  key: number,
): void {
  const existing = state.pairs.get(key);
  if (existing) {
    existing[kind] = true;
    return;
  }
  if (state.pairs.size >= state.limit) {
    state.skipped++;
    return;
  }
  state.pairs.set(key, newEvidence(left, right, kind));
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
  const { index, pairs } = state;
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
      const key = pairNumber(index, canons[i]!, canons[j]!);
      const existing = pairs.get(key);
      if (existing) {
        existing[kind] = true;
        continue;
      }
      if (pairs.size >= state.limit) {
        state.skipped++;
        continue;
      }
      const [left, right] = orderedPair(bucket[i]!, bucket[j]!);
      pairs.set(key, newEvidence(left, right, kind));
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
 * Fingerprint evidence for a targeted run: count the shared buckets of each pair that touches a target.
 * The count table is bounded by the pair limit, so a pathological target set cannot grow it without bound.
 */
function addFilteredFingerprintPairs(
  state: PairState,
  eligible: ReadonlyArray<readonly DuplicateInternalUnit[]>,
  filter: CandidateFilter,
): void {
  const { index, pairs } = state;
  const sharedBuckets = new Map<number, number>();
  const secondSighting = new Map<number, [DuplicateInternalUnit, DuplicateInternalUnit]>();
  const consideredBuckets = new Map<number, Set<number>>();
  const consideredCount = (unit: DuplicateInternalUnit): number =>
    consideredBuckets.get(canonOf(index, unit))?.size ?? 0;

  eligible.forEach((bucket, ordinal) => {
    for (const unit of bucket) {
      const canon = canonOf(index, unit);
      const considered = consideredBuckets.get(canon);
      if (considered) considered.add(ordinal);
      else consideredBuckets.set(canon, new Set([ordinal]));
    }
    forEachFilteredBucketPair(index, bucket, filter, (left, right, key) => {
      const next = (sharedBuckets.get(key) ?? 0) + 1;
      if (next === 1 && sharedBuckets.size >= state.limit) {
        state.skipped++;
        return;
      }
      sharedBuckets.set(key, next);
      if (next === 2 && !pairs.has(key) && !secondSighting.has(key)) secondSighting.set(key, [left, right]);
    });
  });

  for (const [key, count] of sharedBuckets) {
    const existing = pairs.get(key);
    if (existing) {
      existing.signatureMatches = count;
      if (hasEnoughFingerprints(count, Math.min(consideredCount(existing.left), consideredCount(existing.right)))) {
        existing.signature = true;
      }
      continue;
    }
    if (count < 2) continue;
    const units = secondSighting.get(key);
    if (!units) continue;
    const [left, right] = units;
    if (!hasEnoughFingerprints(count, Math.min(consideredCount(left), consideredCount(right)))) continue;
    if (pairs.size >= state.limit) {
      state.skipped++;
      continue;
    }
    pairs.set(key, {
      left,
      right,
      rawHash: false,
      normalizedHash: false,
      astShape: false,
      signature: true,
      signatureMatches: count,
    });
  }
}

/**
 * Fingerprint evidence for the whole project.
 *
 * Every unit counts, per other unit, the eligible buckets they share, using one counter per unit
 * instead of a table of all pairs that share a fingerprint. Only pairs that already have stronger
 * evidence, or share enough fingerprints, become candidates. When more qualify than the pair limit
 * allows, the pairs sharing the largest fraction of their fingerprints are kept. The kept pairs are
 * then admitted in the order a pair-by-pair walk of the buckets would have first met them.
 */
async function addFingerprintPairs(
  state: PairState,
  eligible: ReadonlyArray<readonly DuplicateInternalUnit[]>,
  options: CandidatePairOptions,
): Promise<void> {
  const { index, pairs } = state;
  const unitCount = index.units.length;
  const canon = index.canon;
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

  // Members of every eligible bucket, flattened in bucket order: the unit position and its canonical unit.
  const memberUnit = new Int32Array(total);
  const memberCanon = new Int32Array(total);
  const entryStart = new Int32Array(unitCount + 1);
  const consideredCount = new Int32Array(unitCount);
  const lastBucket = new Int32Array(unitCount).fill(-1);
  for (let bucket = 0, member = 0; bucket < bucketCount; bucket++) {
    for (const unit of eligible[bucket]!) {
      const position = positionOf(index, unit);
      const unitCanon = canon[position]!;
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

  // Each canonical unit's member slots, in bucket order.
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

  const sharedBuckets = new Int32Array(unitCount);
  const touched = new Int32Array(unitCount);
  const best = new BestPairs(Math.max(0, state.limit - pairs.size));
  const sharesIds = index.hasSharedIds;
  const reportEvery = Math.max(1, Math.floor(unitCount / 100));
  let qualifying = 0;

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
      if (count < 2) continue;
      const smaller = Math.min(consideredCount[unit]!, consideredCount[partner]!);
      if (!hasEnoughFingerprints(count, smaller)) continue;
      const existing = pairs.get(unit * unitCount + partner);
      if (existing) {
        existing.signatureMatches = count;
        existing.signature = true;
        continue;
      }
      qualifying++;
      best.offer(count / smaller, unit, partner, count);
    }
    if (unit % reportEvery === 0) options.onFingerprintProgress?.(unit + 1, unitCount);
    const pending = options.yieldPoint?.();
    if (pending) await pending;
  }
  options.onFingerprintProgress?.(unitCount, unitCount);

  // Admit the kept pairs where the pair-by-pair walk would have met them: by their first shared
  // bucket, and from the second sighting come the units the evidence names.
  type Admission = {
    rank: number;
    left: DuplicateInternalUnit;
    right: DuplicateInternalUnit;
    key: number;
    count: number;
  };
  const admissions: Admission[] = [];
  for (const { first, second, matches } of best.entries()) {
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
    const [left, right] = orderedPair(
      index.units[memberUnit[secondVisit.low]!]!,
      index.units[memberUnit[secondVisit.high]!]!,
    );
    admissions.push({ rank: firstVisit.rank, left, right, key: first * unitCount + second, count: matches });
  }
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
  state.skipped += qualifying - admissions.length;
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
  const existing = state.pairs.get(key);
  if (existing) {
    existing.gitSimilarity = Math.max(existing.gitSimilarity ?? 0, similarityIndex);
    return;
  }
  if (state.pairs.size >= state.limit) {
    state.skipped++;
    return;
  }
  state.pairs.set(key, {
    left,
    right,
    rawHash: false,
    normalizedHash: false,
    astShape: false,
    gitSimilarity: similarityIndex,
    signature: false,
    signatureMatches: 0,
  });
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
 * Evidence is admitted from strongest to weakest: identical text, identical normalized tokens,
 * identical AST shape, Git similarity hints, then shared fingerprints. At most `maxCandidatePairs`
 * pairs are kept; the rest are counted in `skippedPairs`, never dropped silently.
 */
export async function buildCandidatePairs(
  preparedBuckets: PreparedDuplicateBuckets,
  options: CandidatePairOptions,
): Promise<CandidatePairResult> {
  const state: PairState = {
    index: createUnitIndex(preparedBuckets.units),
    pairs: new Map(),
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
  if (options.filter) {
    addFilteredFingerprintPairs(state, fingerprints.eligible, options.filter);
  } else {
    await addFingerprintPairs(state, fingerprints.eligible, options);
  }
  return { pairs: state.pairs, oversizedBuckets, skippedPairs: state.skipped };
}
