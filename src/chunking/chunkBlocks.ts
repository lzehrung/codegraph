import type { LanguageConfig } from "./languageConfig.js";
import type { BlockCandidate, ChunkCapture, ChunkMatch } from "./types.js";

export type ChunkBlockGroups = {
  mainBlocks: BlockCandidate[];
  innerBlocks: BlockCandidate[];
  comments: BlockCandidate[];
};

export function collectChunkBlockGroups(language: LanguageConfig, matches: ChunkMatch[]): ChunkBlockGroups {
  const mainBlocks: BlockCandidate[] = [];
  const innerBlocks: BlockCandidate[] = [];
  const comments: BlockCandidate[] = [];

  for (const match of matches) {
    let nameCapture: ChunkCapture | undefined;
    let blockCapture: ChunkCapture | undefined;
    let innerCapture: ChunkCapture | undefined;
    let blockKind: string | undefined;

    for (const capture of match.captures) {
      const { name } = capture;

      if (name === language.captures.name) {
        nameCapture = capture;
      }

      if (language.captures.comments.includes(name)) {
        comments.push({
          kind: name === "chunk.docstring" ? "docstring" : "comment",
          startByte: capture.startByte,
          endByte: capture.endByte,
          startLine: capture.startLine,
          endLine: capture.endLine,
        });
      }

      if (name === language.captures.innerBlock) {
        innerCapture = capture;
      }

      if (name.startsWith(language.captures.blockPrefix) && name !== language.captures.innerBlock) {
        blockCapture = capture;
        blockKind = name.slice(language.captures.blockPrefix.length) || capture.nodeType;
      }
    }

    if (innerCapture) {
      innerBlocks.push({
        kind: "inner",
        startByte: innerCapture.startByte,
        endByte: innerCapture.endByte,
        startLine: innerCapture.startLine,
        endLine: innerCapture.endLine,
      });
    }

    if (blockCapture) {
      const candidate: BlockCandidate = {
        kind: blockKind ?? "block",
        startByte: blockCapture.startByte,
        endByte: blockCapture.endByte,
        startLine: blockCapture.startLine,
        endLine: blockCapture.endLine,
      };

      if (nameCapture) {
        candidate.name = nameCapture.text;
      }

      mainBlocks.push(candidate);
    }
  }

  mainBlocks.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  innerBlocks.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);
  comments.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);

  return { mainBlocks, innerBlocks, comments };
}
