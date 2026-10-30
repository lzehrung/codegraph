import fsp from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";

const realStringify = JSON.stringify.bind(JSON);
const realParse = JSON.parse.bind(JSON);
const realReadFile = fsp.readFile.bind(fsp);

/**
 * Makes `JSON.stringify` throw V8's `RangeError: Invalid string length` for a result longer than `maxChars`.
 * A repository with millions of graph edges reaches that error at about 536 million characters; this lets a
 * small input cross the same limit. With `prettyOnly`, only a call that passes an indent is limited, which
 * keeps unrelated compact `JSON.stringify` calls (a SQLite metadata row, say) out of the experiment. Calling it
 * again replaces the limit; restore with `mockRestore()` on the returned spy.
 */
export function limitJsonStringLength(maxChars: number, options?: { prettyOnly?: boolean }) {
  return vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    const text: string | undefined = realStringify(value, replacer, space);
    const limited = !options?.prettyOnly || space !== undefined;
    if (limited && text !== undefined && text.length > maxChars) throw new RangeError("Invalid string length");
    return text;
  });
}

/**
 * Makes `JSON.parse` throw `RangeError: Invalid string length` for text longer than `maxChars`: past V8's limit no
 * such string exists to be parsed. Restore with `mockRestore()` on the returned spy.
 */
export function limitJsonParseLength(maxChars: number) {
  return vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (text.length > maxChars) throw new RangeError("Invalid string length");
    const value: unknown = realParse(text, reviver);
    return value;
  });
}

/**
 * Makes reading the file named `fileName` as one string fail the way Node does for a file whose text does not fit a
 * string: `fsp.readFile` with an encoding rejects with `ERR_STRING_TOO_LONG` once the text is longer than
 * `maxChars`. Reads of other files, and reads that return a buffer, are untouched. Restore with `mockRestore()` on
 * the returned spy.
 */
export function limitFileStringLength(fileName: string, maxChars: number) {
  return vi.spyOn(fsp, "readFile").mockImplementation(async (file, options) => {
    const result = await realReadFile(file, options);
    if (typeof result === "string" && result.length > maxChars && path.basename(String(file)) === fileName) {
      throw Object.assign(new Error(`Cannot create a string longer than ${maxChars} characters`), {
        code: "ERR_STRING_TOO_LONG",
      });
    }
    return result;
  });
}
