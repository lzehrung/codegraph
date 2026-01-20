import { describe, it, expect } from 'vitest';
import { createTestIndex } from './test-utils.js';
import type { ChangedSymbol, Hunk } from '../src/impact/types.js';

function norm(p: string) { return p.replace(/\\/g, '/'); }

describe('Impact: changed-lines → symbol mapping', () => {
  it('maps body-only edits to the nearest declaration (ancestor-to-definition)', async () => {
    const index = await createTestIndex('typescript');

    // Find a known TypeScript file in the sample workspace (e.g., utils.ts)
    const file = Array.from(index.byFile.keys()).find(f => f.endsWith('/utils.ts'))!;
    expect(file).toBeTruthy();

    const mod = index.byFile.get(file)!;
    expect(mod.locals.length).toBeGreaterThan(0);

    // Pick a function-like local and simulate a body change (+ line inside the range)
    const target = mod.locals.find(l => l.kind === 'function') || mod.locals[0]!;
    const bodyLine = Math.max(target.range.start.line + 1, target.range.start.line);
    const hunks: Hunk[] = [
      {
        oldStart: bodyLine,
        newStart: bodyLine,
        lines: ['+// changed'],
      },
    ];

    const { locateChangedSymbols } = await import('../src/impact/map.js');
    const changed = await locateChangedSymbols(index, file, hunks);
    expect(
      changed.some((s: ChangedSymbol) => s.name === target.localName),
    ).toBe(true);
  });

  it('handles multi-hunk edits correctly (no off-by-one)', async () => {
    const index = await createTestIndex('typescript');
    const file = Array.from(index.byFile.keys()).find(f => f.endsWith('/utils.ts'))!;
    const mod = index.byFile.get(file)!;

    const targets = mod.locals.slice(0, 2);
    console.log('Targets:', targets.map(t => ({ name: t.localName, kind: t.kind, line: t.range.start.line })));
    if (targets.length < 2) {
      // Not enough locals to make this meaningful; skip gracefully
      expect(true).toBe(true);
      return;
    }

    const hunks: Hunk[] = targets.map((t) => ({
      oldStart: t.range.start.line,
      newStart: t.range.start.line,
      lines: ['+// changed'],
    }));

    const { locateChangedSymbols } = await import('../src/impact/map.js');
    const changed = await locateChangedSymbols(index, file, hunks);
    for (const t of targets) {
      expect(
        changed.some((s: ChangedSymbol) => s.name === t.localName),
      ).toBe(true);
    }
  });

  it('maps deletions to the nearest declaration (deletion-only hunks)', async () => {
    const index = await createTestIndex('typescript');
    const file = Array.from(index.byFile.keys()).find(f => f.endsWith('/utils.ts'))!;
    expect(file).toBeTruthy();

    const mod = index.byFile.get(file)!;
    const target = mod.locals.find(l => l.kind === 'function') || mod.locals[0]!;
    const deleteLine = Math.max(target.range.start.line + 1, target.range.start.line);
    const hunks: Hunk[] = [
      {
        oldStart: deleteLine,
        newStart: deleteLine,
        lines: ['-// removed'],
      },
    ];

    const { locateChangedSymbols } = await import('../src/impact/map.js');
    const changed = await locateChangedSymbols(index, file, hunks);
    expect(
      changed.some((s: ChangedSymbol) => s.name === target.localName),
    ).toBe(true);
  });
});
