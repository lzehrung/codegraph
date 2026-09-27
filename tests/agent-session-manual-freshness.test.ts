import fsp from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession } from "../src/agent/session.js";
import { workspaceSymbolsWithSession } from "../src/agent/workspace-symbols.js";
import { mkTmpDir } from "./helpers/filesystem.js";

describe("agent session freshness under a manual policy never claims fresh without evidence", () => {
  it("reports an explicit unchecked state instead of a false fresh claim after an on-disk edit", async () => {
    const root = await mkTmpDir("cg-");
    try {
      const mathFile = path.join(root, "math.ts");
      const original = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
      const edited =
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n" +
        "export function sub(a: number, b: number): number {\n  return a - b;\n}\n";
      await fsp.writeFile(mathFile, original, "utf8");

      const manualSession = createAgentSession({
        root,
        buildOptions: { cache: "off" },
        freshness: { policy: "manual" },
      });
      await manualSession.loadProject({ symbolGraph: "skip" });

      // Decoy/control: the identical edit under "check" policy is a real, honest check, so a
      // manual-only bug cannot masquerade as expected behavior for every policy.
      const checkSession = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "check" } });
      await checkSession.loadProject({ symbolGraph: "skip" });

      await fsp.writeFile(mathFile, edited, "utf8");

      const manualFreshness = await manualSession.checkFreshness!();
      expect(manualFreshness.state).not.toBe("fresh");
      expect(manualFreshness).toEqual({
        state: "unchecked",
        reason: "freshness policy is manual; call invalidate() explicitly after edits",
      });

      const checkFreshness = await checkSession.checkFreshness!();
      expect(checkFreshness.state).toBe("stale");

      // Manual truly does not auto-invalidate: loadProject keeps serving the stale snapshot.
      // That is unchanged by the fix -- only the dishonest "fresh" label is fixed.
      const manualSnapshot = await manualSession.loadProject({ symbolGraph: "skip" });
      const manualExports = [...manualSnapshot.index.byFile.values()][0]!.exports.flatMap((entry) =>
        entry.type === "local" ? [entry.exportedAs] : [],
      );
      expect(manualExports).not.toContain("sub");

      manualSession.invalidate();
      checkSession.invalidate();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the real workspaceSymbolsWithSession consumer honest under manual policy", async () => {
    const root = await mkTmpDir("cg-consumer-");
    try {
      const mathFile = path.join(root, "math.ts");
      await fsp.writeFile(
        mathFile,
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
        "utf8",
      );
      const session = createAgentSession({ root, buildOptions: { cache: "off" }, freshness: { policy: "manual" } });

      const before = await workspaceSymbolsWithSession(session, { root, query: "add", limit: 20 });
      expect(before.symbols.some((symbol) => symbol.name === "add")).toBe(true);

      await fsp.writeFile(
        mathFile,
        "export function add(a: number, b: number): number {\n  return a + b;\n}\n" +
          "export function sub(a: number, b: number): number {\n  return a - b;\n}\n",
        "utf8",
      );

      const after = await workspaceSymbolsWithSession(session, { root, query: "sub", limit: 20 });
      expect(after.freshness).toEqual({
        state: "unchecked",
        reason: "freshness policy is manual; call invalidate() explicitly after edits",
      });
      // The audited defect: symbols is still missing "sub" because manual truly does not
      // auto-invalidate; the fix only requires the freshness label to stop lying about it.
      expect(after.symbols.some((symbol) => symbol.name === "sub")).toBe(false);

      session.invalidate();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});
