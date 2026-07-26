import { bundleCli, verifyBundledCli } from "./bundle-cli-lib.mjs";

const skipVerify = process.argv.includes("--skip-verify");

const bundle = await bundleCli();
console.log(`[codegraph] Bundled CLI entry ${bundle.bundledEntry} (${bundle.outputFiles.length} outputs).`);

if (!skipVerify) {
  const verified = await verifyBundledCli({ rootDir: bundle.rootDir });
  console.log(`[codegraph] Bundled CLI smoke ok (version ${verified.version}).`);
}
