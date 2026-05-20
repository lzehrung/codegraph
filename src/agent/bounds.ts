export type BoundedAgentList<T> = {
  items: T[];
  omitted: number;
};

export type AgentLimitOptions = {
  fallback?: number;
  max?: number;
};

export function normalizeAgentLimit(limit: number | undefined, options: AgentLimitOptions = {}): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return options.fallback;
  }
  const floored = Math.max(0, Math.floor(limit));
  if (options.max === undefined) return floored;
  return Math.min(options.max, floored);
}

export function defaultAgentLimit(limit: number | undefined, fallback: number, max?: number): number {
  const options: AgentLimitOptions = { fallback };
  if (max !== undefined) {
    options.max = max;
  }
  return normalizeAgentLimit(limit, options) ?? fallback;
}

export function boundAgentList<T>(items: readonly T[], limit: number): BoundedAgentList<T> {
  const boundedItems = items.slice(0, limit);
  return {
    items: boundedItems,
    omitted: countOmitted(items.length, boundedItems.length),
  };
}

export function emptyAgentBoundedList<T>(): BoundedAgentList<T> {
  return {
    items: [],
    omitted: 0,
  };
}

export function countOmitted(total: number, visible: number): number {
  return Math.max(0, total - visible);
}
