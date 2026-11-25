// Only x86-64 v1 instructions are accepted in C/C++ code. Rust's independently
// runtime-dispatched SIMD is outside the pre-link C archive inspection.
// CET landing pads/prefixes are backwards-compatible no-ops on v1 CPUs.
const parserSymbol = /^_?(?:ts_|tree_sitter_)/u;
const functionHeader = /^\s*[\da-f]+ <(.+)>:$/iu;
const machoFunctionHeader = /^(_[^\s:]+):$/u;
const addressedLine = /^\s*([\da-f]+):\s+(.*)$/iu;
const mnemonicText = /^([a-z][a-z\d_.]*)\b(.*)$/iu;
const prefixes = new Set("lock rep repe repne repnz repz data16 addr32 cs ds es ss fs gs notrack".split(" "));
const scalar = new Set(
  `adc add and bsf bsr bswap bt btc btr bts call cbw cdq cdqe clc cld cli cltq cltd cmc cmp
  cmps cmpsb cmpsw cmpsl cmpsq cmpxchg cmpxchg8b cpuid cqto cqo cwd cwde cwtl cbtw cwtd dec
  div enter hlt idiv imul in inc ins int int3 invd invlpg iret jmp lea leave lods loop
  loope loopne lret lsl ltr mov movabs movs movsb movsw movsl movsq movsx movzx mul neg nop
  not or out outs pause pop popf popfq push pushf pushfq rcl rcr rdmsr rdpmc rdtsc ret rol ror
  sal sar sbb scas shl shld shr shrd stc std sti stos sub syscall sysret test ud2 verr verw
  wait wbinvd wrmsr xadd xchg xlat xor endbr32 endbr64 rex64`.split(/\s+/u),
);
const sse2 = new Set(
  `addps addss andnps andps cmpps cmpss comiss cvtpi2ps cvtps2pi cvtsi2ss cvtss2si cvttps2pi
  cvttss2si divps divss ldmxcsr maskmovq maxps maxss minps minss movaps movhlps movhps movlhps
  movlps movmskps movntps movntq movss movups mulps mulss orps pavgb pavgw pextrw pinsrw
  pmaxsw pmaxub pminsw pminub pmovmskb pmulhuw psadbw pshufw rcpps rcpss rsqrtps rsqrtss
  sfence shufps sqrtps sqrtss stmxcsr subps subss ucomiss unpckhps unpcklps xorps emms movd movq
  packssdw packsswb packuswb paddb paddw paddd paddq paddsb paddsw paddusb paddusw pand pandn
  pcmpeqb pcmpeqw pcmpeqd pcmpgtb pcmpgtw pcmpgtd pmaddwd pmulhw pmullw por pslld psllq psllw
  psrad psraw psrld psrlq psrlw psubb psubw psubd psubq psubsb psubsw psubusb psubusw
  punpckhbw punpckhwd punpckhdq punpcklbw punpcklwd punpckldq pxor addpd addsd andnpd andpd
  cmppd cmpsd comisd cvtdq2pd cvtdq2ps cvtpd2dq cvtpd2pi cvtpd2ps cvtpi2pd cvtps2dq cvtps2pd
  cvtsd2si cvtsd2ss cvtsi2sd cvtss2sd cvttpd2dq cvttpd2pi cvttps2dq cvttsd2si divpd divsd
  lfence mfence maskmovdqu maxpd maxsd minpd minsd movapd movdqa movdqu movhpd movlpd movmskpd
  movntdq movnti movntpd movsd movupd mulpd mulsd orpd pmuludq pshufd pshufhw pshuflw pslldq
  psrldq punpckhqdq punpcklqdq shufpd sqrtpd sqrtsd subpd subsd ucomisd unpckhpd unpcklpd
  xorpd fxsave fxsave64 fxrstor fxrstor64 prefetchnta prefetcht0 prefetcht1 prefetcht2`.split(/\s+/u),
);
const x87 = new Set(
  `f2xm1 fabs fadd faddp fadds faddl fbld fbstp fchs fclex fcmovb fcmovbe fcmove fcmovnb
  fcmovnbe fcmovne fcmovnu fcmovu fcom fcomp fcompp fcomi fcomip fcos fdecstp fdiv fdivp
  fdivs fdivl fdivr fdivrp fdivrs fdivrl ffree fiadd fiadds fiaddl ficom ficomp ficoms
  ficoml ficomps ficompl fidiv fidivs fidivl fidivr fidivrs fidivrl fild filds fildl fildll
  fimul fimuls fimull fincstp finit fist fists fistl fistp fistps fistpl fistpll fisub
  fisubs fisubl fisubr fisubrs fisubrl fld flds fldl fldt fld1 fldcw fldenv fldl2e fldl2t
  fldlg2 fldln2 fldpi fldz fmul fmulp fmuls fmull fnclex fninit fnop fnsave fnstcw fnstenv
  fnstsw fpatan fprem fprem1 fptan frndint frstor fsave fscale fsin fsincos fsqrt fst fsts
  fstl fstp fstps fstpl fstpt fstcw fstenv fstsw fsub fsubp fsubs fsubl fsubr fsubrp fsubrs
  fsubrl ftst fucom fucomp fucompp fucomi fucomip fwait fxam fxch fxtract fyl2x fyl2xp1`.split(/\s+/u),
);

function isBaselineInstruction(mnemonic, operands) {
  // AVX/AVX-512 vector and mask registers and APX extended GPRs are never baseline.
  if (/%(?:[yz]mm\d+|k[0-7]|r(?:1[6-9]|2\d|3[01])[bwd]?)\b/iu.test(operands)) return false;
  if (scalar.has(mnemonic) || sse2.has(mnemonic) || x87.has(mnemonic)) return true;
  const unsuffixed = mnemonic.replace(/[bwlq]$/u, "");
  if (scalar.has(unsuffixed) || sse2.has(unsuffixed)) return true;
  if (/^mov[sz](?:b[wlq]|w[lq]|lq)$/u.test(mnemonic)) return true;
  if (/^cmp(?:eq|lt|le|unord|neq|nlt|nle|ord)(?:ps|pd|ss|sd)$/u.test(mnemonic)) return true;
  return /^(?:j|set|cmov)(?:a|ae|b|be|c|cxz|e|ecxz|g|ge|l|le|na|nae|nb|nbe|nc|ne|ng|nge|nl|nle|no|np|ns|nz|o|p|pe|po|rcxz|s|z)[bwlq]?$/u.test(
    mnemonic,
  );
}

/**
 * @param {string} text
 * @param {{
 *   allFunctions?: boolean,
 *   dataRanges?: ReadonlyMap<string, ReadonlyArray<{ start: number, end: number }>>,
 * }} [options]
 */
export function scanNativeDisassembly(text, { allFunctions = false, dataRanges } = {}) {
  let symbol = "<unnamed C code>";
  let selected = allFunctions;
  let functions = 0;
  let instructions = 0;
  let parserFunctions = 0;
  let violationCount = 0;
  let undecodableCount = 0;
  let section = "";
  let activeDataRanges;
  const sectionInstructions = new Map();
  const violations = [];
  for (const line of text.split(/\r?\n/u)) {
    const sectionHeader = /^Disassembly of section (.+):$/u.exec(line) ?? /^\([^,]+,([^)]+)\) section$/u.exec(line);
    if (sectionHeader) {
      section = sectionHeader[1].split(",").at(-1);
      activeDataRanges = undefined;
      continue;
    }
    const header = functionHeader.exec(line) ?? machoFunctionHeader.exec(line);
    if (header) {
      symbol = header[1];
      if (dataRanges?.has(symbol)) activeDataRanges = dataRanges.get(symbol);
      const parser = parserSymbol.test(symbol);
      if (parser) parserFunctions++;
      selected = allFunctions || parser;
      if (selected) functions++;
      continue;
    }
    if (!selected) continue;
    const addressed = addressedLine.exec(line);
    if (!addressed) continue;
    if (activeDataRanges?.length) {
      const offset = Number.parseInt(addressed[1], 16);
      let tableData = false;
      for (const range of activeDataRanges) {
        if (offset >= range.start && offset < range.end) {
          tableData = true;
          break;
        }
      }
      if (tableData) continue;
    }
    // LLVM marks VEX, EVEX, and APX encodings with pseudo-prefixes such as {vex} or {nf}.
    const pseudoPrefix = /^(?:\{[a-z\d]+\}\s*)+/iu.exec(addressed[2])?.[0] ?? "";
    const decoded = addressed[2].slice(pseudoPrefix.length);
    // llvm-objdump --macho prints inline jump-table bytes as .long or ".byte ... #bad opcode".
    if (decoded.startsWith(".")) continue;
    // Any other non-instruction text (<unknown>, (bad), or an unfamiliar form) is undecodable.
    const instruction = mnemonicText.exec(decoded);
    if (!instruction) {
      undecodableCount++;
      continue;
    }
    let mnemonic = instruction[1].toLowerCase();
    let operands = instruction[2].trim();
    while (prefixes.has(mnemonic) && operands) {
      const prefixed = mnemonicText.exec(operands);
      if (!prefixed) break;
      mnemonic = prefixed[1].toLowerCase();
      operands = prefixed[2].trim();
    }
    instructions++;
    sectionInstructions.set(section, (sectionInstructions.get(section) ?? 0) + 1);
    // llvm-objdump prints lock alone; a prefix still followed by unparsed text hides an instruction.
    const barePrefix = prefixes.has(mnemonic) && !operands;
    const baseline = !pseudoPrefix && (isBaselineInstruction(mnemonic, operands) || barePrefix);
    if (baseline) continue;
    violationCount++;
    if (violations.length < 10) violations.push(`${symbol}: ${line.trim()}`);
  }
  return {
    functions,
    instructions,
    parserFunctions,
    violationCount,
    undecodableCount,
    sectionInstructions,
    violations,
  };
}

export function assertNativeCpuBaseline(result, label) {
  if (!result.instructions)
    throw new Error(`${label}: no inspectable C/C++ instructions (missing symbols or objects).`);
  if (result.undecodableCount) throw new Error(`${label}: ${result.undecodableCount} undecodable C/C++ instructions.`);
  if (result.violationCount) {
    throw new Error(
      `${label}: ${result.violationCount} instructions outside the x86-64 baseline in C/C++ code:\n${result.violations.join("\n")}`,
    );
  }
}
