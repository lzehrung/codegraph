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
