import { describe, test, expect } from "vitest";
import {
  success,
  partial,
  failed,
  withPartialResults,
  combinePartialResults,
  mapPartialResult,
  filterErrorsBySeverity,
  summarizePartialResult,
} from "../src/util/partialResults.js";

describe("Partial Results", () => {
  describe("success", () => {
    test("should create a successful result", () => {
      const result = success([1, 2, 3]);

      expect(result.status).toBe("complete");
      expect(result.data).toEqual([1, 2, 3]);
      expect(result.errors).toEqual([]);
      expect(result.coverage).toBe(1.0);
    });

    test("should include metadata if provided", () => {
      const result = success([1, 2, 3], {
        attempted: 3,
        succeeded: 3,
        failed: 0,
      });

      expect(result.metadata?.attempted).toBe(3);
      expect(result.metadata?.succeeded).toBe(3);
      expect(result.metadata?.failed).toBe(0);
    });
  });

  describe("partial", () => {
    test("should create a partial result", () => {
      const errors = [
        {
          target: "file1.ts",
          message: "Parse error",
          severity: "error" as const,
          retryable: true,
        },
      ];

      const result = partial([1, 2], errors, {
        attempted: 3,
        succeeded: 2,
        failed: 1,
      });

      expect(result.status).toBe("partial");
      expect(result.data).toEqual([1, 2]);
      expect(result.errors).toEqual(errors);
      expect(result.coverage).toBeCloseTo(2 / 3);
    });

    test("should be 'failed' if coverage is 0", () => {
      const errors = [
        {
          target: "all",
          message: "Total failure",
          severity: "error" as const,
          retryable: false,
        },
      ];

      const result = partial([], errors, {
        attempted: 3,
        succeeded: 0,
        failed: 3,
      });

      expect(result.status).toBe("failed");
      expect(result.coverage).toBe(0);
    });

    test("uses fallback metadata when none is provided", () => {
      const errors = [
        {
          target: "file.ts",
          message: "Parse error",
          severity: "error" as const,
          retryable: true,
        },
      ];

      const result = partial([], errors);

      expect(result.status).toBe("failed");
      expect(result.data).toEqual([]);
      expect(result.coverage).toBe(0);
      expect(result.metadata).toEqual({ attempted: 1, succeeded: 0, failed: 1 });
    });
  });

  describe("failed", () => {
    test("should create a failed result from Error", () => {
      const error = new Error("Something went wrong");
      const result = failed<number[]>([], error, "operation");

      expect(result.status).toBe("failed");
      expect(result.data).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].target).toBe("operation");
      expect(result.errors[0].message).toBe("Something went wrong");
      expect(result.errors[0].stack).toBeDefined();
      expect(result.coverage).toBe(0);
    });

    test("should create a failed result from string", () => {
      const result = failed<number[]>([], "Error message", "target");

      expect(result.errors[0].message).toBe("Error message");
      expect(result.errors[0].stack).toBeUndefined();
    });
  });

  describe("withPartialResults", () => {
    test("should process all items successfully", async () => {
      const items = [1, 2, 3, 4, 5];
      const operation = async (n: number) => n * 2;

      const result = await withPartialResults(items, operation);

      expect(result.status).toBe("complete");
      expect(result.data).toEqual([2, 4, 6, 8, 10]);
      expect(result.errors).toEqual([]);
      expect(result.coverage).toBe(1.0);
      expect(result.metadata?.succeeded).toBe(5);
      expect(result.metadata?.failed).toBe(0);
    });

    test("should handle partial failures", async () => {
      const items = [1, 2, 3, 4, 5];
      const operation = async (n: number) => {
        if (n === 3) throw new Error("Failed on 3");
        return n * 2;
      };

      const result = await withPartialResults(items, operation, {
        continueOnError: true,
      });

      expect(result.status).toBe("partial");
      expect(result.data).toEqual([2, 4, 8, 10]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].target).toContain("[2]");
      expect(result.coverage).toBeCloseTo(4 / 5);
    });

    test("should stop on first error if continueOnError is false", async () => {
      const items = [1, 2, 3, 4, 5];
      const operation = async (n: number) => {
        if (n === 3) throw new Error("Failed on 3");
        return n * 2;
      };

      const result = await withPartialResults(items, operation, {
        continueOnError: false,
      });

      expect(result.status).toBe("partial");
      expect(result.data.length).toBeLessThan(5);
      expect(result.errors).toHaveLength(1);
    });

    test("does not start later items after the first failure when continueOnError is false", async () => {
      const started: number[] = [];
      const finished: number[] = [];

      const result = await withPartialResults(
        [1, 2, 3, 4],
        async (n: number) => {
          started.push(n);
          if (n === 2) {
            throw new Error("Failed on 2");
          }
          finished.push(n);
          return n * 10;
        },
        {
          continueOnError: false,
          concurrency: 4,
        },
      );

      expect(started).toEqual([1, 2]);
      expect(finished).toEqual([1]);
      expect(result.data).toEqual([10]);
      expect(result.errors).toHaveLength(1);
      expect(result.metadata).toEqual({
        attempted: 2,
        succeeded: 1,
        failed: 1,
        duration: result.metadata?.duration,
      });
    });

    test("should respect concurrency limit", async () => {
      const items = Array.from({ length: 20 }, (_, i) => i);
      let concurrent = 0;
      let maxConcurrent = 0;

      const operation = async (n: number) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent--;
        return n;
      };

      await withPartialResults(items, operation, {
        concurrency: 4,
      });

      expect(maxConcurrent).toBeLessThanOrEqual(4);
    });

    test("should use custom item name in errors", async () => {
      const items = [1, 2, 3];
      const operation = async (n: number) => {
        if (n === 2) throw new Error("Failed");
        return n;
      };

      const result = await withPartialResults(items, operation, {
        itemName: "file",
      });

      expect(result.errors[0].target).toContain("file");
    });

    test("should include duration in metadata", async () => {
      const items = [1, 2, 3];
      const operation = async (n: number) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return n;
      };

      const result = await withPartialResults(items, operation);

      expect(result.metadata?.duration).toBeGreaterThan(0);
    });

    test("preserves non-Error rejection messages when continuing after failures", async () => {
      const result = await withPartialResults(
        [1, 2],
        async (n: number) => {
          if (n === 2) {
            throw "plain failure";
          }
          return n;
        },
        {
          continueOnError: true,
        },
      );

      expect(result.status).toBe("partial");
      expect(result.data).toEqual([1]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.message).toBe("plain failure");
      expect(result.errors[0]?.stack).toBeUndefined();
    });
  });

  describe("combinePartialResults", () => {
    test("should combine successful results", () => {
      const results = [success([1, 2]), success([3, 4]), success([5, 6])];

      const combined = combinePartialResults(results, (arrays) => arrays.flat());

      expect(combined.status).toBe("complete");
      expect(combined.data).toEqual([1, 2, 3, 4, 5, 6]);
      expect(combined.errors).toEqual([]);
      expect(combined.coverage).toBe(1.0);
    });

    test("should combine partial results", () => {
      const results = [
        success([1, 2]),
        partial([3], [{ target: "test", message: "error", severity: "error" as const, retryable: false }], {
          attempted: 2,
          succeeded: 1,
          failed: 1,
        }),
        success([4, 5]),
      ];

      const combined = combinePartialResults(results, (arrays) => arrays.flat());

      expect(combined.status).toBe("partial");
      expect(combined.data).toEqual([1, 2, 3, 4, 5]);
      expect(combined.errors).toHaveLength(1);
      expect(combined.coverage).toBeLessThan(1.0);
    });

    test("should aggregate metadata", () => {
      const results = [
        success([1], { attempted: 1, succeeded: 1, failed: 0 }),
        partial([2], [], { attempted: 2, succeeded: 1, failed: 1 }),
      ];

      const combined = combinePartialResults(results, (arrays) => arrays.flat());

      expect(combined.metadata?.attempted).toBe(3);
      expect(combined.metadata?.succeeded).toBe(2);
      expect(combined.metadata?.failed).toBe(1);
    });

    test("falls back to status and clamped coverage when result metadata is absent", () => {
      const results = [
        { ...success([1]) },
        { ...partial([2], []), coverage: 2 },
        { ...failed<number[]>([], "broken"), coverage: -1 },
      ];

      const combined = combinePartialResults(results, (arrays) => arrays.flat());

      expect(combined.status).toBe("partial");
      expect(combined.data).toEqual([1, 2]);
      expect(combined.coverage).toBeCloseTo(2 / 3);
      expect(combined.metadata).toEqual({ attempted: 3, succeeded: 2, failed: 1 });
    });
  });

  describe("mapPartialResult", () => {
    test("should transform the data", () => {
      const result = success([1, 2, 3]);
      const mapped = mapPartialResult(result, (nums) => nums.map((n) => n * 2));

      expect(mapped.status).toBe("complete");
      expect(mapped.data).toEqual([2, 4, 6]);
      expect(mapped.errors).toEqual(result.errors);
      expect(mapped.coverage).toBe(result.coverage);
    });

    test("should preserve errors and metadata", () => {
      const errors = [
        {
          target: "test",
          message: "error",
          severity: "error" as const,
          retryable: false,
        },
      ];
      const result = partial([1, 2], errors, {
        attempted: 3,
        succeeded: 2,
        failed: 1,
      });

      const mapped = mapPartialResult(result, (nums) => nums.map((n) => String(n)));

      expect(mapped.data).toEqual(["1", "2"]);
      expect(mapped.errors).toEqual(errors);
      expect(mapped.metadata).toEqual(result.metadata);
    });
  });

  describe("filterErrorsBySeverity", () => {
    test("should filter errors by severity", () => {
      const result = partial(
        [],
        [
          {
            target: "a",
            message: "error1",
            severity: "error" as const,
            retryable: false,
          },
          {
            target: "b",
            message: "warning1",
            severity: "warning" as const,
            retryable: true,
          },
          {
            target: "c",
            message: "error2",
            severity: "error" as const,
            retryable: false,
          },
        ],
        {
          attempted: 3,
          succeeded: 0,
          failed: 3,
        },
      );

      const errors = filterErrorsBySeverity(result, "error");
      const warnings = filterErrorsBySeverity(result, "warning");

      expect(errors).toHaveLength(2);
      expect(warnings).toHaveLength(1);
    });
  });

  describe("summarizePartialResult", () => {
    test("should summarize complete result", () => {
      const result = success([1, 2, 3], {
        attempted: 3,
        succeeded: 3,
        failed: 0,
      });

      const summary = summarizePartialResult(result);

      expect(summary).toContain("Complete");
      expect(summary).toContain("3");
    });

    test("should summarize partial result", () => {
      const result = partial([1], [], {
        attempted: 3,
        succeeded: 1,
        failed: 2,
      });

      const summary = summarizePartialResult(result);

      expect(summary).toContain("Partial");
      expect(summary).toContain("33.3%");
      expect(summary).toContain("1 succeeded");
      expect(summary).toContain("2 failed");
    });

    test("should summarize failed result", () => {
      const result = failed([], new Error("Test error"));

      const summary = summarizePartialResult(result);

      expect(summary).toContain("Failed");
      expect(summary).toContain("Test error");
    });
  });
});
