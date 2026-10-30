import fsp from "node:fs/promises";

/** Characters a piece may reach before it goes to the sink, which also bounds every string this module holds. */
const JSON_CHUNK_CHARS = 1 << 20;

/** Containers above this depth are walked piece by piece; a container at it or below is stringified in one call. */
const WALK_DEPTH = 2;

const INDENT = "  ";
const PADS = ["", INDENT, INDENT.repeat(2), INDENT.repeat(3)];

type JsonChunkSink = (chunk: string) => void | Promise<void>;

function padFor(depth: number): string {
  return PADS[depth] ?? INDENT.repeat(depth);
}

/** An array or a plain object that is shallow enough to be written member by member. */
function isWalkable(value: unknown, depth: number): value is unknown[] | Record<string, unknown> {
  if (depth >= WALK_DEPTH || typeof value !== "object" || value === null) return false;
  if ("toJSON" in value && typeof value.toJSON === "function") return false;
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** `JSON.stringify(value, null, 2)` for a value at `depth`, with its continuation lines indented to match. */
function leafText(value: unknown, depth: number): string | undefined {
  const text: string | undefined = JSON.stringify(value, null, 2);
  if (text === undefined || !depth) return text;
  return text.replace(/\n/g, `\n${padFor(depth)}`);
}

/**
 * Writes exactly the text `JSON.stringify(value, null, 2)` returns to `sink` in pieces of about a million
 * characters. V8 refuses a string past about 536 million characters, which the graph of a large repository
 * passes while the heap still has room, so a large document is never built as one string. The top two levels
 * of arrays and plain objects are walked member by member and each member below them is stringified whole,
 * which is how every graph document in this package is shaped.
 */
export async function writeJsonInChunks(
  value: unknown,
  sink: JsonChunkSink,
  chunkChars: number = JSON_CHUNK_CHARS,
): Promise<void> {
  let buffer = "";
  const flush = async (): Promise<void> => {
    const chunk = buffer;
    buffer = "";
    if (chunk) await sink(chunk);
  };

  const walkArray = async (items: readonly unknown[], depth: number): Promise<void> => {
    if (!items.length) {
      buffer += "[]";
      return;
    }
    const memberPad = padFor(depth + 1);
    buffer += "[";
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      buffer += index ? `,\n${memberPad}` : `\n${memberPad}`;
      if (isWalkable(item, depth + 1)) await walk(item, depth + 1);
      else buffer += leafText(item, depth + 1) ?? "null";
      if (buffer.length >= chunkChars) await flush();
    }
    buffer += `\n${padFor(depth)}]`;
  };

  const walkObject = async (record: Record<string, unknown>, depth: number): Promise<void> => {
    const memberPad = padFor(depth + 1);
    let empty = true;
    buffer += "{";
    for (const key of Object.keys(record)) {
      const member = record[key];
      const separator = `${empty ? "\n" : ",\n"}${memberPad}${JSON.stringify(key)}: `;
      if (isWalkable(member, depth + 1)) {
        buffer += separator;
        await walk(member, depth + 1);
      } else {
        const text = leafText(member, depth + 1);
        // JSON.stringify drops an object member that has no JSON form (undefined, a function, a symbol).
        if (text === undefined) continue;
        buffer += separator + text;
      }
      empty = false;
      if (buffer.length >= chunkChars) await flush();
    }
    buffer += empty ? "}" : `\n${padFor(depth)}}`;
  };

  const walk = async (container: unknown[] | Record<string, unknown>, depth: number): Promise<void> => {
    if (Array.isArray(container)) await walkArray(container, depth);
    else await walkObject(container, depth);
  };

  if (isWalkable(value, 0)) {
    await walk(value, 0);
  } else {
    const text = leafText(value, 0);
    if (text === undefined) throw new TypeError("The value has no JSON form.");
    buffer += text;
  }
  await flush();
}

/** Writes `JSON.stringify(value, null, 2)` and a final newline to `filePath` in pieces; see `writeJsonInChunks`. */
export async function writeJsonFileInChunks(filePath: string, value: unknown): Promise<void> {
  const handle = await fsp.open(filePath, "w");
  try {
    await writeJsonInChunks(value, (chunk) => handle.writeFile(chunk));
    await handle.writeFile("\n");
  } finally {
    await handle.close();
  }
}
