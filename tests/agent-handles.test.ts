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
const AWKWARD_VALUES = [
  "plain",
  "with:colon",
  "with%percent",
  "with%3Aencoded",
  "namespace::method",
  "café",
  "日本語",
  "emoji\u{1f600}",
  "mixed:%é:value",
] as const;

describe("agent handle round-trips", () => {
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
