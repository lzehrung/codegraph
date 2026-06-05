import { supportForFile } from "../languages.js";
import type { ReviewDiagnostics, ReviewRiskLevel, ReviewRiskSummary, ReviewTask } from "./types.js";

export function computeRiskSummary(input: {
  filesChanged: number;
  symbolsChanged: number;
  exportedChanged: number;
  missingFiles: number;
  parseFailures: number;
}): ReviewRiskSummary {
  const signals: string[] = [];
  let score = 0;
  if (input.exportedChanged > 0) {
    score += 60;
    signals.push("exported-symbols-changed");
  } else {
    score += 20;
  }
  if (input.symbolsChanged >= 20) {
    score += 20;
    signals.push("many-symbols-changed");
  }
  if (input.filesChanged >= 10) {
    score += 20;
    signals.push("many-files-changed");
  }
  if (input.missingFiles > 0) {
    score += 30;
    signals.push("missing-files");
  }
  if (input.parseFailures > 0) {
    score += 25;
    signals.push("symbol-mapping-degraded");
  }
  const normalizedScore = Math.min(100, score);
  let level: ReviewRiskLevel = "low";
  if (normalizedScore >= 70) level = "high";
  else if (normalizedScore >= 40) level = "medium";
  return {
    level,
    score: normalizedScore,
    signals,
  };
}

export function buildReviewTasks(input: {
  filesChanged: number;
  symbolsChanged: number;
  exportedChanged: number;
  candidateTests: number;
  missingFiles: number;
  parseFailures: number;
}): ReviewTask[] {
  const tasks: ReviewTask[] = [
    {
      id: "review-summary",
      title: "Review changed symbols",
      description: "Scan the changed symbols and confirm behavioral changes align with intent.",
      priority: "medium",
      reason: "baseline-review",
    },
  ];

  if (input.exportedChanged > 0) {
    tasks.push({
      id: "api-compat",
      title: "Verify API compatibility",
      description: "Check exported symbols for breaking changes, migration notes, and versioning implications.",
      priority: "high",
      reason: "exported-symbols-changed",
    });
  }

  if (input.candidateTests === 0) {
    tasks.push({
      id: "tests-missing",
      title: "Validate test coverage",
      description: "No candidate tests were detected. Confirm existing coverage or add targeted tests.",
      priority: "medium",
      reason: "no-candidate-tests",
    });
  }

  if (input.filesChanged >= 10 || input.symbolsChanged >= 20) {
    tasks.push({
      id: "high-change-volume",
      title: "Assess change scope",
      description: "Large change set detected. Double-check impacted files and coordination needs.",
      priority: "high",
      reason: "large-change-set",
    });
  }

  if (input.parseFailures > 0) {
    tasks.push({
      id: "analysis-degraded",
      title: "Validate degraded symbol mapping",
      description:
        "Some changed files could not be mapped cleanly to symbols. Review syntax errors, parser support, or fall back to file-level inspection.",
      priority: "high",
      reason: "symbol-mapping-degraded",
    });
  }

  if (input.missingFiles > 0) {
    tasks.push({
      id: "missing-input-files",
      title: "Validate missing review inputs",
      description:
        "Some explicitly requested files were missing on disk. Confirm paths and whether the intended change was a real deletion.",
      priority: "high",
      reason: "missing-files",
    });
  }

  return tasks;
}

export function hasDiagnostics(diagnostics: ReviewDiagnostics): boolean {
  return !!(diagnostics.missingFiles.length || diagnostics.symbolMappingParseFailures.length);
}

export function isRiskRelevantSymbolMappingFile(file: string): boolean {
  return supportForFile(file)?.supportsCrossModuleSymbols ?? false;
}
