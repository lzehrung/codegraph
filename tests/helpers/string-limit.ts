import { vi } from "vitest";

const realStringify = JSON.stringify.bind(JSON);

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
