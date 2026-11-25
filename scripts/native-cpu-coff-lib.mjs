// MSVC puts relocated jump-table words in executable COMDATs.
// Each word needs a static $LN symbol and a relocation to same-function code.
// A bounded two-stage dispatch also proves its separate byte-selector table:
//   cmpl $N, %bound; ja <code label>; up to three setup instructions;
//   movzbl selectors(%base,%index), %selector; movl entries(%base,%selector,4), %target;
//   addq %base, %target; jmpq *%target
function register64(register) {
  if (/^r(?:[abcd]x|[sb]p|[sd]i|[89]|1[0-5])$/u.test(register)) return register;
  const legacy = /^e([abcd]x|[sb]p|[sd]i)$/u.exec(register);
  if (legacy) return `r${legacy[1]}`;
  const extended = /^r([89]|1[0-5])d$/u.exec(register);
  if (extended) return `r${extended[1]}`;
}

function isDispatchSetup(mnemonic) {
  return /^(?:movslq|cltq|leaq|movl|nop[lw]?)$/u.test(mnemonic);
}

// Setup must widen the bounded register exactly once (movslq, or cltq for %eax).
// leaq may load only the RIP-relative image base, movl only other registers, and
// nothing may overwrite the index before the selector load.
function widenedIndex(setups, bounded, base) {
  let index = register64(bounded);
  let widened = false;
  for (const { mnemonic, operands } of setups) {
    if (mnemonic === "movslq" || mnemonic === "cltq") {
      if (widened) return;
      let source = "eax";
      index = "rax";
      if (mnemonic === "movslq") {
        const extend = /^%([a-z\d]+),\s*%([a-z\d]+)$/u.exec(operands);
        source = extend?.[1];
        index = extend && register64(extend[2]);
      }
      if (source !== bounded || !index) return;
      widened = true;
      continue;
    }
    let written;
    if (mnemonic === "leaq") {
      const load = /^(?:-?(?:0x[\da-f]+|\d+))?\(%rip\),\s*%([a-z\d]+)$/u.exec(operands);
      written = load && register64(load[1]);
      if (written !== base) return;
    } else if (mnemonic === "movl") {
      const load = /^(?:-?(?:0x[\da-f]+|\d+))?\(%[a-z\d]+\),\s*%([a-z\d]+)$/u.exec(operands);
      written = load && register64(load[1]);
      if (!written || written === base) return;
    } else if (!/^nop[lw]?$/u.test(mnemonic)) {
      return;
    }
    if (written === index) return;
  }
  if (widened && index !== base) return index;
}

function boundedSelectorDispatch(sequence) {
  const [compare, branch] = sequence;
  const [byteLoad, wordLoad, addBase, jump] = sequence.slice(-4);
  const bound = /^\$(0x[\da-f]+|\d+),\s*%([a-z\d]+)$/u.exec(compare.operands);
  if (!bound) return;
  // Labels split matched sequences, so a code-label default cannot re-enter the dispatch.
  const defaultTarget = /^(0x[\da-f]+)\b/u.exec(branch.operands);
  if (!defaultTarget) return;
  const words = /^(?:-?(?:0x[\da-f]+|\d+))?\(%([a-z\d]+),%([a-z\d]+),4\),\s*%([a-z\d]+)$/u.exec(wordLoad.operands);
  const base = words && register64(words[1]);
  if (!base) return;
  const index = widenedIndex(sequence.slice(2, -4), bound[2], base);
  if (!index) return;
  const bytes = /^(?:-?(?:0x[\da-f]+|\d+))?\(%([a-z\d]+),%([a-z\d]+)(?:,1)?\),\s*%([a-z\d]+)$/u.exec(byteLoad.operands);
  if (!bytes) return;
  const addressing = [register64(bytes[1]), register64(bytes[2])];
  const loadsSelectorByIndex = addressing.includes(base) && addressing.includes(index);
  if (!loadsSelectorByIndex) return;
  const selector = register64(bytes[3]);
  if (!selector || register64(words[2]) !== selector) return;
  const target = register64(words[3]);
  const add = /^%([a-z\d]+),\s*%([a-z\d]+)$/u.exec(addBase.operands);
  const addsImageBase = add && register64(add[1]) === base && register64(add[2]) === target;
  if (!target || !addsImageBase) return;
  const destination = /^\*%([a-z\d]+)$/u.exec(jump.operands);
  if (!destination || register64(destination[1]) !== target) return;
  return {
    // Each load ends with its 32-bit displacement.
    selectorReference: wordLoad.offset - 4,
    entryReference: addBase.offset - 4,
    length: Number(bound[1]) + 1,
    defaultTarget: Number(defaultTarget[1]),
  };
}

function boundedSelectorDispatches(text, functionNames) {
  const dispatches = new Map();
  if (!text || !functionNames.size) return dispatches;
  const loads = ["movzbl", "movl", "addq", "jmpq"];
  let current;
  let sequence = [];
  let loadStep = 0;
  for (const line of text.split(/\r?\n/u)) {
    if (/^Disassembly of section /u.test(line)) {
      current = undefined;
      sequence = [];
      loadStep = 0;
      continue;
    }
    const header = /^\s*[\da-f]+ <(.+)>:$/iu.exec(line);
    if (header) {
      if (functionNames.has(header[1])) current = header[1];
      sequence = [];
      loadStep = 0;
      continue;
    }
    if (!current || !line.trim()) continue;
    const instruction = /^\s*([\da-f]+):\s+([a-z][a-z\d_.]*)\b(.*)$/iu.exec(line);
    if (!instruction) {
      sequence = [];
      loadStep = 0;
      continue;
    }
    const mnemonic = instruction[2].toLowerCase();
    if (!sequence.length && mnemonic !== "cmpl") continue;
    const instructionRecord = {
      mnemonic,
      offset: Number.parseInt(instruction[1], 16),
      operands: instruction[3].split("#", 1)[0].trim().toLowerCase(),
    };
    if (mnemonic === "cmpl") {
      sequence = [instructionRecord];
      loadStep = 0;
      continue;
    }
    if (sequence.length === 1) {
      if (mnemonic === "ja") sequence.push(instructionRecord);
      else sequence = [];
      continue;
    }
    if (!loadStep && mnemonic !== loads[0]) {
      // MSVC uses at most three setup instructions, including NOPs.
      if (isDispatchSetup(mnemonic) && sequence.length < 5) sequence.push(instructionRecord);
      else sequence = [];
      continue;
    }
    if (mnemonic !== loads[loadStep]) {
      sequence = [];
      loadStep = 0;
      continue;
    }
    sequence.push(instructionRecord);
    if (++loadStep !== loads.length) continue;
    const dispatch = boundedSelectorDispatch(sequence);
    if (dispatch) {
      let entries = dispatches.get(current);
      if (!entries) {
        entries = [];
        dispatches.set(current, entries);
      }
      entries.push(dispatch);
    }
    sequence = [];
    loadStep = 0;
  }
  return dispatches;
}

function isStaticDataLabel(symbol) {
  if (!symbol || symbol.storage !== 3) return false;
  if (symbol.function || symbol.auxiliary) return false;
  return /^\$LN\d+$/u.test(symbol.name);
}

// Dispatch loads use ADDR32NB displacements to static $LN data labels in the same section.
function referencesStaticTable(relocation, sectionIndex) {
  if (relocation?.type !== 3) return false;
  return isStaticDataLabel(relocation.symbol) && relocation.symbol.section === sectionIndex + 1;
}

// Selector bytes are unrelocated data; ADDR64 relocates eight bytes and other types at most four.
function relocationOverlaps(relocations, start, end) {
  for (const [offset, relocation] of relocations) {
    const width = relocation.type === 1 ? 8 : 4;
    if (offset < end && offset + width > start) return true;
  }
  return false;
}

export function coffJumpTableRanges(bytes, label, disassembly = "") {
  /** @type {Map<string, { start: number, end: number }[]>} */
  const ranges = new Map();
  if (bytes.length < 20) return ranges;
  const bigobj = bytes.readUInt32LE(0) === 0xffff0000 && bytes.readUInt16LE(4) >= 2;
  const machine = bytes.readUInt16LE(bigobj ? 6 : 0);
  if (machine !== 0x8664) return ranges;
  const headerSize = bigobj ? 56 : 20 + bytes.readUInt16LE(16);
  const entrySize = bigobj ? 20 : 18;
  const requireBytes = (start, size) => {
    if (start < 0 || start + size > bytes.length) throw new Error(`${label}: truncated COFF metadata.`);
  };
  requireBytes(0, headerSize);
  const sectionCount = bigobj ? bytes.readUInt32LE(44) : bytes.readUInt16LE(2);
  const symbolOffset = bytes.readUInt32LE(bigobj ? 48 : 8);
  const symbolCount = bytes.readUInt32LE(bigobj ? 52 : 12);
  if (!symbolCount) return ranges;
  requireBytes(headerSize, sectionCount * 40);
  requireBytes(symbolOffset, symbolCount * entrySize + 4);
  const stringOffset = symbolOffset + symbolCount * entrySize;
  const stringSize = bytes.readUInt32LE(stringOffset);
  if (stringSize < 4) throw new Error(`${label}: invalid COFF string table.`);
  requireBytes(stringOffset, stringSize);
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const offset = headerSize + index * 40;
    const characteristics = bytes.readUInt32LE(offset + 36);
    sections.push({
      size: bytes.readUInt32LE(offset + 16),
      raw: bytes.readUInt32LE(offset + 20),
      relocations: bytes.readUInt32LE(offset + 24),
      relocationCount: bytes.readUInt16LE(offset + 32),
      relocationOverflow: Boolean(characteristics & 0x01000000),
      executable: Boolean(characteristics & 0x20000000),
      symbols: [],
    });
  }
  const symbols = new Map();
  const functionNames = new Set();
  for (let index = 0; index < symbolCount; ) {
    const offset = symbolOffset + index * entrySize;
    let name;
    if (!bytes.readUInt32LE(offset)) {
      const relative = bytes.readUInt32LE(offset + 4);
      const start = stringOffset + relative;
      const end = bytes.indexOf(0, start);
      if (relative < 4 || end < start || end >= stringOffset + stringSize) {
        throw new Error(`${label}: invalid COFF symbol name.`);
      }
      name = bytes.toString("utf8", start, end);
    } else {
      name = bytes.toString("utf8", offset, offset + 8).replace(/\0.*$/u, "");
    }
    const typeOffset = bigobj ? 16 : 14;
    const symbol = {
      name,
      value: bytes.readUInt32LE(offset + 8),
      section: bigobj ? bytes.readInt32LE(offset + 12) : bytes.readInt16LE(offset + 12),
      function: (bytes.readUInt16LE(offset + typeOffset) & 0x30) === 0x20,
      storage: bytes[offset + typeOffset + 2],
      auxiliary: bytes[offset + typeOffset + 3],
    };
    symbols.set(index, symbol);
    if (symbol.function) functionNames.add(symbol.name);
    sections[symbol.section - 1]?.symbols.push(symbol);
    index += symbol.auxiliary + 1;
    if (index > symbolCount) throw new Error(`${label}: truncated COFF auxiliary symbols.`);
  }
  const dispatches = boundedSelectorDispatches(disassembly, functionNames);
  for (const [sectionIndex, section] of sections.entries()) {
    if (!section.executable) continue;
    requireBytes(section.raw, section.size);
    let relocationOffset = section.relocations;
    let relocationCount = section.relocationCount;
    if (section.relocationOverflow) {
      requireBytes(relocationOffset, 10);
      relocationCount = bytes.readUInt32LE(relocationOffset) - 1;
      if (relocationCount < 0) throw new Error(`${label}: invalid COFF relocation overflow.`);
      relocationOffset += 10;
    }
    requireBytes(relocationOffset, relocationCount * 10);
    const relocations = new Map();
    for (let index = 0; index < relocationCount; index++) {
      const offset = relocationOffset + index * 10;
      const address = bytes.readUInt32LE(offset);
      if (relocations.has(address)) throw new Error(`${label}: duplicate COFF relocation.`);
      relocations.set(address, {
        symbol: symbols.get(bytes.readUInt32LE(offset + 4)),
        type: bytes.readUInt16LE(offset + 8),
      });
    }
    const functions = section.symbols
      .filter((symbol) => symbol.function)
      .sort((left, right) => left.value - right.value);
    const codeLabels = section.symbols.filter((symbol) => symbol.function || symbol.storage === 6);
    for (let index = 0; index < functions.length; index++) {
      const fn = functions[index];
      const functionEnd = functions[index + 1]?.value ?? section.size;
      const data = [];
      ranges.set(fn.name, data);
      for (const symbol of section.symbols) {
        if (!isStaticDataLabel(symbol)) continue;
        if (symbol.value < fn.value || symbol.value >= functionEnd) continue;
        const beginsAtCode = codeLabels.some((code) => code.value === symbol.value);
        if (beginsAtCode) continue;
        let limit = functionEnd;
        for (const code of codeLabels) {
          if (code.value > symbol.value && code.value < limit) limit = code.value;
        }
        let end = symbol.value;
        while (end < limit) {
          const relocation = relocations.get(end);
          if (!relocation) break;
          const wordRelocation = relocation.type === 2 || relocation.type === 3 || relocation.type === 4;
          if (!wordRelocation) break;
          // ADDR32, ADDR32NB, and REL32 each relocate exactly one four-byte word.
          const wordSize = 4;
          if (end + wordSize > limit) break;
          const target = relocation.symbol;
          if (!target || target.section !== sectionIndex + 1) break;
          let addend = bytes.readUInt32LE(section.raw + end);
          if (relocation.type === 4) addend = bytes.readInt32LE(section.raw + end);
          const address = target.value + addend;
          const inFunction = address >= fn.value && address < functionEnd;
          if (!inFunction) break;
          const codeLabel = codeLabels.some((code) => code.value === address);
          if (!codeLabel) break;
          end += wordSize;
        }
        if (end > symbol.value) data.push({ start: symbol.value, end });
      }
      const selectorSpans = [];
      for (const dispatch of dispatches.get(fn.name) ?? []) {
        const selectorReference = relocations.get(dispatch.selectorReference);
        const entryReference = relocations.get(dispatch.entryReference);
        if (!referencesStaticTable(selectorReference, sectionIndex)) continue;
        if (!referencesStaticTable(entryReference, sectionIndex)) continue;
        const start = selectorReference.symbol.value + bytes.readUInt32LE(section.raw + dispatch.selectorReference);
        const entryStart = entryReference.symbol.value + bytes.readUInt32LE(section.raw + dispatch.entryReference);
        const entries = data.find((table) => table.start === entryStart);
        if (!entries) continue;
        const end = start + dispatch.length;
        const insideFunction = start >= fn.value && end <= functionEnd;
        if (!insideFunction) continue;
        const overlapsCode = codeLabels.some((code) => code.value >= start && code.value < end);
        if (overlapsCode) continue;
        const defaultIsCode = codeLabels.some((code) => code.value === dispatch.defaultTarget);
        if (!defaultIsCode) continue;
        if (relocationOverlaps(relocations, start, end)) continue;
        const entryCount = (entries.end - entries.start) / 4;
        const selectors = bytes.subarray(section.raw + start, section.raw + end);
        if (selectors.every((value) => value < entryCount)) selectorSpans.push({ start, end });
      }
      data.push(...selectorSpans);
    }
  }
  return ranges;
}
