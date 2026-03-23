import { describe, it, expect, vi, afterEach } from 'vitest';
import path from 'node:path';
import { buildProjectIndex } from '../src/index.js';

describe('Symbols-detailed pruning flags', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('scope=imported filters files while still producing edges', async () => {
    const root = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
    const index = await buildProjectIndex(root);
    const { buildSymbolGraphDetailed } = await import('../src/graphs.js');
    const sgAll = await buildSymbolGraphDetailed(index, { scope: 'all' });
    const sgImported = await buildSymbolGraphDetailed(index, { scope: 'imported' });
    // Imported should not exceed all; typically fewer or equal edges
    expect(sgImported.edges.length).toBeLessThanOrEqual(sgAll.edges.length);
  });

  it('maxEdges caps the number of uses edges', async () => {
    const root = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
    const index = await buildProjectIndex(root);
    const { buildSymbolGraphDetailed } = await import('../src/graphs.js');
    const cap = 2;
    const sg = await buildSymbolGraphDetailed(index, { maxEdges: cap });
    // Only count 'uses' edges for cap; file/symbol containment edges are not part of this graph
    const usesCount = sg.edges.filter(e => e.label === 'uses').length;
    expect(usesCount).toBeLessThanOrEqual(cap);
  });

  it('membersOnly omits direct alias uses edges', async () => {
    const root = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
    const index = await buildProjectIndex(root);
    const { buildSymbolGraphDetailed } = await import('../src/graphs.js');
    const full = await buildSymbolGraphDetailed(index, { membersOnly: false });
    const membersOnly = await buildSymbolGraphDetailed(index, { membersOnly: true });
    // membersOnly should be less than or equal in edges
    expect(membersOnly.edges.length).toBeLessThanOrEqual(full.edges.length);
  });

  it('skips unsupported project files without warning noise', async () => {
    const root = path.resolve(process.cwd(), 'tests', 'samples', 'javascript');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const index = await buildProjectIndex(root);
    const { buildSymbolGraphDetailed } = await import('../src/graphs.js');

    await buildSymbolGraphDetailed(index, { scope: 'all' });

    expect(
      warnSpy.mock.calls.some((call) =>
        call.some(
          (value) =>
            typeof value === 'string' &&
            value.includes('Unsupported file extension'),
        ),
      ),
    ).toBe(false);
  });
});

