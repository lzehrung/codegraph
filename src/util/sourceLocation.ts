export type SourceLocationInput = {
  file: string;
  line?: number;
  column?: number;
};

const FILE_LINE_COLUMN_PATTERN = /^(.*):(\d+):(\d+)$/;
const FILE_LINE_PATTERN = /^(.*):(\d+)$/;

/** Parse a plain file or file:line[:column], preserving Windows drive letters. */
export function parseSourceLocationInput(value: string): SourceLocationInput {
  const lineColumnMatch = FILE_LINE_COLUMN_PATTERN.exec(value);
  if (lineColumnMatch?.[1] && lineColumnMatch[2] && lineColumnMatch[3]) {
    return {
      file: lineColumnMatch[1],
      line: Number(lineColumnMatch[2]),
      column: Number(lineColumnMatch[3]),
    };
  }

  const lineMatch = FILE_LINE_PATTERN.exec(value);
  if (lineMatch?.[1] && lineMatch[2]) {
    return { file: lineMatch[1], line: Number(lineMatch[2]) };
  }

  return { file: value };
}
