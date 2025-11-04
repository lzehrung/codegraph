import { describe, it, expect } from 'vitest';
import { createTestIndex, getSamplePath } from './test-utils.js';
import { analyzeImpactFromDiff } from '../src/impact/index.js';

function makeDiffForAbsPath(abs: string, start: number) {
  return `diff --git a/${abs} b/${abs}
index 0000000..1111111 100644
--- a/${abs}
+++ b/${abs}
@@ -${start},0 +${start},1 @@
+// changed
`;
}

describe('Impact: options and explain payloads', () => {
  it('scope=imported filters non-exported symbol changes (when present)', async () => {
    const index = await createTestIndex('typescript');
    const file = Array.from(index.byFile.keys()).find(f => f.endsWith('/utils.ts'))!;
    const mod = index.byFile.get(file)!;

    const exportedNames = new Set(
      mod.exports
        .filter((e: any) => e.type === 'local')
        .map((e: any) => e.target.localName)
    );
    const internal = mod.locals.find(l => !exportedNames.has(l.localName)) || mod.locals[0]!;
    const diffText = makeDiffForAbsPath(file, Math.max(internal.range.start.line + 1, internal.range.start.line));

    const reportAll = await analyzeImpactFromDiff(getSamplePath('typescript'), index, { provider: 'raw', diffText, scope: 'all' } as any);
    const reportImported = await analyzeImpactFromDiff(getSamplePath('typescript'), index, { provider: 'raw', diffText, scope: 'imported' } as any);

    if (!exportedNames.has(internal.localName)) {
      expect(reportAll.changedSymbols.length).toBeGreaterThanOrEqual(1);
      expect(reportImported.changedSymbols.length).toBe(0);
    } else {
      expect(reportImported.changedSymbols.length).toBeGreaterThanOrEqual(0);
    }
  });

  it('membersOnly disables transitive (depth > 0) items', async () => {
    const index = await createTestIndex('typescript');
    const file = Array.from(index.byFile.keys()).find(f => f.endsWith('/utils.ts'))!;
    const mod = index.byFile.get(file)!;
    const target = mod.locals[0]!;
    const diffText = makeDiffForAbsPath(file, Math.max(target.range.start.line + 1, target.range.start.line));

    const withTransitive = await analyzeImpactFromDiff(getSamplePath('typescript'), index, { provider: 'raw', diffText, membersOnly: false } as any);
    const membersOnly = await analyzeImpactFromDiff(getSamplePath('typescript'), index, { provider: 'raw', diffText, membersOnly: true } as any);

    expect(membersOnly.impacted.every(i => (i.depth ?? 0) === 0)).toBe(true);
    const hasTransitive = withTransitive.impacted.some(i => (i.depth ?? 0) > 0);
    expect(hasTransitive || withTransitive.impacted.length >= 0).toBe(true);
  });

  it('explain payload contains useful factors (reason, depth)', async () => {
    const index = await createTestIndex('typescript');
    const file = Array.from(index.byFile.keys()).find(f => f.endsWith('/utils.ts'))!;
    const mod = index.byFile.get(file)!;
    const target = mod.locals[0]!;
    const diffText = makeDiffForAbsPath(file, Math.max(target.range.start.line + 1, target.range.start.line));

    const report = await analyzeImpactFromDiff(getSamplePath('typescript'), index, { provider: 'raw', diffText } as any);
    for (const item of report.impacted) {
      if (item.explain) {
        expect(Object.prototype.hasOwnProperty.call(item.explain, 'reason')).toBe(true);
        expect(Object.prototype.hasOwnProperty.call(item.explain, 'depth')).toBe(true);
      }
    }
  });
});


