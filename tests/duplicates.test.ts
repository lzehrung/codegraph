import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "../src/cli.js";
import { buildProjectIndex, findDuplicates } from "../src/index.js";

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

    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]?.cloneType).toBe("exact");
    expect(result.suggestions[0]?.confidence).toBe("high");
    expect(result.suggestions[0]?.left.file).toBe("src/a.ts");
    expect(result.suggestions[0]?.right.file).toBe("src/b.ts");
  });

  test("returns bounded suggestions with omission counts", async () => {
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

    expect(result.suggestions).toHaveLength(1);
    expect(result.omittedCounts.suggestions).toBeGreaterThan(0);
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
    const match = result.suggestions.find(
      (suggestion) => suggestion.left.file === "src/accounts.ts" || suggestion.right.file === "src/accounts.ts",
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

    expect(result.suggestions).toHaveLength(0);
  });

  test("filters small helpers unless explicitly included", async () => {
    const root = await makeTempProject();
    const source = `export function sameTiny(value: number) { return value + 1; }\n`;

    await writeProjectFile(root, "a.ts", source);
    await writeProjectFile(root, "b.ts", source);

    const index = await buildProjectIndex(root);
    const defaultResult = await findDuplicates(index, { minConfidence: "low" });
    const includedResult = await findDuplicates(index, { includeSmall: true, minConfidence: "high" });

    expect(defaultResult.suggestions).toHaveLength(0);
    expect(defaultResult.omittedCounts.belowThresholdUnits).toBeGreaterThan(0);
    expect(includedResult.suggestions.length).toBeGreaterThan(0);
  });

  test("rejects invalid token bounds", async () => {
    const root = await makeTempProject();

    await writeProjectFile(root, "src/a.ts", `export function a() { return 1; }\n`);

    const index = await buildProjectIndex(root);
    await expect(findDuplicates(index, { minTokens: 20, maxTokens: 10 })).rejects.toThrow(
      "Expected a value greater than or equal to minTokens",
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

    expect(result.suggestions).toHaveLength(0);
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
      suggestions?: Array<{ left?: { file?: string; tokenCount?: number }; right?: { file?: string } }>;
    };

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions?.[0]?.left?.file).toBe("configs/a.json");
    expect(parsed.suggestions?.[0]?.right?.file).toBe("configs/b.json");
    expect(parsed.suggestions?.[0]?.left?.tokenCount).toBeGreaterThan(40);
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

    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0]?.left.file).toBe("src/a.ts");
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

    expect(defaultResult.suggestions).toHaveLength(0);
    expect(sameFileResult.suggestions.length).toBeGreaterThan(0);
    expect(sameFileResult.suggestions[0]?.left.file).toBe("src/local.ts");
    expect(sameFileResult.suggestions[0]?.right.file).toBe("src/local.ts");
  });

  test("duplicates CLI emits bounded JSON suggestions", async () => {
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
    const parsed = JSON.parse(result.stdout) as { suggestions?: Array<{ score?: number }> };

    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toBe("");
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions?.[0]?.score).toBeGreaterThan(90);
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

    expect(result.suggestions).toHaveLength(0);
    expect(result.omittedCounts.oversizedBuckets).toBeGreaterThan(0);
  });
});
