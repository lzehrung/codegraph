import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNativeCpuBaseline, scanNativeDisassembly } from "./native-cpu-baseline-lib.mjs";
import { coffJumpTableRanges } from "./native-cpu-coff-lib.mjs";

const archiveMagic = Buffer.from("!<arch>\n");
const metadataMembers = new Set([
  "/",
  "//",
  "/SYM64/",
  "__.SYMDEF",
  "__.SYMDEF SORTED",
  "__.SYMDEF_64",
  "__.SYMDEF_64 SORTED",
]);

function decimal(text, label) {
  if (!/^\d+$/u.test(text)) throw new Error(`${label}: invalid archive size or name offset.`);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new Error(`${label}: archive size or offset is too large.`);
  return value;
}

export function nativeArchiveMembers(bytes, label) {
  if (!bytes.subarray(0, 8).equals(archiveMagic))
    throw new Error(`${label}: unsupported archive (thin archives are not inspectable).`);
  const raw = [];
  let strings = Buffer.alloc(0);
  let offset = 8;
  while (offset < bytes.length) {
    if (offset + 60 > bytes.length || bytes.toString("ascii", offset + 58, offset + 60) !== "`\n") {
      throw new Error(`${label}: truncated or invalid archive member header.`);
    }
    const name = bytes.toString("ascii", offset, offset + 16).trim();
    const size = decimal(bytes.toString("ascii", offset + 48, offset + 58).trim(), label);
    const start = offset + 60;
    const end = start + size;
    if (end > bytes.length) throw new Error(`${label}: truncated archive member ${name}.`);
    const data = bytes.subarray(start, end);
    if (name === "//") strings = data;
    raw.push({ name, data });
    offset = end + (size % 2);
    if (offset > bytes.length) throw new Error(`${label}: missing archive member padding.`);
  }
  const members = [];
  for (const member of raw) {
    let { name, data } = member;
    if (metadataMembers.has(name)) continue;
    if (name.startsWith("#1/")) {
      const size = decimal(name.slice(3), label);
      if (size > data.length) throw new Error(`${label}: truncated BSD member name.`);
      name = data.toString("utf8", 0, size).replace(/\0+$/u, "");
      data = data.subarray(size);
    } else if (/^\/\d+$/u.test(name)) {
      const start = decimal(name.slice(1), label);
      const newline = strings.indexOf(10, start);
      let end = strings.indexOf(0, start);
      const newlineTerminatesName = newline >= 0 && (end < 0 || newline < end);
      if (newlineTerminatesName) end = newline;
      if (start >= strings.length || end < 0) throw new Error(`${label}: invalid long member name.`);
      name = strings.toString("utf8", start, end).replace(/\/$/u, "");
    } else {
      name = name.replace(/\/$/u, "");
    }
    if (!metadataMembers.has(name)) members.push({ name, data });
  }
  if (!members.length) throw new Error(`${label}: no object members found.`);
  return members;
}

export function isCoffShortImport(data) {
  if (data.length < 20 || data.readUInt32LE(0) !== 0xffff0000 || data.readUInt16LE(4) !== 0) return false;
  if (data.readUInt16LE(6) !== 0x8664 || data.readUInt32LE(12) !== data.length - 20) return false;
  const type = data.readUInt16LE(18);
  const importType = type & 3;
  const nameType = type >>> 2;
  if (importType > 2 || nameType > 4) return false;
  const strings = data.subarray(20).toString("utf8").split("\0");
  let expectedStrings = 2;
  if (nameType === 4) expectedStrings = 3;
  if (strings.pop() !== "" || strings.length !== expectedStrings) return false;
  return strings.every((value) => value.length);
}

export function assertNativeObjectSections(text, label) {
  if (!/file format (?:elf64-x86-64|coff-x86-64|mach-o 64-bit x86-64)/u.test(text)) {
    throw new Error(`${label}: undecodable or non-x86-64 object member.`);
  }
  if (/\.gnu\.lto_|\.llvmbc\b|\.llvm\.lto\b|__bitcode\b|__bundle\b/u.test(text)) {
    throw new Error(`${label}: IR/LTO member cannot prove the linked C CPU baseline.`);
  }
  const codeSections = new Set();
  let sections = 0;
  let previous;
  for (const line of text.split(/\r?\n/u)) {
    const section = /^\s*\d+\s+(\S+)\s+([\da-f]+)\s+/iu.exec(line);
    if (section) {
      sections++;
      previous = { name: section[1], size: Number.parseInt(section[2], 16) };
      if (previous.size && /\bTEXT\b/u.test(line)) codeSections.add(previous.name);
    } else if (previous?.size && /\bCODE\b/u.test(line)) {
      codeSections.add(previous.name);
    }
  }
  if (!sections) throw new Error(`${label}: no decodable object sections.`);
  return codeSections;
}

export function assertNoLlvmBitcode(data, label) {
  if (data.length < 4) return;
  const magic = data.readUInt32LE(0);
  if (magic === 0xdec04342 || magic === 0x0b17c0de) {
    throw new Error(`${label}: LLVM bitcode member cannot prove the linked C CPU baseline.`);
  }
}

export function nativeArchives(directory) {
  const archives = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) archives.push(...nativeArchives(filename));
    else if (entry.isFile() && /\.(?:a|lib)$/iu.test(entry.name)) archives.push(filename);
  }
  return archives;
}

/**
 * Checks every C/C++ archive member. Each tool runs llvm-objdump on one extracted member file.
 * @param {string[]} archives
 * @param {{ sectionHeaders: (file: string) => string, disassemble: (file: string) => string }} tools
 */
export function inspectCArchives(archives, { sectionHeaders, disassemble }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "codegraph-native-cpu-"));
  let members = 0;
  let imports = 0;
  let instructions = 0;
  try {
    for (const archive of archives) {
      for (const member of nativeArchiveMembers(fs.readFileSync(archive), archive)) {
        const label = `${path.basename(archive)}(${member.name})`;
        if (isCoffShortImport(member.data)) {
          imports++;
          continue;
        }
        assertNoLlvmBitcode(member.data, label);
        // Never extract member-provided paths. Duplicate names still get separate
        // files/checks, and no linker is allowed to transform uninspected IR.
        const object = path.join(temporary, `${members++}.o`);
        fs.writeFileSync(object, member.data);
        const sections = assertNativeObjectSections(sectionHeaders(object), label);
        const text = disassemble(object);
        const dataRanges = coffJumpTableRanges(member.data, label, text);
        const result = scanNativeDisassembly(text, { allFunctions: true, dataRanges });
        if (sections.size || result.instructions || result.undecodableCount) assertNativeCpuBaseline(result, label);
        for (const section of sections) {
          if (!result.sectionInstructions.get(section))
            throw new Error(`${label}: undecodable executable section ${section}.`);
        }
        instructions += result.instructions;
        fs.unlinkSync(object);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  if (!instructions) throw new Error("No inspectable C/C++ machine code found; refusing an empty archive check.");
  return { members, imports, instructions };
}
