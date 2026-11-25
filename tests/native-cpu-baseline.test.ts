import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNativeCpuBaseline, scanNativeDisassembly } from "../scripts/native-cpu-baseline-lib.mjs";
import {
  assertNativeObjectSections,
  assertNoLlvmBitcode,
  inspectCArchives,
  isCoffShortImport,
  nativeArchiveMembers,
  nativeArchives,
} from "../scripts/native-cpu-archive-lib.mjs";
import { coffJumpTableRanges } from "../scripts/native-cpu-coff-lib.mjs";

function fixture(name: string): string {
  return fs.readFileSync(`tests/fixtures/native-cpu-baseline/${name}.txt`, "utf8");
}

function archive(members: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [Buffer.from("!<arch>\n")];
  for (const { name, data } of members) {
    chunks.push(
      Buffer.from(
        `${name.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\x60\n`,
      ),
    );
    chunks.push(data);
    if (data.length % 2) chunks.push(Buffer.from("\n"));
  }
  return Buffer.concat(chunks);
}

function shortImport(): Buffer {
  const strings = Buffer.from("greet\0native.dll\0");
  const data = Buffer.alloc(20 + strings.length);
  data.writeUInt32LE(0xffff0000, 0);
  data.writeUInt16LE(0x8664, 6);
  data.writeUInt32LE(strings.length, 12);
  data.writeUInt16LE(4, 18);
  strings.copy(data, 20);
  return data;
}

type CoffSymbol = { name: string; value: number; type: number; storage: number; section?: number };
type CoffRelocation = { offset: number; target: number; type: number };
type CoffParts = { symbols: CoffSymbol[]; relocations: CoffRelocation[]; content: Buffer };
type TableRange = { start: number; end: number };

function coffObject(symbols: CoffSymbol[], relocations: CoffRelocation[], content: Buffer): Buffer {
  const relocationOffset = 60 + content.length;
  const symbolOffset = relocationOffset + relocations.length * 10;
  const stringOffset = symbolOffset + symbols.length * 18;
  const bytes = Buffer.alloc(stringOffset + 4);
  bytes.writeUInt16LE(0x8664, 0);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt32LE(symbolOffset, 8);
  bytes.writeUInt32LE(symbols.length, 12);
  bytes.write(".text$mn", 20);
  bytes.writeUInt32LE(content.length, 36);
  bytes.writeUInt32LE(60, 40);
  bytes.writeUInt32LE(relocationOffset, 44);
  bytes.writeUInt16LE(relocations.length, 52);
  bytes.writeUInt32LE(0x60000020, 56);
  content.copy(bytes, 60);
  for (const [index, relocation] of relocations.entries()) {
    bytes.writeUInt32LE(relocation.offset, relocationOffset + index * 10);
    bytes.writeUInt32LE(relocation.target, relocationOffset + 4 + index * 10);
    bytes.writeUInt16LE(relocation.type, relocationOffset + 8 + index * 10);
  }
  for (const [index, symbol] of symbols.entries()) {
    const offset = symbolOffset + index * 18;
    bytes.write(symbol.name, offset);
    bytes.writeUInt32LE(symbol.value, offset + 8);
    bytes.writeInt16LE(symbol.section ?? 1, offset + 12);
    bytes.writeUInt16LE(symbol.type, offset + 14);
    bytes[offset + 16] = symbol.storage;
  }
  bytes.writeUInt32LE(4, stringOffset);
  return bytes;
}

function coffJumpTable(relocationOffsets: number[] = [16]): Buffer {
  return coffObject(
    [
      { name: "helper", value: 0, type: 0x20, storage: 3 },
      { name: "$LN1", value: 8, type: 0, storage: 6 },
      { name: "$LN2", value: 16, type: 0, storage: 3 },
      { name: "$LN3", value: 24, type: 0, storage: 3 },
      { name: "$LN4", value: 32, type: 0, storage: 6 },
    ],
    relocationOffsets.map((offset) => ({ offset, target: 1, type: 3 })),
    Buffer.alloc(40),
  );
}

function coffIndexTableParts(selectorFixture = "coff-index-selectors", tail: Buffer = Buffer.alloc(0)): CoffParts {
  // ts_parser__lex from the MSVC-built runtime: seven RVA words and 84 selectors.
  const targets = [0xd57, 0xd6a, 0xd7d, 0xd90, 0xda3, 0xdb6, 0xdc9];
  const content = Buffer.alloc(0xed0 + tail.length);
  content.set(Buffer.from("83f9530f878b0000004863c1410fb6840100000000418b8c81000000004903c9ffe1", "hex"), 0xd35);
  content.set(Buffer.from(fixture(selectorFixture).replace(/\s/gu, ""), "hex"), 0xe7c);
  content.set(tail, 0xed0);
  for (const offset of targets) content[offset] = 0xc3;
  return {
    symbols: [
      { name: "helper", value: 0, type: 0x20, storage: 3 },
      { name: "$LN309", value: 0xe60, type: 0, storage: 3 },
      { name: "$LN308", value: 0xe7c, type: 0, storage: 3 },
      ...targets.map((value, index) => ({ name: `$LN${43 + index}`, value, type: 0, storage: 6 })),
    ],
    relocations: [
      // The first relocation follows the section, so a span read past it would see a valid selector (5).
      { offset: 0x5, target: 0, type: 4 },
      { offset: 0xd46, target: 2, type: 3 },
      { offset: 0xd4e, target: 1, type: 3 },
      ...targets.map((_, index) => ({ offset: 0xe60 + index * 4, target: index + 3, type: 3 })),
    ],
    content,
  };
}

function coffIndexTable(selectorFixture?: string, tail?: Buffer): Buffer {
  const { symbols, relocations, content } = coffIndexTableParts(selectorFixture, tail);
  return coffObject(symbols, relocations, content);
}

function coffHtmlIndexTable(): Buffer {
  // MSVC's HTML scanner uses CLTQ with base setup and an unrelated side load.
  const targets: [string, number][] = [
    ["$LN12", 0x55],
    ["$LN8", 0x32],
    ["$LN7", 0x2b],
    ["$LN16", 0x66],
    ["$LN10", 0x3f],
    ["$LN13", 0x5c],
    ["$LN18", 0x74],
    ["$LN17", 0x6d],
    ["$LN20", 0x87],
  ];
  const content = Buffer.alloc(0x102);
  content.set(Buffer.from("83f851777d8b124c8d05000000004898410fb6840000000000418b8c80000000004903c8ffe1", "hex"), 5);
  content.set(Buffer.from(fixture("coff-html-index-selectors").replace(/\s/gu, ""), "hex"), 0xb0);
  for (const [, offset] of targets) content[offset] = 0xc3;
  return coffObject(
    [
      { name: "helper", value: 0, type: 0x20, storage: 3 },
      { name: "$LN38", value: 0x8c, type: 0, storage: 3 },
      { name: "$LN37", value: 0xb0, type: 0, storage: 3 },
      ...targets.map(([name, value]) => ({ name, value, type: 0, storage: 6 })),
    ],
    [
      { offset: 0x1a, target: 2, type: 3 },
      { offset: 0x22, target: 1, type: 3 },
      ...targets.map((_, index) => ({ offset: 0x8c + index * 4, target: index + 3, type: 3 })),
    ],
    content,
  );
}

function expectSelectorsUnproven(name: string, text: string, object: Buffer, table: TableRange): void {
  const dataRanges = coffJumpTableRanges(object, name, text);
  expect(dataRanges.get("helper"), name).toEqual([table]);
  const result = scanNativeDisassembly(text, { allFunctions: true, dataRanges });
  expect(() => assertNativeCpuBaseline(result, name), name).toThrow("undecodable");
}

type ObjdumpOutput = { data: Buffer; headers: string; disassembly: string };

function objdumpHeaders(format: string, ...sections: string[]): string {
  const rows = sections.map((section, index) => `  ${index} ${section}\n`).join("");
  return `member.o: file format ${format}\nSections:\nIdx Name Size VMA Type\n${rows}`;
}

// Runs the CLI's build-directory inspection with canned llvm-objdump output for each member.
function inspectBuild(files: Record<string, Buffer>, outputs: ObjdumpOutput[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-native-cpu-build-"));
  try {
    for (const [name, data] of Object.entries(files)) {
      const file = path.join(directory, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
    const objdump = (file: string): ObjdumpOutput => {
      const data = fs.readFileSync(file);
      const output = outputs.find((candidate) => candidate.data.equals(data));
      // llvm-objdump also rejects COFF short-import members as invalid object files.
      if (!output) throw new Error(`${file}: The file was not recognized as a valid object file`);
      return output;
    };
    return inspectCArchives(nativeArchives(directory), {
      sectionHeaders: (file) => objdump(file).headers,
      disassemble: (file) => objdump(file).disassembly,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

describe("native x86-64 CPU baseline guard", () => {
  it("accepts SSE2 parser code without rejecting runtime-dispatched Rust AVX2", () => {
    const result = scanNativeDisassembly(fixture("linked"));
    expect(result.parserFunctions).toBe(3);
    expect(result.instructions).toBe(7);
    expect(result.violationCount).toBe(0);
    expect(() => assertNativeCpuBaseline(result, "addon")).not.toThrow();
  });

  it("handles Mach-O function labels and data directives without ignoring real AVX", () => {
    const result = scanNativeDisassembly(fixture("macho"));
    expect(result.parserFunctions).toBe(3);
    expect(result.instructions).toBe(5);
    expect(result.undecodableCount).toBe(0);
    expect(result.violationCount).toBe(1);
    expect(result.violations[0]).toContain("_tree_sitter_cpp_external_scanner_scan");
  });

  it("rejects AVX2, XMM-only VEX, LLVM {vex} forms, AVX-512 mask registers, and vzeroupper", () => {
    const result = scanNativeDisassembly(fixture("avx"));
    expect(result.violationCount).toBe(7);
    expect(result.violations.join("\n")).toContain("ts_lexer_init");
    expect(result.violations.join("\n")).toContain("vpaddd %xmm0");
    expect(result.violations.join("\n")).toContain("{vex}\tvpdpbusd");
    expect(result.violations.join("\n")).toContain("kmovw");
    expect(() => assertNativeCpuBaseline(result, "addon")).toThrow("7 instructions outside the x86-64 baseline");
  });

  it("checks unprefixed static helpers and C++ scanners in pre-link C archives", () => {
    const result = scanNativeDisassembly(fixture("archive"), { allFunctions: true });
    expect(result.functions).toBe(3);
    expect(result.parserFunctions).toBe(1);
    expect(result.violationCount).toBe(2);
    expect(result.violations[0]).toContain("scan_implicit_end_tag");
    expect(result.violations[1]).toContain("_ZN12_GLOBAL__N_17Scanner4scanEv");
    expect(() => assertNativeCpuBaseline(result, "scanner.lib")).toThrow("scanner.lib");
  });

  it("fails closed for stripped addons or unrecognized disassembler output", () => {
    for (const text of ["", "addon.node: file format coff-x86-64", "00000000 <napi_register_module_v1>:\n 0: retq"]) {
      expect(() => assertNativeCpuBaseline(scanNativeDisassembly(text), "addon")).toThrow("no inspectable C/C++");
    }
  });

  it("bounds diagnostics without stopping the scan early", () => {
    const text = `00000000 <ts_lexer_init>:\n${" 0: vzeroupper\n".repeat(30)}`;
    const result = scanNativeDisassembly(text);
    expect(result.violationCount).toBe(30);
    expect(result.violations).toHaveLength(10);
  });

  it("pins the GNU, macOS, and MSVC x86-64 C/C++ compiler targets", () => {
    const config = fs.readFileSync(".cargo/config.toml", "utf8");
    const flags = {
      x86_64_unknown_linux_gnu: "-march=x86-64",
      x86_64_apple_darwin: "-march=x86-64",
      x86_64_pc_windows_msvc: "/arch:SSE2",
    };
    for (const [target, value] of Object.entries(flags)) {
      expect(config).toContain(`CFLAGS_${target} = "${value}"`);
      expect(config).toContain(`CXXFLAGS_${target} = "${value}"`);
    }
    expect(config).not.toContain("aarch64");
    expect(config).not.toContain("target-cpu");
    const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain("CFLAGS_x86_64_unknown_linux_musl: -mcpu=baseline");
    expect(workflow).toContain("CXXFLAGS_x86_64_unknown_linux_musl: -mcpu=baseline");
  });

  it("checks release archives before uploading without downloading third-party guard tools", () => {
    const workflow = fs.readFileSync(".github/workflows/release.yml", "utf8");
    const start = workflow.indexOf("  build-native-artifacts:");
    const job = workflow.slice(start, workflow.indexOf("  assemble-release-candidates:", start));
    const guard = job.indexOf("      - name: Check x86-64 native CPU baseline");
    expect(guard).toBeGreaterThan(job.indexOf("      - name: Stage native target"));
    expect(guard).toBeLessThan(job.indexOf("      - name: Upload staged native directory"));
    expect(job).toContain("permissions:\n      contents: read");
    expect(job).not.toContain("id-token:");
    expect(job).not.toContain("docker run");
    expect(job).not.toContain("apt-get");
    expect(job).not.toContain("apk add");
    expect(job).toContain("rustup component add llvm-tools-preview");
    expect(job).toContain("--build-dir packages/codegraph-native/target/${{ matrix.rust-target }}/release/build");
    for (const target of ["unknown_linux_gnu", "apple_darwin", "pc_windows_msvc"]) {
      expect(job).toContain(`CFLAGS_x86_64_${target}:`);
      expect(job).toContain(`CXXFLAGS_x86_64_${target}:`);
    }
  });

  it("guards release-mode source builds in ordinary CI too", () => {
    const workflow = fs.readFileSync(".github/workflows/on-demand-ci.yml", "utf8");
    for (const job of [
      "build-and-test",
      "build-and-test-source",
      "build-and-test-windows",
      "windows-node24-cli-teardown",
    ]) {
      const start = workflow.indexOf(`  ${job}:\n`);
      const remaining = workflow.slice(start);
      const nextJob = remaining.slice(1).search(/\n {2}[a-z][a-z-]+:\n/u);
      const block = nextJob < 0 ? remaining : remaining.slice(0, nextJob + 1);
      expect(block).toContain("name: Check x86-64 native CPU baseline");
      expect(block).toContain("/release/build");
      expect(block).toContain("CFLAGS_x86_64_");
      expect(block).toContain("CXXFLAGS_x86_64_");
    }
    expect(workflow).toContain("if: runner.arch == 'X64'");
    expect(workflow).toContain("SandyBridge GNU parse/query smoke");
  });

  it("pins the PR CPU smoke image and QEMU binary version and exercises the HCL scanner", () => {
    const workflow = fs.readFileSync(".github/workflows/on-demand-ci.yml", "utf8");
    expect(workflow).toMatch(/node:24\.10\.0-bookworm-slim@sha256:[\da-f]{64}/u);
    expect(workflow).toContain("qemu-user=1:7.2+dfsg-7+deb12u18+b3");
    const smoke = fs.readFileSync("scripts/native-cpu-smoke.cjs", "utf8");
    expect(smoke).toContain('"terraform"');
    expect(smoke).toContain("<<-EOT");
    expect(smoke).toContain("(attribute . (identifier) @name)");
  });

  it("accepts every x86-64 v1 instruction family and harmless legacy prefixes", () => {
    const result = scanNativeDisassembly(fixture("v1"), { allFunctions: true });
    expect(result.instructions).toBe(21);
    expect(result.violationCount).toBe(0);
    expect(() => assertNativeCpuBaseline(result, "baseline")).not.toThrow();
  });

  it("rejects scalar v2/v3, BMI1/2, SSE3/4, FMA, F16C, APX, and unrecognized extensions", () => {
    const result = scanNativeDisassembly(fixture("post-v1"));
    expect(result.violationCount).toBe(48);
    expect(() => assertNativeCpuBaseline(result, "HCL scanner")).toThrow("48 instructions outside");
  });

  it("checks stripped unprefixed code and rejects partially undecodable members", () => {
    const result = scanNativeDisassembly("Disassembly of section .text:\n 0: shlxq %rdx, %rsi, %rax", {
      allFunctions: true,
    });
    expect(result.violationCount).toBe(1);
    expect(result.sectionInstructions.get(".text")).toBe(1);
    for (const marker of ["<unknown>", "(bad)"]) {
      const undecodable = scanNativeDisassembly(` 0: retq\n 1: ${marker}`, { allFunctions: true });
      expect(() => assertNativeCpuBaseline(undecodable, "member.o")).toThrow("undecodable");
    }
    // A prefix passes alone, but not when unparsed text after it could hide an instruction.
    const prefixed = scanNativeDisassembly(" 0: lock\n 1: rep {evex} addb $0x7b, %bl", { allFunctions: true });
    expect(prefixed.instructions).toBe(2);
    expect(prefixed.violations).toEqual(["<unnamed C code>: 1: rep {evex} addb $0x7b, %bl"]);
  });

  it("recognizes only complete x64 COFF short imports, not ordinary or bigobj members", () => {
    expect(isCoffShortImport(shortImport())).toBeTruthy();
    const bigobj = shortImport();
    bigobj.writeUInt16LE(2, 4);
    expect(isCoffShortImport(bigobj)).toBeFalsy();
    const malformed = shortImport();
    malformed.writeUInt32LE(0, 12);
    expect(isCoffShortImport(malformed)).toBeFalsy();
    expect(isCoffShortImport(Buffer.from("ordinary C object"))).toBeFalsy();
  });

  it("preserves every duplicate/import/IR member instead of accepting one safe member per archive", () => {
    const bytes = archive([
      { name: "/", data: Buffer.from("linker symbol table") },
      { name: "scanner.o/", data: Buffer.from("ordinary C object") },
      { name: "scanner.o/", data: Buffer.from([0x42, 0x43, 0xc0, 0xde]) },
      { name: "native.dll/", data: shortImport() },
    ]);
    const members = nativeArchiveMembers(bytes, "mixed.lib");
    expect(members.map((member) => member.name)).toEqual(["scanner.o", "scanner.o", "native.dll"]);
    expect(isCoffShortImport(members[0].data)).toBeFalsy();
    expect(() => assertNoLlvmBitcode(members[1].data, "scanner.o")).toThrow("LLVM bitcode");
    expect(isCoffShortImport(members[2].data)).toBeTruthy();
  });

  it("resolves GNU, COFF NUL-terminated, and BSD archive member names", () => {
    for (const terminator of ["/\n", "\0"]) {
      const members = nativeArchiveMembers(
        archive([
          { name: "//", data: Buffer.from(`long-scanner-name.o${terminator}`) },
          { name: "/0", data: Buffer.from("machine code") },
        ]),
        "names.a",
      );
      expect(members[0].name).toBe("long-scanner-name.o");
    }
    const name = Buffer.from("bsd-scanner-name.o");
    const members = nativeArchiveMembers(
      archive([{ name: `#1/${name.length}`, data: Buffer.concat([name, Buffer.from("machine code")]) }]),
      "bsd.a",
    );
    expect(members[0].name).toBe("bsd-scanner-name.o");
    expect(members[0].data.toString()).toBe("machine code");
  });

  it("rejects thin/truncated archives and unknown object formats", () => {
    expect(() => nativeArchiveMembers(Buffer.from("!<thin>\n"), "thin.a")).toThrow("unsupported archive");
    const bytes = archive([{ name: "scanner.o/", data: Buffer.from("machine code") }]);
    expect(() => nativeArchiveMembers(bytes.subarray(0, bytes.length - 2), "truncated.a")).toThrow("truncated");
    expect(() => assertNativeObjectSections("unknown", "member.o")).toThrow("undecodable");
  });

  it("rejects GCC/LLVM IR even when an object or archive also has ordinary machine code", () => {
    const headers = "member.o: file format elf64-x86-64\nSections:\nIdx Name Size VMA Type\n";
    for (const section of [".gnu.lto_scanner", ".llvmbc", ".llvm.lto", "__bitcode", "__bundle"]) {
      expect(() =>
        assertNativeObjectSections(`${headers} 0 .text 0001 0000 TEXT\n 1 ${section} 0010 0000 DATA`, "mixed.o"),
      ).toThrow("IR/LTO");
    }
    expect(() => assertNoLlvmBitcode(Buffer.from([0xde, 0xc0, 0x17, 0x0b]), "wrapped.bc")).toThrow("LLVM bitcode");
    expect(
      assertNativeObjectSections("member.o: file format coff-x86-64\n 0 .idata$2 0010 0000 DATA", "import descriptor")
        .size,
    ).toBe(0);
  });

  it("inspects every build-directory archive member and skips only COFF short imports", () => {
    const runtime = {
      data: coffIndexTable(),
      headers: objdumpHeaders("coff-x86-64", ".text$mn 00000ed0 0000000000000000 TEXT"),
      disassembly: fixture("coff-index-table"),
    };
    const imports = archive([{ name: "native.dll/", data: shortImport() }]);
    const build = {
      "tree-sitter-1/out/libtree-sitter.a": archive([{ name: "lib.o/", data: runtime.data }]),
      "codegraph_native.dll.lib": imports,
    };
    expect(inspectBuild(build, [runtime])).toEqual({ members: 1, imports: 1, instructions: 14 });
    expect(() => inspectBuild({ "codegraph_native.dll.lib": imports }, [])).toThrow("refusing an empty archive check");
    const invalid = { ...runtime, data: coffIndexTable("coff-index-selectors-invalid") };
    const invalidBuild = { "libtree-sitter.a": archive([{ name: "lib.o/", data: invalid.data }]) };
    expect(() => inspectBuild(invalidBuild, [invalid])).toThrow("2 undecodable");
  });

  it("rejects IR/LTO members and undecoded code sections from build archives", () => {
    const scanner = (data: Buffer) => ({ "libscanner.a": archive([{ name: "scanner.o/", data }]) });
    const bitcode = Buffer.from([0x42, 0x43, 0xc0, 0xde, 0x35, 0x14, 0x00, 0x00]);
    expect(() => inspectBuild(scanner(bitcode), [])).toThrow("LLVM bitcode");
    const lto = {
      data: Buffer.from("GCC LTO object"),
      headers: objdumpHeaders(
        "elf64-x86-64",
        ".text 00000001 0000000000000000 TEXT",
        ".gnu.lto_.symtab.0 00000010 0000000000000000 DATA",
      ),
      disassembly: "member.o: file format elf64-x86-64\n",
    };
    expect(() => inspectBuild(scanner(lto.data), [lto])).toThrow("IR/LTO");
    const hidden = {
      data: Buffer.from("object with an undecoded section"),
      headers: objdumpHeaders(
        "elf64-x86-64",
        ".text 00000001 0000000000000000 TEXT",
        ".text.unlikely 00000004 0000000000000000 TEXT",
      ),
      disassembly: "Disassembly of section .text:\n0000000000000000 <scan>:\n       0: retq\n",
    };
    expect(() => inspectBuild(scanner(hidden.data), [hidden])).toThrow("undecodable executable section .text.unlikely");
  });

  it("checks code immediately after the last relocated MSVC jump-table entry", () => {
    const text = fixture("coff-jump-table");
    const dataRanges = coffJumpTableRanges(coffJumpTable(), "fixture.obj", text);
    expect(dataRanges.get("helper")).toEqual([{ start: 16, end: 20 }]);
    const result = scanNativeDisassembly(text, { allFunctions: true, dataRanges });
    expect(result.instructions).toBe(5);
    expect(result.undecodableCount).toBe(0);
    expect(result.violationCount).toBe(1);
    expect(result.violations[0]).toContain("14: vpxor");
    expect(() => assertNativeCpuBaseline(result, "bad-code.obj")).toThrow("outside the x86-64 baseline");
    const baseline = text.replace("vpxor %ymm0, %ymm0, %ymm0", "pxor %xmm0, %xmm0");
    const clean = scanNativeDisassembly(baseline, { allFunctions: true, dataRanges });
    expect(() => assertNativeCpuBaseline(clean, "fixture.obj")).not.toThrow();
    const outside = scanNativeDisassembly(`${baseline}\n 21: <unknown>`, {
      allFunctions: true,
      dataRanges,
    });
    expect(() => assertNativeCpuBaseline(outside, "bad-code.obj")).toThrow("undecodable");
  });

  it("requires contiguous word-sized relocations beginning at the static table label", () => {
    const contiguous = coffJumpTable([20, 16]);
    expect(coffJumpTableRanges(contiguous, "contiguous.obj").get("helper")).toEqual([{ start: 16, end: 24 }]);
    const gap = coffJumpTable([16, 28]);
    expect(coffJumpTableRanges(gap, "gap.obj").get("helper")).toEqual([{ start: 16, end: 20 }]);
    const missingStart = coffJumpTable([20]);
    expect(coffJumpTableRanges(missingStart, "missing-start.obj").get("helper")).toEqual([]);
    const relative = coffJumpTable();
    relative.writeUInt32LE(4, 104);
    relative.writeUInt16LE(4, 108);
    relative.writeInt32LE(-24, 76);
    expect(coffJumpTableRanges(relative, "relative.obj").get("helper")).toEqual([{ start: 16, end: 20 }]);
    const incompleteWord = coffJumpTable();
    incompleteWord.writeUInt32LE(18, 190);
    expect(coffJumpTableRanges(incompleteWord, "incomplete-word.obj").get("helper")).toEqual([]);
    const unsupported = coffJumpTable([16, 20]);
    unsupported.writeUInt16LE(10, 118);
    expect(coffJumpTableRanges(unsupported, "unsupported-word.obj").get("helper")).toEqual([{ start: 16, end: 20 }]);
    expect(() => coffJumpTableRanges(coffJumpTable([16, 16]), "duplicate.obj")).toThrow("duplicate COFF relocation");
  });

  it("recognizes the MSVC runtime's bounded byte-selector dispatch without extending its span", () => {
    const text = fixture("coff-index-table");
    const dataRanges = coffJumpTableRanges(coffIndexTable(), "index-table.obj", text);
    expect(dataRanges.get("helper")).toEqual([
      { start: 0xe60, end: 0xe7c },
      { start: 0xe7c, end: 0xed0 },
    ]);
    const result = scanNativeDisassembly(text, { allFunctions: true, dataRanges });
    expect(result.undecodableCount).toBe(0);
    expect(() => assertNativeCpuBaseline(result, "index-table.obj")).not.toThrow();
    // AVX2 code right after the selector span, still inside the function, stays classified.
    const tail = coffIndexTable("coff-index-selectors", Buffer.from("c5fdefc0c3", "hex"));
    const extended = `${text}     ed0: vpxor %ymm0, %ymm0, %ymm0\n     ed4: retq\n`;
    const tailRanges = coffJumpTableRanges(tail, "code-after-selectors.obj", extended);
    expect(tailRanges.get("helper")).toEqual(dataRanges.get("helper"));
    const after = scanNativeDisassembly(extended, { allFunctions: true, dataRanges: tailRanges });
    expect(after.violationCount).toBe(1);
    expect(() => assertNativeCpuBaseline(after, "code-after-selectors.obj")).toThrow("outside the x86-64 baseline");
  });

  it("rejects an out-of-range byte in the real MSVC selector-table shape", () => {
    const text = fixture("coff-index-table");
    const dataRanges = coffJumpTableRanges(coffIndexTable("coff-index-selectors-invalid"), "bad-selector.obj", text);
    expect(dataRanges.get("helper")).toEqual([{ start: 0xe60, end: 0xe7c }]);
    const result = scanNativeDisassembly(text, { allFunctions: true, dataRanges });
    expect(result.undecodableCount).toBe(2);
    expect(() => assertNativeCpuBaseline(result, "bad-selector.obj")).toThrow("undecodable");
  });

  it("requires every bounded-dispatch instruction, bound, and register-flow condition", () => {
    const runtime = fixture("coff-index-table");
    const widen = "     d3e: movslq %ecx, %rax\n";
    const leaqOverwritesBound = runtime
      .replace(widen, `     d3a: leaq (%rip), %rcx\n${widen}`)
      .replace("(%r9,%rax), %eax", "(%rcx,%rax), %eax")
      .replace("(%r9,%rax,4), %ecx", "(%rcx,%rax,4), %edx")
      .replace("addq %r9, %rcx", "addq %rcx, %rdx")
      .replace("jmpq *%rcx", "jmpq *%rdx");
    const runtimeMutations: [string, string][] = [
      ["compare is not cmpl", runtime.replace("cmpl", "testl")],
      ["bound runs past the function", runtime.replace("$0x53", "$0x54")],
      ["branch is not ja", runtime.replace("ja 0xdc9", "jbe 0xdc9")],
      ["default target is not a code label", runtime.replace("ja 0xdc9 <$LN49>", "ja 0xdc8 <$LN48+0x12>")],
      ["widening reads another register", runtime.replace("movslq %ecx", "movslq %edx")],
      ["index is never widened", runtime.replace(widen, "").replace("(%r9,%rax), %eax", "(%r9,%rcx), %eax")],
      [
        "bound is widened again after setup overwrites it",
        runtime.replace(widen, `${widen}     d3e: movl (%rdx), %ecx\n${widen}`),
      ],
      ["setup overwrites the image base", runtime.replace(widen, `${widen}     d3e: movl (%rdx), %r9d\n`)],
      ["leaq overwrites the bound before widening", leaqOverwritesBound],
      [
        "index is widened into the image base",
        runtime.replace("%ecx, %rax", "%ecx, %r9").replace("(%r9,%rax), %eax", "(%r9,%r9), %eax"),
      ],
      ["selector load scales the index", runtime.replace("(%r9,%rax), %eax", "(%r9,%rax,2), %eax")],
      ["selector load uses another base", runtime.replace("(%r9,%rax), %eax", "(%r8,%rax), %eax")],
      ["entry load uses another base", runtime.replace("(%r9,%rax,4)", "(%r8,%rax,4)")],
      ["entry load scales by eight", runtime.replace("(%r9,%rax,4)", "(%r9,%rax,8)")],
      ["entry load ignores the loaded selector", runtime.replace("(%r9,%rax), %eax", "(%r9,%rax), %edx")],
      ["jump target is not the loaded entry", runtime.replace("(%r9,%rax,4), %ecx", "(%r9,%rax,4), %edx")],
      ["entry is not rebased on the image base", runtime.replace("addq %r9", "addq %r8")],
      ["jump uses another register", runtime.replace("jmpq *%rcx", "jmpq *%rax")],
    ];
    for (const [name, text] of runtimeMutations) {
      expectSelectorsUnproven(name, text, coffIndexTable(), { start: 0xe60, end: 0xe7c });
    }
    const html = fixture("coff-html-index-table");
    const htmlMutations: [string, string][] = [
      ["cltq widens a bound outside %eax", html.replace("cmpl $0x51, %eax", "cmpl $0x51, %ecx")],
      ["setup overwrites the bounded index", html.replace("movl (%rdx), %edx", "movl (%rdx), %eax")],
      ["leaq loads a register other than the image base", html.replace("leaq (%rip), %r8", "leaq (%rip), %rdx")],
      ["more than three setup instructions", html.replace("      13: cltq", "      12: nop\n      13: cltq")],
      ["setup is not a recognized instruction", html.replace("movl (%rdx), %edx", "addl $1, %eax")],
      ["selector load index is not the widened bound", html.replace("movzbl (%r8,%rax)", "movzbl (%r8,%rcx)")],
    ];
    for (const [name, text] of htmlMutations) {
      expectSelectorsUnproven(name, text, coffHtmlIndexTable(), { start: 0x8c, end: 0xb0 });
    }
  });

  it("requires static ADDR32NB selector and entry references and an unlabeled, unrelocated span", () => {
    const text = fixture("coff-index-table");
    const mutations: [string, (parts: CoffParts) => unknown][] = [
      ["selector reference is REL32", ({ relocations }) => Object.assign(relocations[1], { type: 4 })],
      ["entry reference is REL32", ({ relocations }) => Object.assign(relocations[2], { type: 4 })],
      [
        "selector reference is relative to the function symbol",
        ({ relocations, content }) => {
          relocations[1].target = 0;
          content.writeUInt32LE(0xe7c, relocations[1].offset);
        },
      ],
      ["selector label lies in another section", ({ symbols }) => Object.assign(symbols[2], { section: 2 })],
      ["entry reference is not a relocated table", ({ relocations }) => Object.assign(relocations[2], { target: 2 })],
      [
        "selector span contains a code label",
        ({ symbols }) => symbols.push({ name: "$LN50", value: 0xe82, type: 0, storage: 6 }),
      ],
      ["selector span is relocated", ({ relocations }) => relocations.push({ offset: 0xe90, target: 3, type: 3 })],
    ];
    for (const [name, mutate] of mutations) {
      const parts = coffIndexTableParts();
      mutate(parts);
      const object = coffObject(parts.symbols, parts.relocations, parts.content);
      expectSelectorsUnproven(name, text, object, { start: 0xe60, end: 0xe7c });
    }
  });

  it("recognizes real MSVC setup, padding, SIB order, and backward default targets", () => {
    const text = fixture("coff-html-index-table");
    const forms = [
      text,
      text.replace("       a: movl (%rdx), %edx\n", ""),
      text.replace("       c: leaq (%rip), %r8\n", ""),
      text.replace("movl (%rdx), %edx", "nopw (%rax,%rax)"),
      text.replace("movzbl (%r8,%rax)", "movzbl (%rax,%r8)"),
      text.replace("ja 0x87", "ja 0x0"),
    ];
    for (const disassembly of forms) {
      const dataRanges = coffJumpTableRanges(coffHtmlIndexTable(), "html-index.obj", disassembly);
      expect(dataRanges.get("helper")).toEqual([
        { start: 0x8c, end: 0xb0 },
        { start: 0xb0, end: 0x102 },
      ]);
      const result = scanNativeDisassembly(disassembly, { allFunctions: true, dataRanges });
      expect(result.undecodableCount).toBe(0);
      expect(() => assertNativeCpuBaseline(result, "html-index.obj")).not.toThrow();
    }
  });

  it("does not trust $LN names without code-target relocations or leak ranges across COMDATs", () => {
    const object = coffJumpTable();
    object.writeUInt32LE(2, 104);
    const dataRanges = coffJumpTableRanges(object, "unproven.obj");
    expect(dataRanges.get("helper")).toEqual([]);
    const unproven = scanNativeDisassembly(fixture("coff-jump-table"), { allFunctions: true, dataRanges });
    expect(() => assertNativeCpuBaseline(unproven, "unproven.obj")).toThrow("undecodable");
    const codeAlias = coffJumpTable();
    codeAlias.writeUInt32LE(16, 136);
    codeAlias.writeUInt32LE(0, 104);
    expect(coffJumpTableRanges(codeAlias, "code-alias.obj").get("helper")).toEqual([]);
    const nextSection = scanNativeDisassembly(
      `${fixture("coff-jump-table")}\nDisassembly of section .text$mn:\n 10: <unknown>`,
      {
        allFunctions: true,
        dataRanges: coffJumpTableRanges(coffJumpTable(), "fixture.obj"),
      },
    );
    expect(() => assertNativeCpuBaseline(nextSection, "new-section.obj")).toThrow("undecodable");
  });
});
