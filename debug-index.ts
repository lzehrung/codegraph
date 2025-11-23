
import path from 'node:path';
import { buildProjectIndex } from './src/index.js';
import { listSymbols } from './src/indexer.js';

async function debugLanguage(lang: string, root: string) {
  console.log(`\n--- Debugging ${lang} ---`);
  const index = await buildProjectIndex(root);
  
  console.log(`Files found: ${index.byFile.size}`);
  for (const [file, mod] of index.byFile) {
    console.log(`\nFile: ${path.relative(root, file)}`);
    
    console.log("  Imports:");
    mod.imports.forEach(i => {
      console.log(`    - kind: ${i.kind}, local: ${(i as any).local || (i as any).localNS}, from: ${i.from}, resolved: ${i.resolved}`);
    });

    console.log("  Exports:");
    mod.exports.forEach((e) => {
      if (e.type === "local" || e.type === "reexport") {
        console.log(`    - type: ${e.type}, as: ${e.exportedAs}`);
      } else {
        console.log(`    - type: ${e.type}, from: ${e.fromModule}`);
      }
    });

    console.log("  Locals:");
    mod.locals.forEach(l => {
      console.log(`    - name: ${l.localName}, kind: ${l.kind}, line: ${l.range.start.line}`);
    });
  }
}

async function main() {
  const cwd = process.cwd();
  // await debugLanguage('java', path.join(cwd, 'tests/samples/java'));
  await debugLanguage('csharp', path.join(cwd, 'tests/samples/csharp'));
  // await debugLanguage('ruby', path.join(cwd, 'tests/samples/ruby'));
  // await debugLanguage('rust', path.join(cwd, 'tests/samples/rust'));
}

main().catch(console.error);

