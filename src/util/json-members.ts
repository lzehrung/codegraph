import fs from "node:fs";

/** Bytes read from the file at a time; with the members asked for, the only text this module holds. */
const READ_CHUNK_BYTES = 1 << 20;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const LEFT_BRACKET = 0x5b;
const RIGHT_BRACKET = 0x5d;
const LEFT_BRACE = 0x7b;
const RIGHT_BRACE = 0x7d;

function isJsonSpace(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

type Capture = "none" | "key" | "value" | "element";

/**
 * Reads the members of the top-level object of a JSON file that `names` lists, without holding the file as one
 * string: V8 stops at about 536 million characters, and a parsed document of that size does not fit the default
 * heap either. The file is read in pieces and scanned for structure only. A member that is not wanted is skipped
 * without being parsed, so nothing in it is checked, and the read ends as soon as every wanted member is found,
 * which for a document that lists them first leaves the rest of the file unread. A wanted array is parsed one
 * element at a time, so it may be longer than one string can be. Any other wanted value is parsed whole. A member
 * the file does not have is absent from the result. A file that is not a JSON object, or ends before the object
 * does, throws a `SyntaxError`, as does a wanted value that is not JSON.
 */
export async function readJsonMembers(
  filePath: string,
  names: readonly string[],
  chunkBytes: number = READ_CHUNK_BYTES,
): Promise<Map<string, unknown>> {
  const wanted = new Set(names);
  const found = new Map<string, unknown>();

  let depth = 0; // 0 before the object, 1 among its members, deeper inside a member
  let inString = false;
  let escaped = false;
  let expectKey = false; // at depth 1, a member key may start
  let pendingColon = false; // a wanted key was read; its `:` is next
  let awaitingValue = false; // after that `:`, before the first character of the value
  let member: string | undefined; // the wanted member being read
  let elements: unknown[] = []; // its elements, when the value is an array
  let capture: Capture = "none";
  let start = 0; // where the open capture began in the current chunk
  let parts: string[] = []; // the open capture's text from earlier chunks
  let done = false;

  const open = (kind: Capture, index: number): void => {
    capture = kind;
    start = index;
    parts = [];
  };
  const close = (chunk: string, end: number): string => {
    const text = parts.length ? parts.join("") + chunk.slice(start, end) : chunk.slice(start, end);
    capture = "none";
    parts = [];
    return text;
  };
  const finishMember = (value: unknown): void => {
    if (member !== undefined) found.set(member, value);
    member = undefined;
    if (found.size === wanted.size) done = true;
  };
  // `[]` has no element, so its blank text is skipped; a blank element anywhere else is for JSON.parse to reject.
  const pushElement = (text: string, closesArray: boolean): void => {
    if (closesArray && !elements.length && !text.trim()) return;
    elements.push(JSON.parse(text));
  };

  const scan = (chunk: string): void => {
    start = 0; // an open capture continues at the start of this chunk
    for (let i = 0; i < chunk.length && !done; i += 1) {
      const code = chunk.charCodeAt(i);
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (code === BACKSLASH) {
          escaped = true;
        } else if (code === QUOTE) {
          inString = false;
          if (capture === "key") {
            const key: unknown = JSON.parse(close(chunk, i + 1));
            expectKey = false;
            member = typeof key === "string" && wanted.has(key) ? key : undefined;
            pendingColon = member !== undefined;
          }
        }
        continue;
      }
      if (depth === 0) {
        if (isJsonSpace(code)) continue;
        if (code !== LEFT_BRACE) throw new SyntaxError(`Expected a JSON object in ${filePath}`);
        depth = 1;
        expectKey = true;
        continue;
      }
      if (awaitingValue && !isJsonSpace(code)) {
        awaitingValue = false;
        if (code === LEFT_BRACKET) {
          elements = [];
          depth = 2;
          open("element", i + 1);
          continue;
        }
        open("value", i);
      }
      switch (code) {
        case QUOTE:
          if (depth === 1 && expectKey) open("key", i);
          inString = true;
          break;
        case LEFT_BRACE:
        case LEFT_BRACKET:
          depth += 1;
          break;
        case COLON:
          if (depth === 1 && pendingColon) {
            pendingColon = false;
            awaitingValue = true;
          }
          break;
        case COMMA:
          if (depth === 1) {
            if (capture === "value") finishMember(JSON.parse(close(chunk, i)));
            expectKey = true;
          } else if (depth === 2 && capture === "element") {
            pushElement(close(chunk, i), false);
            open("element", i + 1);
          }
          break;
        case RIGHT_BRACKET:
          if (depth === 2 && capture === "element") {
            pushElement(close(chunk, i), true);
            depth = 1;
            finishMember(elements);
          } else {
            depth -= 1;
          }
          break;
        case RIGHT_BRACE:
          if (depth === 1) {
            if (capture === "value") finishMember(JSON.parse(close(chunk, i)));
            done = true;
          } else {
            depth -= 1;
          }
          break;
        default:
          break;
      }
    }
    if (capture !== "none" && !done) parts.push(chunk.slice(start));
  };

  const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: chunkBytes });
  try {
    for await (const chunk of stream) {
      if (typeof chunk !== "string") throw new TypeError(`Expected text from ${filePath}`);
      scan(chunk);
      if (done) break;
    }
  } finally {
    stream.destroy();
  }
  if (!done) throw new SyntaxError(`Unexpected end of JSON input in ${filePath}`);
  return found;
}
