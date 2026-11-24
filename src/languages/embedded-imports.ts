import { parseSFC, prepareSFCBlockSource, scriptLanguageIdForBlock, styleLanguageKey } from "./sfc.js";
import { pushAll } from "../util/collections.js";
import type { ImportSourceRange } from "../util/resolution/language-policy-types.js";

export function collectEmbeddedImportRanges(
  source: string,
  collectImportRanges: (source: string, languageId: string) => ImportSourceRange[],
): ImportSourceRange[] {
  const ranges: ImportSourceRange[] = [];
  for (const block of parseSFC(source)) {
    if (block.type === "script") {
      pushAll(ranges, collectImportRanges(prepareSFCBlockSource(source, block), scriptLanguageIdForBlock(block)));
    } else if (block.type === "style") {
      const languageId = styleLanguageKey(block);
      if (languageId) pushAll(ranges, collectImportRanges(prepareSFCBlockSource(source, block), languageId));
    }
  }
  return ranges;
}
