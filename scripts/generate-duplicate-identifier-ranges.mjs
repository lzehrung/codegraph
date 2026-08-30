import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  DUPLICATE_IDENTIFIER_RANGES_TARGET,
  collectDuplicateIdentifierRanges,
  renderDuplicateIdentifierRanges,
} from "./generate-duplicate-identifier-ranges-lib.mjs";

const CHECK_ONLY = process.argv.includes("--check");

const { getNativeDuplicateTokens } = await import(path.resolve("dist/native/treeSitterNative.js"));

function tokenize(source) {
  const native = getNativeDuplicateTokens(source, "on");
  if (!native) {
    throw new Error("Native duplicate tokenizer is unavailable. Run `npm run build` first.");
  }
  return native.normalizedTokens;
}

const output = renderDuplicateIdentifierRanges(collectDuplicateIdentifierRanges(tokenize));

if (!CHECK_ONLY) {
  await fs.writeFile(DUPLICATE_IDENTIFIER_RANGES_TARGET, output, "utf8");
} else {
  const actual = await fs.readFile(DUPLICATE_IDENTIFIER_RANGES_TARGET, "utf8").catch(() => "");
  if (actual !== output) {
    const relative = path.relative(process.cwd(), DUPLICATE_IDENTIFIER_RANGES_TARGET);
    throw new Error(`${relative} is stale. Run \`npm run generate:duplicate-identifier-ranges\`.`);
  }
}
