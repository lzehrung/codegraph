import fsp from "node:fs/promises";
import { prepareSourceInput } from "../languages/filePrep.js";
import { logWithLevel } from "../logging.js";
import { getUnifiedQueryExecution } from "../native/treeSitterNative.js";
import { toProjectDisplayPath } from "../util/paths.js";
import { listProjectFiles, type ProjectFileDiscoveryOptions } from "../util/projectFiles.js";

export type AstGrepHit = {
  file: string;
  capture: string;
  line: number;
  column: number;
  snippet: string;
};

export type TextGrepHit = {
  file: string;
  line: number;
  column: number;
  match: string;
  snippet: string;
};

export async function astGrep(
  projectRoot: string,
  querySource: string,
  patterns = [
    "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,vue,svelte,go,java,cs,rb,rs,html,htm,css,scss,less,kt,kts,swift,zig,c,h,cc,cpp,cxx,c++,hpp,hh,hxx,ipp,tpp,inl}",
  ],
  opts?: ProjectFileDiscoveryOptions,
): Promise<AstGrepHit[]> {
  const hits: AstGrepHit[] = [];
  const files = await listProjectFiles(projectRoot, patterns, opts);
  for (const file of files) {
    try {
      const prep = await prepareSourceInput(file);
      const support = prep.sup;
      const source = prep.source;
      const matches = getUnifiedQueryExecution(source, support, querySource, {
        getLanguage: () => support.language(file),
      }).matches;
      if (!matches) continue;

      for (const match of matches) {
        for (const capture of match.captures) {
          hits.push({
            file: toProjectDisplayPath(projectRoot, file),
            capture: capture.name,
            line: capture.start.row + 1,
            column: capture.start.column + 1,
            snippet: capture.text.replace(/\n/g, " "),
          });
        }
      }
    } catch (error) {
      logWithLevel(opts?.logLevel, "warn", `Warning: Failed to process file ${file} for AST grep:`, error);
    }
  }
  return hits;
}

export async function textGrep(
  projectRoot: string,
  patternSource: string,
  patterns = [
    "**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,py,vue,svelte,go,java,cs,rb,rs,html,htm,css,scss,less,kt,kts,swift,zig,c,h,cc,cpp,cxx,c++,hpp,hh,hxx,ipp,tpp,inl}",
  ],
  opts?: {
    ignoreCase?: boolean;
    maxHits?: number;
    includeGlobs?: string[];
    ignoreGlobs?: string[];
    useGitignore?: boolean;
  },
): Promise<TextGrepHit[]> {
  const maxHits = Math.max(1, Math.min(opts?.maxHits ?? 5000, 200_000));
  const flags = `g${opts?.ignoreCase ? "i" : ""}`;

  let regex: RegExp;
  try {
    regex = new RegExp(patternSource, flags);
  } catch (error) {
    throw new Error(`Invalid regex for textGrep: ${patternSource} (${(error as Error).message ?? String(error)})`);
  }

  const hits: TextGrepHit[] = [];
  const files = await listProjectFiles(projectRoot, patterns, opts);
  for (const file of files) {
    if (hits.length >= maxHits) break;

    let source: string;
    try {
      source = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }

    const relativeFile = toProjectDisplayPath(projectRoot, file);
    const lines = source.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      if (hits.length >= maxHits) break;
      const lineText = lines[lineIndex]!;
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(lineText)) !== null) {
        hits.push({
          file: relativeFile,
          line: lineIndex + 1,
          column: (match.index ?? 0) + 1,
          match: match[0] ?? "",
          snippet: lineText.trim().slice(0, 240),
        });
        if (hits.length >= maxHits) break;
        if (match.index === regex.lastIndex) regex.lastIndex++;
      }
    }
  }
  return hits;
}
