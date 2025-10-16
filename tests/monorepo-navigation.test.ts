import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildProjectIndex, goToDefinition, findReferences } from '../src/index.js';

describe('Monorepo cross-package navigation', () => {
  const root = path.join(process.cwd(), 'tests', 'samples', 'monorepo');
  const pkga = path.join(root, 'packages', 'pkg-a', 'src', 'index.ts');
  const pkgb = path.join(root, 'packages', 'pkg-b', 'src', 'index.js');

  it('goToDefinition from pkg-b to AClass in pkg-a', async () => {
    const index = await buildProjectIndex(root);
    // `return new AClass(2);` is on line 9 in pkg-b/src/index.js
    const line = 9;
    const column = 15; // inside AClass token
    const res = await goToDefinition(index, { file: pkgb.replace(/\\/g, '/'), line, column });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.definition.file.replace(/\\/g, '/')).toBe(pkga.replace(/\\/g, '/'));
    }
  });

  it('findReferences for aHelper includes usage in pkg-b', async () => {
    const index = await buildProjectIndex(root);
    // aHelper is defined at top of pkg-a index.ts line 1
    const res = await findReferences(index, { file: pkga.replace(/\\/g, '/'), line: 1, column: 10 });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      const hasPkgbRef = res.references.some(r => r.file.replace(/\\/g, '/').includes('packages/pkg-b/src/index.js'));
      expect(hasPkgbRef).toBe(true);
    }
  });

  it('goToDefinition for default import from pkg-b to pkg-a default', async () => {
    const index = await buildProjectIndex(root);
    // defA() is declared near bottom; put cursor inside defA identifier in a call
    // The added default usage is on last lines; aim for the "defA" in "const defVal = defA();"
    const line = 21; // "const defVal = defA();"
    const column = 18; // inside defA identifier
    const res = await goToDefinition(index, { file: pkgb.replace(/\\/g, '/'), line, column });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.definition.file.replace(/\\/g, '/')).toBe(pkga.replace(/\\/g, '/'));
    }
  });
});


