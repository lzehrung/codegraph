function transformJsLikeTrivia(src: string, options?: { maskStrings?: boolean; preserveLength?: boolean }): string {
  let out = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escapeNext = false;
  const maskStrings = options?.maskStrings ?? false;
  const preserveLength = options?.preserveLength ?? false;
  const maskedChar = (ch: string) => (ch === "\n" || ch === "\r" ? ch : " ");

  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1] ?? "";

    if (inSingle || inDouble || inTemplate) {
      const isClosingQuote =
        !escapeNext && ((inSingle && ch === "'") || (inDouble && ch === '"') || (inTemplate && ch === "`"));
      if (maskStrings) {
        out += isClosingQuote ? ch : maskedChar(ch);
      } else {
        out += ch;
      }
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (inSingle && ch === "'") {
        inSingle = false;
      } else if (inDouble && ch === '"') {
        inDouble = false;
      } else if (inTemplate && ch === "`") {
        inTemplate = false;
      }
      i += 1;
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "`") {
      inTemplate = true;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "*") {
      if (preserveLength) out += "  ";
      i += 2;
      while (i < src.length) {
        if (src[i] === "*" && src[i + 1] === "/") {
          if (preserveLength) out += "  ";
          i += 2;
          break;
        }
        if (preserveLength) out += maskedChar(src[i]!);
        else if (src[i] === "\n") out += "\n";
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      if (preserveLength) out += "  ";
      i += 2;
      while (i < src.length && src[i] !== "\n") {
        if (preserveLength) out += " ";
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

export function stripJsLikeComments(src: string): string {
  return transformJsLikeTrivia(src);
}

export function maskJsLikeCommentsAndStrings(src: string): string {
  return transformJsLikeTrivia(src, {
    maskStrings: true,
    preserveLength: true,
  });
}

function previousNonWhitespaceIndex(src: string, start: number): number {
  for (let i = start; i >= 0; i -= 1) {
    if (!/\s/.test(src[i] ?? "")) return i;
  }
  return -1;
}

function precedingKeywordAllowsRegex(src: string, prevIndex: number): boolean {
  let end = prevIndex + 1;
  while (end > 0 && /\s/.test(src[end - 1] ?? "")) {
    end -= 1;
  }
  let start = end;
  while (start > 0 && /[A-Za-z]/.test(src[start - 1] ?? "")) {
    start -= 1;
  }
  const keyword = src.slice(start, end);
  return keyword === "return" || keyword === "case" || keyword === "throw" || keyword === "yield";
}
function keywordBeforeParenAllowsRegex(src: string, closeParenIndex: number): boolean {
  let depth = 1;
  for (let i = closeParenIndex - 1; i >= 0; i -= 1) {
    const ch = src[i] ?? "";
    if (ch === ")") {
      depth += 1;
      continue;
    }
    if (ch === "(") {
      depth -= 1;
      if (!depth) {
        const keywordIndex = previousNonWhitespaceIndex(src, i - 1);
        if (keywordIndex < 0) return false;
        const end = keywordIndex + 1;
        let start = end;
        while (start > 0 && /[A-Za-z]/.test(src[start - 1] ?? "")) {
          start -= 1;
        }
        const keyword = src.slice(start, end);
        return (
          keyword === "if" ||
          keyword === "while" ||
          keyword === "for" ||
          keyword === "switch" ||
          keyword === "catch" ||
          keyword === "with"
        );
      }
    }
  }
  return false;
}

function canStartJsLikeRegex(src: string, slashIndex: number): boolean {
  const prevIndex = previousNonWhitespaceIndex(src, slashIndex - 1);
  if (prevIndex < 0) return true;
  const prev = src[prevIndex] ?? "";
  if ("([{,:;=!?&|^~<>+-*%".includes(prev)) return true;
  if (prev === ")" && keywordBeforeParenAllowsRegex(src, prevIndex)) return true;
  return precedingKeywordAllowsRegex(src, prevIndex);
}

function maskJsLikeRegexLiterals(src: string): string {
  const chars = src.split("");
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] !== "/" || !canStartJsLikeRegex(src, i)) continue;
    let inClass = false;
    let end = i + 1;
    let found = false;
    while (end < src.length) {
      const ch = src[end] ?? "";
      if (ch === "\n" || ch === "\r") break;
      if (ch === "\\") {
        end += 2;
        continue;
      }
      if (ch === "[") {
        inClass = true;
        end += 1;
        continue;
      }
      if (ch === "]" && inClass) {
        inClass = false;
        end += 1;
        continue;
      }
      if (ch === "/" && !inClass) {
        end += 1;
        while (/[A-Za-z]/.test(src[end] ?? "")) {
          end += 1;
        }
        found = true;
        break;
      }
      end += 1;
    }
    if (!found) continue;
    for (let index = i; index < end; index += 1) {
      const ch = chars[index] ?? "";
      if (ch === "\n" || ch === "\r") continue;
      chars[index] = " ";
    }
    i = end - 1;
  }
  return chars.join("");
}

export function maskJsLikeCommentsStringsAndRegex(src: string): string {
  return maskJsLikeRegexLiterals(maskJsLikeCommentsAndStrings(src));
}

export function stripJsonTrailingCommas(src: string): string {
  let out = "";
  let inSingle = false;
  let inDouble = false;
  let escapeNext = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;

    if (inSingle || inDouble) {
      out += ch;
      if (escapeNext) {
        escapeNext = false;
      } else if (ch === "\\") {
        escapeNext = true;
      } else if (inSingle && ch === "'") {
        inSingle = false;
      } else if (inDouble && ch === '"') {
        inDouble = false;
      }
      continue;
    }

    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j]!)) j += 1;
      const next = src[j];
      if (next === "}" || next === "]") {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

export function parseJsonc<T>(raw: string): T {
  return JSON.parse(stripJsonTrailingCommas(stripJsLikeComments(raw))) as T;
}

export function stripPythonCommentsAndStrings(src: string): string {
  let out = src;
  out = out.replace(/([rRuU]?[fF]?)("""|''')[\s\S]*?\2/g, "");
  out = out.replace(/([rRuU]?[fF]?)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g, "");
  out = out.replace(/#.*$/gm, "");
  return out;
}
