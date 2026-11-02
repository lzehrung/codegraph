import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatAgentSymbolHandle } from "../src/agent/handles.js";
import { normalizeAgentFilePath } from "../src/agent/normalize.js";
import { resolveSemanticSymbol } from "../src/agent/semantic-symbols.js";
import { createAgentSession, type AgentProjectSnapshot, type AgentSession } from "../src/agent/session.js";
import { buildSymbolLookup } from "../src/agent/symbol-lookup.js";
import { normalizePath } from "../src/util/paths.js";
import { createTempRootRegistry } from "./helpers/filesystem.js";

const tempRoots = createTempRootRegistry();
const sessions: AgentSession[] = [];

async function createProject(): Promise<{ root: string; session: AgentSession }> {
  const root = await tempRoots.create("cg-semantic-symbols-");
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(
    path.join(root, "src", "a.ts"),
    [
      "export function alpha() { return 1; }",
      "export function beta() { return alpha(); }",
      "export function alpha2() { return beta(); }",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(root, "src", "b.ts"),
    ["export function alpha() { return 2; }", "export const gamma = () => 3;", ""].join("\n"),
  );
  const session = createAgentSession({ root });
  sessions.push(session);
  return { root, session };
}

/** The portable handle of the definition named `name` in `file`, read from the snapshot's own definitions. */
function handleFor(
  snapshot: AgentProjectSnapshot,
  file: string,
  name: string,
  shift: { line?: number; column?: number } = {},
): string {
  for (const def of buildSymbolLookup(snapshot).defById.values()) {
    if (def.localName !== name || !normalizePath(def.file).endsWith(`/${file}`)) continue;
    return formatAgentSymbolHandle({
      file,
      name,
      line: def.range.start.line + (shift.line ?? 0),
      column: def.range.start.column + (shift.column ?? 0),
    });
  }
  throw new Error(`No definition ${name} in ${file}.`);
}

describe("resolveSemanticSymbol", () => {
  afterEach(async () => {
    for (const session of sessions.splice(0)) session.invalidate();
    await tempRoots.cleanup();
  });

  it("resolves a handle to the first definition a scan of every definition would find", async () => {
    const { root, session } = await createProject();
    const snapshot = await session.loadProject({ symbolGraph: "skip" });
    const lookup = buildSymbolLookup(snapshot);

    let resolved = 0;
    for (const def of lookup.defById.values()) {
      const handle = formatAgentSymbolHandle({
        file: normalizeAgentFilePath(root, def.file),
        name: def.localName,
        line: def.range.start.line,
        column: def.range.start.column,
      });
      const expected = [...lookup.defById].find(
        ([, candidate]) =>
          normalizePath(candidate.file) === normalizePath(def.file) &&
          candidate.localName === def.localName &&
          candidate.range.start.line === def.range.start.line &&
          candidate.range.start.column === def.range.start.column,
      );
      const actual = resolveSemanticSymbol(snapshot, handle);
      expect(actual?.id).toBe(expected?.[0]);
      expect(actual?.def).toBe(expected?.[1]);
      resolved += 1;
    }
    expect(resolved).toBeGreaterThanOrEqual(5);

    // The same name in another file resolves in that file; a moved position, an unknown file, and a malformed handle do not.
    expect(resolveSemanticSymbol(snapshot, handleFor(snapshot, "src/a.ts", "alpha"))?.def.file).toMatch(
      /src[\\/]a\.ts$/,
    );
    expect(resolveSemanticSymbol(snapshot, handleFor(snapshot, "src/b.ts", "alpha"))?.def.file).toMatch(
      /src[\\/]b\.ts$/,
    );
    expect(resolveSemanticSymbol(snapshot, handleFor(snapshot, "src/a.ts", "alpha", { line: 1 }))).toBeNull();
    expect(resolveSemanticSymbol(snapshot, handleFor(snapshot, "src/a.ts", "alpha", { column: 1 }))).toBeNull();
    const elsewhere = formatAgentSymbolHandle({ file: "src/c.ts", name: "alpha", line: 1, column: 1 });
    expect(resolveSemanticSymbol(snapshot, elsewhere)).toBeNull();
    expect(resolveSemanticSymbol(snapshot, "symbol:malformed")).toBeNull();
  });

  it("resolves against the refreshed snapshot after a file edit, not a stale handle map", async () => {
    const { root, session } = await createProject();
    const before = await session.loadProject({ symbolGraph: "skip" });
    const betaBefore = handleFor(before, "src/a.ts", "beta");
    expect(resolveSemanticSymbol(before, betaBefore)?.def.localName).toBe("beta");

    await fs.writeFile(
      path.join(root, "src", "a.ts"),
      [
        "// A leading comment moves every definition down one line.",
        "export function alpha() { return 1; }",
        "export function beta() { return alpha(); }",
        "export function alpha2() { return beta(); }",
        "",
      ].join("\n"),
    );
    session.invalidate();
    const after = await session.loadProject({ symbolGraph: "skip" });

    expect(after).not.toBe(before);
    expect(resolveSemanticSymbol(after, betaBefore)).toBeNull();
    expect(resolveSemanticSymbol(after, handleFor(after, "src/a.ts", "beta"))?.def.localName).toBe("beta");
    // The earlier snapshot still answers for the file it indexed.
    expect(resolveSemanticSymbol(before, betaBefore)?.def.localName).toBe("beta");
  });
});
