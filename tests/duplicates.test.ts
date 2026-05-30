import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.js";
import { appendDuplicateLeadSummary } from "../src/duplicatesLeads.js";
import { buildProjectIndex, findDuplicateContext, findDuplicates } from "../src/index.js";

const tempRoots: string[] = [];

async function makeTempProject(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codegraph-duplicates-"));
  tempRoots.push(root);
  return root.replace(/\\/g, "/");
}

async function writeProjectFile(root: string, relativePath: string, source: string): Promise<string> {
  const filePath = path.join(root, relativePath).replace(/\\/g, "/");
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, source);
  return filePath;
}

async function captureCli(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  let stdout = "";
  let stderr = "";
  let exitCode: number | undefined;

  await runCli(args, {
    cwd: () => cwd,
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
    exit: (code) => {
      exitCode = code;
      throw new Error(`cli exit ${code}`);
    },
  }).catch((error: unknown) => {
    if (error instanceof Error && exitCode !== undefined && error.message === `cli exit ${exitCode}`) return;
    throw error;
  });

  return { stdout, stderr, exitCode };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(async (root) => await fsp.rm(root, { recursive: true, force: true })));
});

describe("duplicate detection", () => {
  test("duplicate lead summaries retain omitted counts when no lead survives filters", () => {
    const lines: string[] = [];

    appendDuplicateLeadSummary(lines, {
      scope: "changed",
      leads: [],
      omittedCounts: {
        byBudget: 0,
        byConfidenceOrType: 2,
        byScope: 3,
        hiddenEvidence: 0,
      },
    });

    expect(lines).toContain("Duplicate leads:");
    expect(lines).toContain("- none after confidence/type filters");
    expect(lines).toContain("- omitted: 2 by confidence/type, 3 outside changed scope");
  });

  test("reports exact duplicate functions across files", async () => {
    const root = await makeTempProject();
    const duplicateSource = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/a.ts", duplicateSource);
    await writeProjectFile(root, "src/b.ts", duplicateSource);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, { minConfidence: "high", limit: 5 });

    expect(result.schemaVersion).toBe(2);
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.groups[0]?.cloneType).toBe("exact");
    expect(result.groups[0]?.confidence).toBe("high");
    expect(result.groups[0]?.primaryLeft.file).toBe("src/a.ts");
    expect(result.groups[0]?.primaryRight.file).toBe("src/b.ts");
  });

  test("adds stable handles to duplicate units", async () => {
    const root = await makeTempProject();
    const duplicateSource = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/a.ts", duplicateSource);
    await writeProjectFile(root, "src/b.ts", duplicateSource);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, { minConfidence: "high", limit: 1 });
    const unit = result.groups[0]?.primaryLeft;

    expect(unit?.fileHandle).toBe("file:src%2Fa.ts");
    expect(unit?.chunkHandle).toBe("chunk:src%2Fa.ts:2");
    expect(unit?.symbolHandle).toBe("symbol:src%2Fa.ts:normalizeInvoiceRows:2:17");
    expect(unit?.handle).toBe(unit?.symbolHandle);
  });

  test("filters duplicate context by target before limiting", async () => {
    const root = await makeTempProject();
    const firstSource = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;
    const secondSource = `
export function scoreUsers(users: Array<{ active: boolean; points: number }>) {
  const scored: number[] = [];
  const labels: string[] = [];
  for (const user of users) {
    const base = user.active ? user.points : 0;
    const bonus = base > 50 ? 10 : 2;
    const label = bonus > 5 ? "priority" : "standard";
    labels.push(label);
    scored.push(base + bonus);
  }
  const total = scored.reduce((currentTotal, value) => currentTotal + value, 0);
  return total + labels.filter((label) => label.length > 0).length;
}
`;

    await writeProjectFile(root, "src/a.ts", firstSource);
    await writeProjectFile(root, "src/b.ts", firstSource);
    await writeProjectFile(root, "src/c.ts", secondSource);
    await writeProjectFile(root, "src/d.ts", secondSource);

    const index = await buildProjectIndex(root);
    const result = await findDuplicateContext(index, { file: "src/c.ts" }, { minConfidence: "high", limit: 1 });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.primaryLeft.file).toBe("src/c.ts");
    expect(result.groups[0]?.primaryRight.file).toBe("src/d.ts");
  });

  test("duplicate context includes target matches from raw variants without exposing raw pairs by default", async () => {
    const root = await makeTempProject();
    const source = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;
    for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
      await writeProjectFile(root, `src/${name}.ts`, source);
    }

    const index = await buildProjectIndex(root);
    const target = { file: "src/g.ts" };
    const result = await findDuplicateContext(index, target, { minConfidence: "high", limit: 5 });
    const rawResult = await findDuplicateContext(index, target, { includeRawPairs: true, minConfidence: "high", limit: 5 });

    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.groups.some((group) => group.primaryLeft.file === "src/g.ts" || group.primaryRight.file === "src/g.ts")).toBeTruthy();
    expect(result.suggestions).toBeUndefined();
    for (const group of result.groups) {
      const rawGroup = rawResult.groups.find((entry) => entry.id === group.id);
      expect(rawGroup).toBeDefined();
      expect(group.variantCount).toBeLessThanOrEqual(5);
      expect(group.omittedVariantCount).toBe(Math.max(0, (rawGroup?.variantCount ?? 0) - group.variantCount));
    }
  });

  test("groups overlapping symbol and chunk variants into one finding", async () => {
    const root = await makeTempProject();
    const duplicateSource = `
export function normalizeInvoiceRows(rows: Array<{ amount: number; tax: number }>) {
  const totals: number[] = [];
  const labels: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    labels.push(label);
    totals.push(rounded);
  }
  const encoded = totals.map((value, index) => labels[index] + ":" + value.toFixed(2));
  return encoded.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/a.ts", duplicateSource);
    await writeProjectFile(root, "src/b.ts", duplicateSource);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, { includeRawPairs: true, minConfidence: "high", limit: 5 });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.variantCount).toBeGreaterThan(1);
    expect(result.groups[0]?.primaryLeft.kind).toBe("symbol");
    expect(result.groups[0]?.primaryRight.kind).toBe("symbol");
    expect(result.suggestions?.length).toBeGreaterThan(result.groups.length);
    // With includeRawPairs the variant list is unbounded, so coalescing must not
    // report omitted variants from deduping merged groups.
    expect(result.groups[0]?.omittedVariantCount).toBe(0);
  });

  test("omits raw unit pairs unless requested", async () => {
    const root = await makeTempProject();
    const source = `
export function summarizePayments(rows: Array<{ amount: number; fee: number }>) {
  const output: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.fee;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/a.ts", source);
    await writeProjectFile(root, "src/b.ts", source);

    const index = await buildProjectIndex(root);
    const defaultResult = await findDuplicates(index, { minConfidence: "high", limit: 5 });
    const rawResult = await findDuplicates(index, { includeRawPairs: true, minConfidence: "high", limit: 5 });
    const defaultGroup = defaultResult.groups[0];
    const rawGroup = rawResult.groups[0];

    expect(defaultResult.groups.length).toBeGreaterThan(0);
    expect(defaultResult.suggestions).toBeUndefined();
    expect(defaultResult.omittedCounts.rawSuggestions).toBeGreaterThan(0);
    expect(defaultGroup?.rawPairCount).toBeGreaterThanOrEqual(defaultGroup?.variantCount ?? 0);
    expect(defaultGroup?.omittedVariantCount).toBe(
      (defaultGroup?.rawPairCount ?? 0) - (defaultGroup?.variantCount ?? 0),
    );
    expect(rawResult.suggestions?.length).toBeGreaterThan(0);
    expect(rawGroup?.rawPairCount).toBe(rawGroup?.variantCount);
    expect(rawGroup?.omittedVariantCount).toBe(0);
  });

  test("returns bounded groups with omission counts", async () => {
    const root = await makeTempProject();
    const source = `
export function summarizePayments(rows: Array<{ amount: number; fee: number }>) {
  const output: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.fee;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/a.ts", source);
    await writeProjectFile(root, "src/b.ts", source);
    await writeProjectFile(root, "src/c.ts", source);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, { minConfidence: "high", limit: 1 });

    expect(result.groups).toHaveLength(1);
    expect(result.omittedCounts.groups).toBeGreaterThan(0);
    expect(result.omittedCounts.suggestions).toBeGreaterThan(0);
    expect(result.stats.candidatePairs).toBeGreaterThan(0);
    expect(result.stats.comparedPairs).toBeGreaterThan(0);
  });

  test("reports renamed near duplicates through normalized tokens", async () => {
    const root = await makeTempProject();

    await writeProjectFile(
      root,
      "src/users.ts",
      `
export function scoreUsers(users: Array<{ active: boolean; points: number }>) {
  const scored: number[] = [];
  const labels: string[] = [];
  for (const user of users) {
    const base = user.active ? user.points : 0;
    const bonus = base > 50 ? 10 : 2;
    const label = bonus > 5 ? "priority" : "standard";
    labels.push(label);
    scored.push(base + bonus);
  }
  const total = scored.reduce((currentTotal, value) => currentTotal + value, 0);
  return total + labels.filter((label) => label.length > 0).length;
}
`,
    );
    await writeProjectFile(
      root,
      "src/accounts.ts",
      `
export function scoreAccounts(accounts: Array<{ enabled: boolean; credits: number }>) {
  const values: number[] = [];
  const tags: string[] = [];
  for (const account of accounts) {
    const baseValue = account.enabled ? account.credits : 0;
    const extra = baseValue > 50 ? 10 : 2;
    const tag = extra > 5 ? "priority" : "standard";
    tags.push(tag);
    values.push(baseValue + extra);
  }
  const sum = values.reduce((accumulator, current) => accumulator + current, 0);
  return sum + tags.filter((tag) => tag.length > 0).length;
}
`,
    );

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, { minConfidence: "medium", limit: 5 });
    const match = result.groups.find(
      (group) => group.primaryLeft.file === "src/accounts.ts" || group.primaryRight.file === "src/accounts.ts",
    );

    expect(match).toBeDefined();
    expect(match?.cloneType === "renamed" || match?.cloneType === "near").toBeTruthy();
    expect(match?.metrics.tokenJaccard).toBeGreaterThan(0.6);
  });

  test("does not report matching signatures as high-confidence symbol clones", async () => {
    const root = await makeTempProject();

    await writeProjectFile(
      root,
      "src/a.ts",
      `
export function sharedName(input: string): string {
  const reversed = input.split("").reverse();
  const upper = reversed.join("").toUpperCase();
  return upper.slice(0, 12);
}
`,
    );
    await writeProjectFile(
      root,
      "src/b.ts",
      `
export function sharedName(input: string): string {
  const parsed = JSON.parse(input) as { name?: string };
  if (typeof parsed.name === "string") {
    return parsed.name.trim().toLowerCase();
  }
  return "missing";
}
`,
    );

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, {
      includeSmall: true,
      minConfidence: "high",
    });

    expect(result.groups).toHaveLength(0);
  });

  test("filters small helpers unless explicitly included", async () => {
    const root = await makeTempProject();
    const source = `export function sameTiny(value: number) { return value + 1; }\n`;

    await writeProjectFile(root, "a.ts", source);
    await writeProjectFile(root, "b.ts", source);

    const index = await buildProjectIndex(root);
    const defaultResult = await findDuplicates(index, { minConfidence: "low" });
    const includedResult = await findDuplicates(index, { includeSmall: true, minConfidence: "high" });

    expect(defaultResult.groups).toHaveLength(0);
    expect(defaultResult.omittedCounts.belowThresholdUnits).toBeGreaterThan(0);
    expect(includedResult.groups.length).toBeGreaterThan(0);
  });

  test("rejects invalid token bounds", async () => {
    const root = await makeTempProject();

    await writeProjectFile(root, "src/a.ts", `export function a() { return 1; }\n`);

    const index = await buildProjectIndex(root);
    await expect(findDuplicates(index, { minTokens: 20, maxTokens: 10 })).rejects.toThrow(
      "Expected a value greater than or equal to minTokens",
    );
  });

  test("rejects invalid numeric options", async () => {
    const root = await makeTempProject();

    await writeProjectFile(root, "src/a.ts", `export function a() { return 1; }\n`);

    const index = await buildProjectIndex(root);
    await expect(findDuplicates(index, { limit: -1 })).rejects.toThrow(
      'Invalid limit value "-1". Expected a non-negative integer.',
    );
    await expect(findDuplicates(index, { minTokens: 0 })).rejects.toThrow(
      'Invalid minTokens value "0". Expected a positive integer.',
    );
    await expect(findDuplicates(index, { shingleSize: Number.NaN })).rejects.toThrow(
      'Invalid shingleSize value "NaN". Expected a positive integer.',
    );
  });

  test("keeps cross-language exact text in separate candidate buckets", async () => {
    const root = await makeTempProject();
    const source = `
export function sharedClone(rows) {
  const output = [];
  for (const row of rows) {
    const subtotal = row.amount + row.fee;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/a.ts", source);
    await writeProjectFile(root, "src/b.js", source);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, { includeSmall: true, minConfidence: "high" });

    expect(result.groups).toHaveLength(0);
  });

  test("duplicates CLI detects duplicate JSON text files", async () => {
    const root = await makeTempProject();
    const source = JSON.stringify({
      workflows: [
        { name: "build", command: "npm run build", retries: 2 },
        { name: "test", command: "npm run test:ci", retries: 1 },
        { name: "lint", command: "npm run lint", retries: 1 },
      ],
      env: {
        CI: true,
        NODE_OPTIONS: "--max-old-space-size=4096",
      },
    });

    await writeProjectFile(root, "configs/a.json", source);
    await writeProjectFile(root, "configs/b.json", source);

    const result = await captureCli(
      ["duplicates", "--root", ".", "configs", "--min-confidence", "high", "--limit", "1"],
      root,
    );
    const parsed = JSON.parse(result.stdout) as {
      groups?: Array<{ primaryLeft?: { file?: string; tokenCount?: number }; primaryRight?: { file?: string } }>;
    };

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups?.[0]?.primaryLeft?.file).toBe("configs/a.json");
    expect(parsed.groups?.[0]?.primaryRight?.file).toBe("configs/b.json");
    expect(parsed.groups?.[0]?.primaryLeft?.tokenCount).toBeGreaterThan(40);
  });

  test("accepts project-relative file filters", async () => {
    const root = await makeTempProject();
    const source = `export function sameTiny(value: number) { return value + 1; }\n`;

    await writeProjectFile(root, "src/a.ts", source);
    await writeProjectFile(root, "src/b.ts", source);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, {
      projectRoot: root,
      files: ["src/a.ts", "src/b.ts"],
      includeSmall: true,
      minConfidence: "high",
    });

    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.groups[0]?.primaryLeft.file).toBe("src/a.ts");
  });

  test("rejects duplicate file filters outside the project root", async () => {
    const root = await makeTempProject();
    const outsideFile = path.join(path.dirname(root), "outside.ts").replace(/\\/g, "/");

    await writeProjectFile(root, "src/a.ts", `export function a() { return 1; }\n`);

    const index = await buildProjectIndex(root);
    await expect(
      findDuplicates(index, {
        projectRoot: root,
        files: [outsideFile],
      }),
    ).rejects.toThrow("Duplicate input file is outside project root");
  });

  test("includes same-file non-overlapping clones only when requested", async () => {
    const root = await makeTempProject();
    const source = `
export function firstClone(rows: number[]) {
  const output: number[] = [];
  for (const row of rows) {
    const doubled = row * 2;
    const adjusted = doubled + 3;
    output.push(adjusted);
  }
  return output.filter((value) => value > 10).join(",");
}

export function secondClone(rows: number[]) {
  const output: number[] = [];
  for (const row of rows) {
    const doubled = row * 2;
    const adjusted = doubled + 3;
    output.push(adjusted);
  }
  return output.filter((value) => value > 10).join(",");
}
`;

    await writeProjectFile(root, "src/local.ts", source);

    const index = await buildProjectIndex(root);
    const defaultResult = await findDuplicates(index, { includeSmall: true, minConfidence: "medium" });
    const sameFileResult = await findDuplicates(index, {
      includeSmall: true,
      includeSameFile: true,
      minConfidence: "medium",
    });

    expect(defaultResult.groups).toHaveLength(0);
    expect(sameFileResult.groups.length).toBeGreaterThan(0);
    expect(sameFileResult.groups[0]?.primaryLeft.file).toBe("src/local.ts");
    expect(sameFileResult.groups[0]?.primaryRight.file).toBe("src/local.ts");
  });

  test("does not collapse same-file inner clones into self-duplicate groups", async () => {
    const root = await makeTempProject();
    const source = `
export class InvoiceNormalizer {
  normalizeDomestic(rows: Array<{ amount: number; tax: number }>) {
    const output: string[] = [];
    for (const row of rows) {
      const subtotal = row.amount + row.tax;
      const rounded = Math.round(subtotal * 100) / 100;
      const label = rounded > 100 ? "large" : "small";
      output.push(label + ":" + rounded.toFixed(2));
    }
    return output.filter((value) => value.includes(":")).join(",");
  }

  normalizeInternational(rows: Array<{ amount: number; tax: number }>) {
    const output: string[] = [];
    for (const row of rows) {
      const subtotal = row.amount + row.tax;
      const rounded = Math.round(subtotal * 100) / 100;
      const label = rounded > 100 ? "large" : "small";
      output.push(label + ":" + rounded.toFixed(2));
    }
    return output.filter((value) => value.includes(":")).join(",");
  }
}
`;

    await writeProjectFile(root, "src/local-class.ts", source);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, {
      includeSameFile: true,
      minConfidence: "high",
      limit: 10,
    });

    const sameFileGroups = result.groups.filter((group) => group.primaryLeft.file === group.primaryRight.file);
    expect(sameFileGroups.length).toBeGreaterThan(0);
    for (const group of sameFileGroups) {
      expect({ startLine: group.primaryLeft.startLine, endLine: group.primaryLeft.endLine }).not.toEqual({
        startLine: group.primaryRight.startLine,
        endLine: group.primaryRight.endLine,
      });
    }
  });

  test("coalesces repeated groups with the same primary ranges", async () => {
    const root = await makeTempProject();
    const source = `
export class InvoiceNormalizer {
  normalizeDomestic(rows: Array<{ amount: number; tax: number }>) {
    const output: string[] = [];
    for (const row of rows) {
      const subtotal = row.amount + row.tax;
      const rounded = Math.round(subtotal * 100) / 100;
      const label = rounded > 100 ? "large" : "small";
      output.push(label + ":" + rounded.toFixed(2));
    }
    return output.filter((value) => value.includes(":")).join(",");
  }

  normalizeInternational(rows: Array<{ amount: number; tax: number }>) {
    const output: string[] = [];
    for (const row of rows) {
      const subtotal = row.amount + row.tax;
      const rounded = Math.round(subtotal * 100) / 100;
      const label = rounded > 100 ? "large" : "small";
      output.push(label + ":" + rounded.toFixed(2));
    }
    return output.filter((value) => value.includes(":")).join(",");
  }
}
`;

    await writeProjectFile(root, "src/a.ts", source);
    await writeProjectFile(root, "src/b.ts", source);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, {
      includeSameFile: true,
      minConfidence: "high",
      limit: 20,
    });
    const primaryPairKeys = result.groups.map((group) => {
      const left = `${group.primaryLeft.file}:${group.primaryLeft.startLine}-${group.primaryLeft.endLine}`;
      const right = `${group.primaryRight.file}:${group.primaryRight.startLine}-${group.primaryRight.endLine}`;
      return [left, right].sort().join("=");
    });

    expect(result.groups.length).toBeGreaterThan(0);
    expect(new Set(primaryPairKeys).size).toBe(primaryPairKeys.length);
  });

  test("duplicates CLI emits bounded JSON groups", async () => {
    const root = await makeTempProject();
    const source = `
export function summarizeOrders(rows: Array<{ amount: number; tax: number }>) {
  const output: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/orders-a.ts", source);
    await writeProjectFile(root, "src/orders-b.ts", source);

    const result = await captureCli(["duplicates", "src", "--min-confidence", "high", "--limit", "1"], root);
    const parsed = JSON.parse(result.stdout) as { groups?: Array<{ score?: number }> };

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(parsed.groups).toHaveLength(1);
    expect(parsed.groups?.[0]?.score).toBeGreaterThan(90);
  });

  test("duplicates CLI includes raw suggestions only with --raw-pairs", async () => {
    const root = await makeTempProject();
    const source = `
export function summarizeOrders(rows: Array<{ amount: number; tax: number }>) {
  const output: string[] = [];
  for (const row of rows) {
    const subtotal = row.amount + row.tax;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/orders-a.ts", source);
    await writeProjectFile(root, "src/orders-b.ts", source);

    const defaultResult = await captureCli(["duplicates", "src", "--min-confidence", "high", "--limit", "5"], root);
    const rawResult = await captureCli(
      ["duplicates", "src", "--min-confidence", "high", "--limit", "5", "--raw-pairs"],
      root,
    );
    const defaultParsed = JSON.parse(defaultResult.stdout) as { suggestions?: unknown[] };
    const rawParsed = JSON.parse(rawResult.stdout) as { suggestions?: unknown[] };

    expect(defaultResult.exitCode).toBeUndefined();
    expect(rawResult.exitCode).toBeUndefined();
    expect(defaultParsed.suggestions).toBeUndefined();
    expect(rawParsed.suggestions?.length).toBeGreaterThan(0);
  });

  test("duplicates CLI accepts a zero suggestion limit", async () => {
    const root = await makeTempProject();
    const source = `
export function sameRows(rows: number[]) {
  const output: number[] = [];
  for (const row of rows) {
    output.push(row * 2 + 1);
  }
  return output.join(",");
}
`;

    await writeProjectFile(root, "src/a.ts", source);
    await writeProjectFile(root, "src/b.ts", source);

    const result = await captureCli(["duplicates", "--root", ".", "src", "--limit", "0", "--include-small"], root);
    const parsed = JSON.parse(result.stdout) as {
      groups?: unknown[];
      omittedCounts?: { groups?: number; suggestions?: number; candidatePairs?: number };
      stats?: { candidatePairs?: number };
    };

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(parsed.groups).toHaveLength(0);
    expect(parsed.omittedCounts?.groups).toBeGreaterThan(0);
    expect(parsed.omittedCounts?.suggestions).toBeGreaterThan(0);
    expect(parsed.omittedCounts?.candidatePairs).toBeUndefined();
    expect(parsed.stats?.candidatePairs).toBeGreaterThan(0);
  });

  test("counts only considered fingerprints when oversized buckets are skipped", async () => {
    const root = await makeTempProject();
    const punctuationBlock = (characters: string, lines: number): string =>
      Array.from({ length: lines }, (_, line) => {
        let value = "";
        for (let offset = 0; offset < 5; offset++) {
          value += characters[(line * 7 + offset * 3) % characters.length];
        }
        return value;
      }).join("\n");
    const commonOversizedBlock = punctuationBlock("(){}[]<>+-*/%=!?:;,.|&^~", 40);
    const sharedEligibleBlock = punctuationBlock("@#$\\_", 8);
    const leftUniqueBlock = punctuationBlock("(){}[]<>+-*/%=!?:;,.|&^~", 80);
    const rightUniqueBlock = punctuationBlock("~~~~^^^^||||&&&&!!!!????::::;;;;,,,,....", 80);
    const thirdUniqueBlock = punctuationBlock("<<<<>>>>====++++----****////%%%%", 10);

    await writeProjectFile(root, "src/index.ts", "export const marker = 1;\n");
    await writeProjectFile(root, "src/a.txt", `${commonOversizedBlock}\n${sharedEligibleBlock}\n${leftUniqueBlock}\n+`);
    await writeProjectFile(
      root,
      "src/b.txt",
      `${commonOversizedBlock}\n${sharedEligibleBlock}\n${rightUniqueBlock}\n-`,
    );
    await writeProjectFile(root, "src/c.txt", `${commonOversizedBlock}\n${thirdUniqueBlock}\n#`);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, {
      projectRoot: root,
      files: ["src/a.txt", "src/b.txt", "src/c.txt"],
      includeSmall: true,
      maxBucketSize: 2,
      minConfidence: "low",
    });

    expect(result.omittedCounts.oversizedBuckets).toBeGreaterThan(0);
    expect(
      result.groups.some((group) => group.primaryLeft.file === "src/a.txt" && group.primaryRight.file === "src/b.txt"),
    ).toBeTruthy();
  });

  test("skips oversized candidate buckets", async () => {
    const root = await makeTempProject();
    const source = `
export function sharedOversizedClone(rows) {
  const output = [];
  for (const row of rows) {
    const subtotal = row.amount + row.fee;
    const rounded = Math.round(subtotal * 100) / 100;
    const label = rounded > 100 ? "large" : "small";
    output.push(label + ":" + rounded.toFixed(2));
  }
  return output.filter((value) => value.includes(":")).join(",");
}
`;

    await writeProjectFile(root, "src/a.ts", source);
    await writeProjectFile(root, "src/b.ts", source);
    await writeProjectFile(root, "src/c.ts", source);

    const index = await buildProjectIndex(root);
    const result = await findDuplicates(index, {
      includeSmall: true,
      maxBucketSize: 2,
      minConfidence: "high",
    });

    expect(result.groups).toHaveLength(0);
    expect(result.omittedCounts.oversizedBuckets).toBeGreaterThan(0);
  });
});
