/**
 * Partial results handling for more reliable operations
 *
 * Instead of failing completely, operations return what was successfully
 * analyzed along with detailed error information. This is especially useful
 * for agents that can work with incomplete data.
 */

/**
 * Result that may be partial
 */
export type PartialResult<T> = {
  /** Completion status */
  status: "complete" | "partial" | "failed";

  /** The result data (may be incomplete if partial) */
  data: T;

  /** Errors that occurred during processing */
  errors: PartialError[];

  /** Coverage percentage (0-1) */
  coverage: number;

  /** Metadata about the operation */
  metadata?: {
    /** Total items attempted */
    attempted: number;
    /** Successfully processed items */
    succeeded: number;
    /** Failed items */
    failed: number;
    /** Duration in milliseconds */
    duration?: number;
  };
};

/**
 * Detailed error information
 */
export type PartialError = {
  /** What failed (file, symbol, etc.) */
  target: string;

  /** Error message */
  message: string;

  /** Error stack trace if available */
  stack?: string;

  /** Severity of the error */
  severity: "error" | "warning";

  /** Whether this error can be retried */
  retryable: boolean;

  /** Additional context */
  context?: Record<string, unknown>;
};

function messageFromReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof (reason as { message: unknown }).message === "string"
  ) {
    return (reason as { message: string }).message;
  }
  return "Unknown error";
}

/**
 * Create a successful partial result
 */
export function success<T>(data: T, metadata?: PartialResult<T>["metadata"]): PartialResult<T> {
  const result: PartialResult<T> = {
    status: "complete",
    data,
    errors: [],
    coverage: 1.0,
  };
  if (metadata) {
    result.metadata = metadata;
  }
  return result;
}

/**
 * Create a partial result with some failures
 */
export function partial<T>(data: T, errors: PartialError[], metadata?: PartialResult<T>["metadata"]): PartialResult<T> {
  const attempted = metadata?.attempted ?? 1;
  const failed = metadata?.failed ?? errors.length;
  const succeeded = attempted - failed;
  const coverage = attempted > 0 ? succeeded / attempted : 0;

  return {
    status: coverage > 0 ? "partial" : "failed",
    data,
    errors,
    coverage,
    metadata: metadata ?? {
      attempted,
      succeeded,
      failed,
    },
  };
}

/**
 * Create a failed result
 */
export function failed<T>(emptyData: T, error: Error | string, target: string = "operation"): PartialResult<T> {
  const message = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack : undefined;

  const partialError: PartialError = {
    target,
    message,
    severity: "error",
    retryable: false,
  };
  if (stack) {
    partialError.stack = stack;
  }

  return {
    status: "failed",
    data: emptyData,
    errors: [partialError],
    coverage: 0,
    metadata: {
      attempted: 1,
      succeeded: 0,
      failed: 1,
    },
  };
}

/**
 * Wrapper for async operations that may partially fail
 */
export async function withPartialResults<T, I>(
  items: I[],
  operation: (item: I) => Promise<T>,
  options?: {
    /** Custom name for items (for error messages) */
    itemName?: string;
    /** Whether to continue on errors (default: true) */
    continueOnError?: boolean;
    /** Maximum concurrent operations (default: 8) */
    concurrency?: number;
  },
): Promise<PartialResult<T[]>> {
  const itemName = options?.itemName ?? "item";
  const continueOnError = options?.continueOnError ?? true;
  const concurrency = options?.concurrency ?? 8;

  const startTime = Date.now();
  const results: T[] = [];
  const errors: PartialError[] = [];
  let succeeded = 0;
  let failed = 0;

  // Process in batches with concurrency control
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);

    const batchResults = await Promise.allSettled(
      batch.map(async (item, idx) => {
        try {
          const result = await operation(item);
          return { success: true as const, result, item, index: i + idx };
        } catch (error) {
          return {
            success: false as const,
            error: error as Error,
            item,
            index: i + idx,
          };
        }
      }),
    );

    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        const value = settled.value;
        if (value.success) {
          results.push(value.result);
          succeeded++;
        } else {
          failed++;
          const error: PartialError = {
            target: `${itemName}[${value.index}]`,
            message: value.error.message,
            severity: "error",
            retryable: true,
          };
          if (value.error.stack) {
            error.stack = value.error.stack;
          }
          errors.push(error);

          if (!continueOnError) {
            // Stop processing
            const duration = Date.now() - startTime;
            return partial(results, errors, {
              attempted: items.length,
              succeeded,
              failed,
              duration,
            });
          }
        }
      } else {
        // Promise was rejected (shouldn't happen with allSettled, but handle anyway)
        failed++;
        errors.push({
          target: `${itemName}[${i + batchResults.indexOf(settled)}]`,
          message: messageFromReason(settled.reason),
          severity: "error",
          retryable: false,
        });
      }
    }
  }

  const duration = Date.now() - startTime;

  if (errors.length === 0) {
    return success(results, {
      attempted: items.length,
      succeeded,
      failed: 0,
      duration,
    });
  }

  return partial(results, errors, {
    attempted: items.length,
    succeeded,
    failed,
    duration,
  });
}

/**
 * Combine multiple partial results
 */
export function combinePartialResults<T>(results: PartialResult<T>[], combine: (data: T[]) => T): PartialResult<T> {
  const allErrors: PartialError[] = [];
  const allData: T[] = [];
  let totalAttempted = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  for (const result of results) {
    allErrors.push(...result.errors);
    allData.push(result.data);

    const counts = getResultCounts(result);
    totalAttempted += counts.attempted;
    totalSucceeded += counts.succeeded;
    totalFailed += counts.failed;
  }

  const combined = combine(allData);
  const coverage = totalAttempted > 0 ? totalSucceeded / totalAttempted : 0;
  let status: PartialResult<unknown>["status"] = "failed";
  if (coverage === 1) {
    status = "complete";
  } else if (coverage > 0) {
    status = "partial";
  }

  return {
    status,
    data: combined,
    errors: allErrors,
    coverage,
    metadata: {
      attempted: totalAttempted,
      succeeded: totalSucceeded,
      failed: totalFailed,
    },
  };
}

/**
 * Map a partial result to a new type
 */
export function mapPartialResult<T, U>(result: PartialResult<T>, mapper: (data: T) => U): PartialResult<U> {
  return {
    ...result,
    data: mapper(result.data),
  };
}

/**
 * Filter errors by severity
 */
export function filterErrorsBySeverity(result: PartialResult<unknown>, severity: "error" | "warning"): PartialError[] {
  return result.errors.filter((e) => e.severity === severity);
}

/**
 * Get a summary of a partial result
 */
export function summarizePartialResult(result: PartialResult<unknown>): string {
  const { status, coverage, errors, metadata } = result;

  if (status === "complete") {
    return `✓ Complete (${metadata?.succeeded ?? 0} items processed)`;
  }

  if (status === "failed") {
    const errorCount = errors.length;
    const firstError = errors[0]?.message ?? "Unknown error";
    return `✗ Failed (${errorCount} errors): ${firstError}`;
  }

  // Partial
  const pct = (coverage * 100).toFixed(1);
  const succeeded = metadata?.succeeded ?? 0;
  const failed = metadata?.failed ?? 0;
  return `⚠ Partial (${pct}% complete: ${succeeded} succeeded, ${failed} failed)`;
}

function getResultCounts<T>(result: PartialResult<T>): {
  attempted: number;
  succeeded: number;
  failed: number;
} {
  if (result.metadata) {
    return {
      attempted: result.metadata.attempted,
      succeeded: result.metadata.succeeded,
      failed: result.metadata.failed,
    };
  }

  const attempted = 1;
  const coverage = Math.max(0, Math.min(1, result.coverage));
  let succeeded = coverage;
  if (result.status === "complete") {
    succeeded = 1;
  } else if (result.status === "failed") {
    succeeded = 0;
  }
  const failed = attempted - succeeded;

  return { attempted, succeeded, failed };
}
