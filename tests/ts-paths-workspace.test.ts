import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { collectGraph } from '../src/index.js';

async function mkTmpDir(prefix: string): Promise<string> {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('TypeScript paths/baseUrl resolution via tsconfig', () => {
  it('resolves @lib/util to lib/util.ts using tsconfig paths', async () => {
    const root = await mkTmpDir('dg-ts-paths-');
    const tsconfig = {
      compilerOptions: {
        target: 'ES2020',
        module: 'ES2020',
        baseUrl: '.',
        paths: {
          '@lib/*': ['lib/*']
        }
      }
    };
    await fsp.writeFile(path.join(root, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2), 'utf8');
    const libDir = path.join(root, 'lib');
    await fsp.mkdir(libDir);
    const util = path.join(libDir, 'util.ts');
    const main = path.join(root, 'main.ts');
    await fsp.writeFile(util, 'export const fn = () => 1;\n', 'utf8');
    await fsp.writeFile(main, "import { fn } from '@lib/util';\nconst x = fn();\n", 'utf8');
    const files = [util, main].map(f => f.replace(/\\/g, '/'));
    const g = await collectGraph(root, files);
    expect(g.edges.some(e => e.from.endsWith('/main.ts') && e.raw === '@lib/util' && e.to.type === 'file' && e.to.path.replace(/\\/g,'/').endsWith('/lib/util.ts'))).toBe(true);
  });

  it('accepts tsconfig jsonc comments and trailing commas', async () => {
    const root = await mkTmpDir('dg-ts-paths-jsonc-');
    const tsconfig = `{
  // comment
  "compilerOptions": {
    "target": "ES2020",
    "module": "ES2020",
    "baseUrl": ".",
    "paths": {
      "@lib/*": ["lib/*"],
    },
  },
}
`;
    await fsp.writeFile(path.join(root, 'tsconfig.json'), tsconfig, 'utf8');
    const libDir = path.join(root, 'lib');
    await fsp.mkdir(libDir);
    const util = path.join(libDir, 'util.ts');
    const main = path.join(root, 'main.ts');
    await fsp.writeFile(util, 'export const fn = () => 1;\n', 'utf8');
    await fsp.writeFile(main, "import { fn } from '@lib/util';\nconst x = fn();\n", 'utf8');
    const files = [util, main].map(f => f.replace(/\\/g, '/'));
    const g = await collectGraph(root, files);
    expect(
      g.edges.some(
        e =>
          e.from.endsWith('/main.ts') &&
          e.raw === '@lib/util' &&
          e.to.type === 'file' &&
          e.to.path.replace(/\\/g, '/').endsWith('/lib/util.ts'),
      ),
    ).toBe(true);
  });
});

