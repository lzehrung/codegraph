import { describe, expect, it } from "vitest";

import {
  formatAgentChunkHandle,
  formatAgentFileHandle,
  formatAgentSqlHandle,
  formatAgentSymbolHandle,
  parseAgentChunkHandle,
  parseAgentFileHandle,
  parseAgentSqlHandle,
  parseAgentSymbolHandle,
} from "../src/agent/handles.js";

// Names and paths that would break a naive `split(":")` or a raw (undecoded) parse:
// a colon is the handle separator, a percent sign is the escape character, and
// non-ASCII exercises multi-byte percent-encoding.
//
// The non-ASCII payloads are written as escapes to keep this file typeable on a standard
// keyboard. Escapes are a source-text spelling, not a different value: "caf\u00e9" is the
// same four-character string as the literal, so these still exercise real multi-byte
// encoding rather than an ASCII stand-in. NON_ASCII_PAYLOADS below asserts exactly that,
// so replacing any of them with ASCII fails instead of quietly weakening the coverage.
const AWKWARD_VALUES = [
  "plain",
  "with:colon",
  "with%percent",
  "with%3Aencoded",
  "namespace::method",
  "caf\u00e9",
  "\u65e5\u672c\u8a9e",
  "emoji\u{1f600}",
  "mixed:%\u00e9:value",
] as const;

// Latin-1 supplement, CJK, an astral-plane emoji, and one mixed with the separator and the
// escape character. Each is beyond ASCII, so each takes more than one UTF-8 byte and more
// than one percent-escape triplet.
const NON_ASCII_PAYLOADS = ["caf\u00e9", "\u65e5\u672c\u8a9e", "emoji\u{1f600}", "mixed:%\u00e9:value"] as const;

describe("agent handle round-trips", () => {
  it("exercises payloads that are genuinely non-ASCII and multi-byte", () => {
    // Guards the escaped spelling above: escapes and literals produce the same string, but
    // an ASCII stand-in would leave every other case in this file passing while testing
    // nothing about encoding. Each payload must contain a code point outside ASCII, survive
    // a UTF-8 round trip, and take more bytes than characters.
    for (const payload of NON_ASCII_PAYLOADS) {
      expect(AWKWARD_VALUES).toContain(payload);
      expect([...payload].some((character) => character.codePointAt(0)! > 0x7f)).toBe(true);
      const utf8 = Buffer.from(payload, "utf8");
      expect(utf8.toString("utf8")).toBe(payload);
      expect(utf8.length).toBeGreaterThan([...payload].length);
      // Percent-encoding is what the handle format actually applies, and a multi-byte code
      // point becomes more than one triplet. An ASCII payload would produce none at all.
      expect(encodeURIComponent(payload).match(/%[0-9A-F]{2}/g)?.length ?? 0).toBeGreaterThan(1);
    }
  });

  it("round-trips SQL handles through colons, percents, and non-ASCII", () => {
    for (const name of AWKWARD_VALUES) {
      for (const file of AWKWARD_VALUES) {
        const handle = { name, file, line: 42 };
        const parsed = parseAgentSqlHandle(formatAgentSqlHandle(handle));
        expect(parsed).toEqual(handle);
      }
    }
  });

  it("keeps the SQL separator count fixed regardless of payload content", () => {
    // The dropped `parts.length > 4` branch existed for payloads that leaked a raw
    // colon; encoding means that never happens, so every handle has exactly 4 parts.
    for (const value of AWKWARD_VALUES) {
      const encoded = formatAgentSqlHandle({ name: value, file: value, line: 1 });
      expect(encoded.split(":")).toHaveLength(4);
    }
  });

  it("rejects malformed SQL handles rather than guessing", () => {
    expect(parseAgentSqlHandle("notsql:a:b:1")).toBeNull();
    expect(parseAgentSqlHandle("sql:a:b")).toBeNull();
    expect(parseAgentSqlHandle("sql:a:b:notanumber")).toBeNull();
    expect(parseAgentSqlHandle("sql::b:1")).toBeNull();
    expect(parseAgentSqlHandle("sql:a::1")).toBeNull();
  });

  it("round-trips symbol, file, and chunk handles through the same payloads", () => {
    for (const value of AWKWARD_VALUES) {
      const file = parseAgentFileHandle(formatAgentFileHandle({ file: value }));
      expect(file).toEqual({ file: value });

      const chunk = parseAgentChunkHandle(formatAgentChunkHandle({ file: value, line: 3 }));
      expect(chunk).toEqual({ file: value, line: 3 });

      const symbolHandle = { name: value, file: value, line: 7, column: 2 };
      expect(parseAgentSymbolHandle(formatAgentSymbolHandle(symbolHandle))).toEqual(symbolHandle);
    }
  });
});
