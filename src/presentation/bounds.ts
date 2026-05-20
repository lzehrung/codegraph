export type BoundedList<T> = {
  items: T[];
  omitted: number;
};

export const REVIEW_DEFAULT_CANDIDATE_TEST_LIMIT = 50;
export const REVIEW_SUMMARY_CHANGED_FILE_LIMIT = 20;
export const REVIEW_SUMMARY_SYMBOLS_PER_FILE_LIMIT = 5;
export const REVIEW_SUMMARY_CANDIDATES_PER_CONFIDENCE_LIMIT = 8;
export const REVIEW_SUMMARY_TASK_LIMIT = 8;

export const AGENT_SEARCH_RESULT_LIMIT = 100;
export const AGENT_SEARCH_RANK_REASONS_PER_RESULT_LIMIT = 6;
export const AGENT_SEARCH_EVIDENCE_PER_RESULT_LIMIT = 5;
export const AGENT_SEARCH_NEIGHBORS_PER_RESULT_LIMIT = 12;
export const AGENT_SEARCH_FOLLOWUPS_PER_RESULT_LIMIT = 8;
export const AGENT_SEARCH_FORMAT_REASON_LIMIT = 3;

export const AGENT_EXPLAIN_DEFAULT_DEPENDENCY_LIMIT = 20;
export const AGENT_EXPLAIN_DEFAULT_SNIPPET_LIMIT = 8;
export const AGENT_EXPLAIN_DEFAULT_SYMBOL_LIMIT = 50;
export const AGENT_EXPLAIN_MAX_DEPENDENCY_LIMIT = 100;
export const AGENT_EXPLAIN_MAX_SNIPPET_LIMIT = 50;
export const AGENT_EXPLAIN_MAX_SYMBOL_LIMIT = 200;
export const AGENT_EXPLAIN_FORMAT_SYMBOL_LIMIT = 8;
export const AGENT_EXPLAIN_FORMAT_FOLLOWUP_LIMIT = 8;
export const AGENT_EXPLAIN_FILE_SYMBOL_REF_LIMIT = 5;
export const AGENT_EXPLAIN_CHANGED_FILE_LIMIT = 20;
export const AGENT_EXPLAIN_REVIEW_TASK_LIMIT = 5;
export const AGENT_EXPLAIN_CANDIDATE_TEST_LIMIT = 10;
export const AGENT_EXPLAIN_REVIEW_CONTEXT_CANDIDATE_LIMIT = 5;

export function boundList<T>(items: readonly T[], limit: number): BoundedList<T> {
  const boundedItems = items.slice(0, limit);
  return {
    items: boundedItems,
    omitted: countOmitted(items.length, boundedItems.length),
  };
}

export function emptyBoundedList<T>(): BoundedList<T> {
  return {
    items: [],
    omitted: 0,
  };
}

export function countOmitted(total: number, visible: number): number {
  return Math.max(0, total - visible);
}
