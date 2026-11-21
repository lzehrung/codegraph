import { generateCacheEpochs } from "./cache-epochs-lib.mjs";

const epochs = generateCacheEpochs(process.cwd());
console.log(`[codegraph] Generated cache epochs: core=${epochs.core}, language=${epochs.language}.`);
