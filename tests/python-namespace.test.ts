import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { collectGraph, buildProjectIndex, goToDefinition, findReferences } from '../src/index.js';
import fsp from 'node:fs/promises';

async function ensureFixture(root: string) {
  const utilDir = path.join(root, 'pkg_ns', 'submod');
  const appDir = path.join(root, 'app');
  await fsp.mkdir(utilDir, { recursive: true });
  await fsp.mkdir(appDir, { recursive: true });
  await fsp.writeFile(path.join(utilDir, 'util.py'), 'def do_work():\n    return 42\n');
  await fsp.writeFile(path.join(utilDir, 'helper.py'), 'def help_fn():\n    return 1\n');
  await fsp.writeFile(
    path.join(appDir, 'main.py'),
    'from pkg_ns.submod import util\nimport pkg_ns.submod.util as u\nfrom pkg_ns import submod\n\nval = util.do_work()\nval2 = u.do_work()\nval3 = submod.util.do_work()\n'
  );
}

describe('Python namespace packages (PEP 420)', () => {
  const root = path.join(process.cwd(), 'tests', 'samples', 'python_ns');

  it('resolves namespace modules to files/dirs in graph', async () => {
    await ensureFixture(root);
    const files = [
      path.join(root, 'pkg_ns', 'submod', 'util.py').replace(/\\/g, '/'),
      path.join(root, 'pkg_ns', 'submod', 'helper.py').replace(/\\/g, '/'),
      path.join(root, 'app', 'main.py').replace(/\\/g, '/'),
    ];
    const graph = await collectGraph(root, files);
    // Expect edges from app/main.py to util.py
    const hasUtilEdge = graph.edges.some(e => e.from.replace(/\\/g, '/').endsWith('/app/main.py') && (e.to).type === 'file' && ((e.to).path as string).replace(/\\/g, '/').endsWith('/pkg_ns/submod/util.py'));
    expect(hasUtilEdge).toBe(true);
  });

  it('goToDefinition for util.do_work resolves into util.py', async () => {
    await ensureFixture(root);
    const index = await buildProjectIndex(root);
    const appMain = path.join(root, 'app', 'main.py').replace(/\\/g, '/');
    // place cursor on 'util' to resolve module target file
    const res = await goToDefinition(index, { file: appMain, line: 5, column: 8 });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.definition.file.replace(/\\/g, '/')).toContain('/pkg_ns/submod/util.py');
    }
  });

  it('findReferences of do_work finds usages in main.py', async () => {
    await ensureFixture(root);
    const index = await buildProjectIndex(root);
    const utilFile = path.join(root, 'pkg_ns', 'submod', 'util.py').replace(/\\/g, '/');
    const res = await findReferences(index, { file: utilFile, line: 1, column: 6 });
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      const files = res.references.map(r => r.file.replace(/\\/g, '/'));
      expect(files.some(f => f.endsWith('/app/main.py'))).toBe(true);
    }
  });

  it('ignores commented python imports/specifiers in graph/specifier collection', async () => {
    const appDir = path.join(root, 'app');
    await fsp.mkdir(appDir, { recursive: true });
    const commented = '# from pkg_ns.submod import missing\n# import pkg_ns.submod.missing as m\n"""\nfrom pkg_ns.submod import also_missing\n"""\n';
    await fsp.writeFile(path.join(appDir, 'commented.py'), commented, 'utf8');
    const files = [
      path.join(root, 'pkg_ns', 'submod', 'util.py').replace(/\\/g, '/'),
      path.join(appDir, 'commented.py').replace(/\\/g, '/'),
    ];
    const graph = await collectGraph(root, files);
    const edgesFromCommented = graph.edges.filter(e => e.from.replace(/\\/g, '/').endsWith('/app/commented.py'));
    expect(edgesFromCommented.length).toBe(0);
  });
});


