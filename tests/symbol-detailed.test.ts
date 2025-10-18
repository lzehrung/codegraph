import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { buildProjectIndex, buildSymbolGraphDetailed } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return dir;
}

function norm(p: string): string { return p.replace(/\\/g, '/'); }

describe('Detailed symbol graph (uses edges)', () => {
  it('TypeScript: function uses imported symbol inside body', async () => {
    const root = await mkTmpDir('dg-ts-');
    const utils = `export function utilFn(): string { return 'x'; }\n`;
    const main = `import { utilFn } from './utils';\nexport function uses(): string {\n  return utilFn();\n}\n`;
    await fsp.writeFile(path.join(root, 'utils.ts'), utils, 'utf8');
    await fsp.writeFile(path.join(root, 'main.ts'), main, 'utf8');

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map(n => ({ ...n, file: norm(n.file) }));

    const utilDef = nodes.find(n => n.file.endsWith('/utils.ts') && n.name === 'utilFn');
    const usesDef = nodes.find(n => n.file.endsWith('/main.ts') && n.name === 'uses');
    expect(utilDef).toBeDefined();
    expect(usesDef).toBeDefined();

    const edge = sg.edges.find(e => e.from === (usesDef as any).id && e.to === (utilDef as any).id && e.label === 'uses');
    expect(edge).toBeDefined();
  });

  it('Python: function uses imported symbol inside body', async () => {
    const root = await mkTmpDir('dg-py-');
    const util = `def helper():\n    return 1\n`;
    const main = `from . import util\n\ndef inner():\n    return util.helper()\n`;
    await fsp.writeFile(path.join(root, '__init__.py'), '', 'utf8');
    await fsp.writeFile(path.join(root, 'util.py'), util, 'utf8');
    await fsp.writeFile(path.join(root, 'main.py'), main, 'utf8');

    const index = await buildProjectIndex(root);
    const sg = await buildSymbolGraphDetailed(index);
    const nodes = [...sg.nodes.values()].map(n => ({ ...n, file: norm(n.file) }));

    const helperDef = nodes.find(n => n.file.endsWith('/util.py') && n.name === 'helper');
    const innerDef = nodes.find(n => n.file.endsWith('/main.py') && n.name === 'inner');
    expect(helperDef).toBeDefined();
    expect(innerDef).toBeDefined();

    const edge = sg.edges.find(e => e.from === (innerDef as any).id && e.to === (helperDef as any).id && e.label === 'uses');
    expect(edge).toBeDefined();
  });
});


