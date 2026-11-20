function medianSorted(sorted) {
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Statistics for paired, alternating base/head samples. Times must be finite and positive. */
export function summarizeSamples(values) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Samples must contain finite, positive durations.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const medianMs = medianSorted(sorted);
  const minMs = sorted[0];
  const maxMs = sorted[sorted.length - 1];
  return { medianMs, minMs, maxMs, spreadPercent: ((maxMs - minMs) / medianMs) * 100 };
}

/** Decide from paired head/base ratios and their scaled median absolute deviation, with a 2% practical floor. */
export function comparePairedSamples(base, head) {
  if (base.length < 5 || base.length !== head.length) {
    throw new Error("At least five equally sized paired rounds are required.");
  }
  const baseSummary = summarizeSamples(base);
  const headSummary = summarizeSamples(head);
  const ratios = [];
  let roundsHeadSlower = 0;
  let roundsHeadFaster = 0;
  for (let index = 0; index < base.length; index += 1) {
    ratios.push(head[index] / base[index]);
    if (head[index] > base[index]) roundsHeadSlower += 1;
    if (head[index] < base[index]) roundsHeadFaster += 1;
  }
  const pairedMedianRatio = medianSorted(ratios.sort((left, right) => left - right));
  const deviations = ratios.map((ratio) => Math.abs(ratio - pairedMedianRatio)).sort((left, right) => left - right);
  const noiseRatio = medianSorted(deviations) * 1.4826;
  const lowerRatio = pairedMedianRatio - noiseRatio;
  const upperRatio = pairedMedianRatio + noiseRatio;
  const consistentlySlower = roundsHeadSlower > base.length / 2;
  const consistentlyFaster = roundsHeadFaster > base.length / 2;
  const outlierBand = Math.max(3 * noiseRatio, 0.05);
  const outlierRounds = ratios.filter((ratio) => Math.abs(ratio - pairedMedianRatio) > outlierBand).length;
  const seriesMedianRatio = headSummary.medianMs / baseSummary.medianMs;
  const medianRatioGapPercent = Math.abs(seriesMedianRatio - pairedMedianRatio) * 100;
  const contaminated = outlierRounds >= 2 || medianRatioGapPercent > 5;
  let verdict = "inconclusive";
  if (!contaminated) {
    if (lowerRatio > 1.02 && consistentlySlower) verdict = "regression";
    else if (upperRatio < 0.98 && consistentlyFaster) verdict = "improvement";
    else if (lowerRatio >= 0.98 && upperRatio <= 1.02) verdict = "within-noise";
  }
  return {
    base: baseSummary,
    head: headSummary,
    pairedMedianRatio,
    seriesMedianRatio,
    outlierRounds,
    medianRatioGapPercent,
    slowerPercent: (pairedMedianRatio - 1) * 100,
    noisePercent: noiseRatio * 100,
    roundsHeadSlower,
    rounds: base.length,
    verdict,
    regression: verdict === "regression",
  };
}
