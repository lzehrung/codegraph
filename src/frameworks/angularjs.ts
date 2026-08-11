export type AngularJsRegistrationKind =
  | "component"
  | "constant"
  | "controller"
  | "directive"
  | "factory"
  | "filter"
  | "provider"
  | "service"
  | "value";

export type AngularJsRegistration = {
  kind: AngularJsRegistrationKind;
  name: string;
};

export type AngularJsReference =
  | { kind: "templateUrl"; value: string }
  | { kind: "controller"; value: string }
  | { kind: "inject"; value: string };

type AngularJsTokenKind = "identifier" | "string" | "punctuation";

type AngularJsToken = {
  kind: AngularJsTokenKind;
  value: string;
};

type AngularJsRegistrationMatch = {
  registration: AngularJsRegistration;
  tokenIndex: number;
};

type AngularJsMember = {
  name: string;
  nextIndex: number;
};

type AngularJsChain = {
  nextIndex: number;
  registrations: AngularJsRegistrationMatch[];
};

function isAngularJsIdentifierStart(value: string): boolean {
  const code = value.charCodeAt(0);
  return code === 36 || code === 95 || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAngularJsIdentifierPart(value: string): boolean {
  const code = value.charCodeAt(0);
  return isAngularJsIdentifierStart(value) || (code >= 48 && code <= 57);
}

function canStartAngularJsRegex(tokens: AngularJsToken[]): boolean {
  const previous = tokens[tokens.length - 1];
  if (!previous) return true;
  if (previous.kind === "punctuation") {
    return "([{,;:=!&|?~".includes(previous.value);
  }
  return ["return", "case", "throw", "else", "do", "in", "of"].includes(previous.value);
}

function skipAngularJsRegexLiteral(source: string, start: number): number | undefined {
  let index = start + 1;
  let inCharacterClass = false;
  while (index < source.length) {
    const value = source[index];
    if (value === "\\") {
      index += 2;
      continue;
    }
    if (value === "[") {
      inCharacterClass = true;
      index += 1;
      continue;
    }
    if (value === "]") {
      inCharacterClass = false;
      index += 1;
      continue;
    }
    if (value === "/" && !inCharacterClass) {
      index += 1;
      while (index < source.length && isAngularJsIdentifierPart(source[index] ?? "")) index += 1;
      return index;
    }
    if (value === "\n" || value === "\r") return undefined;
    index += 1;
  }
  return undefined;
}

function tokenizeAngularJsSource(source: string): AngularJsToken[] {
  const tokens: AngularJsToken[] = [];
  let index = 0;
  while (index < source.length) {
    const value = source[index];
    const nextValue = source[index + 1];
    if (value === undefined) break;
    if (/\s/.test(value)) {
      index += 1;
      continue;
    }
    if (value === "/" && nextValue === "/") {
      const newline = source.indexOf("\n", index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (value === "/" && nextValue === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd < 0 ? source.length : commentEnd + 2;
      continue;
    }
    if (value === "/" && canStartAngularJsRegex(tokens)) {
      const regexEnd = skipAngularJsRegexLiteral(source, index);
      if (regexEnd !== undefined) {
        index = regexEnd;
        continue;
      }
    }
    if (value === "'" || value === '"') {
      const quote = value;
      let stringValue = "";
      index += 1;
      while (index < source.length) {
        const stringPart = source[index];
        if (stringPart === undefined) break;
        if (stringPart === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) {
            index += 1;
            break;
          }
          stringValue += escaped;
          index += 2;
          continue;
        }
        if (stringPart === quote) {
          index += 1;
          break;
        }
        stringValue += stringPart;
        index += 1;
      }
      tokens.push({ kind: "string", value: stringValue });
      continue;
    }
    if (value === "`") {
      index += 1;
      while (index < source.length) {
        const templatePart = source[index];
        if (templatePart === undefined) break;
        if (templatePart === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (templatePart === "`") break;
      }
      continue;
    }
    if (isAngularJsIdentifierStart(value)) {
      let end = index + 1;
      while (end < source.length && isAngularJsIdentifierPart(source[end] ?? "")) end += 1;
      tokens.push({ kind: "identifier", value: source.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: "punctuation", value });
    index += 1;
  }
  return tokens;
}

function findAngularJsClosingToken(tokens: AngularJsToken[], start: number): number | undefined {
  const opening = tokens[start]?.value;
  const closingByOpening: Record<string, string> = {
    "(": ")",
    "[": "]",
    "{": "}",
  };
  const firstClosing = opening ? closingByOpening[opening] : undefined;
  if (!firstClosing) return undefined;
  const expectedClosings = [firstClosing];
  for (let index = start + 1; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === "(" || value === "[" || value === "{") {
      const closing = closingByOpening[value];
      if (closing) expectedClosings.push(closing);
      continue;
    }
    if (value !== expectedClosings[expectedClosings.length - 1]) continue;
    expectedClosings.pop();
    if (!expectedClosings.length) return index;
  }
  return undefined;
}

function parseAngularJsModuleStart(tokens: AngularJsToken[], start: number): number | undefined {
  const angularToken = tokens[start];
  const previous = tokens[start - 1]?.value;
  if (
    angularToken?.kind !== "identifier" ||
    angularToken.value !== "angular" ||
    previous === "." ||
    previous === "]"
  ) {
    return undefined;
  }

  let openIndex: number | undefined;
  const dotModule = tokens[start + 1]?.value === "." && tokens[start + 2]?.value === "module";
  if (dotModule && tokens[start + 3]?.value === "(") {
    openIndex = start + 3;
  } else {
    const bracketModule =
      tokens[start + 1]?.value === "[" &&
      tokens[start + 2]?.kind === "string" &&
      tokens[start + 2]?.value === "module" &&
      tokens[start + 3]?.value === "]" &&
      tokens[start + 4]?.value === "(";
    if (bracketModule) openIndex = start + 4;
  }
  if (openIndex === undefined) return undefined;
  const closeIndex = findAngularJsClosingToken(tokens, openIndex);
  return closeIndex === undefined ? undefined : closeIndex + 1;
}

function parseAngularJsMember(tokens: AngularJsToken[], start: number): AngularJsMember | undefined {
  const directMember = tokens[start]?.value === "." && tokens[start + 1]?.kind === "identifier";
  if (directMember) {
    return { name: tokens[start + 1]?.value ?? "", nextIndex: start + 2 };
  }
  const optionalMember =
    tokens[start]?.value === "?" &&
    tokens[start + 1]?.value === "." &&
    tokens[start + 2]?.kind === "identifier";
  if (optionalMember) {
    return { name: tokens[start + 2]?.value ?? "", nextIndex: start + 3 };
  }
  const bracketMember =
    tokens[start]?.value === "[" &&
    tokens[start + 1]?.kind === "string" &&
    tokens[start + 2]?.value === "]";
  if (bracketMember) {
    return { name: tokens[start + 1]?.value ?? "", nextIndex: start + 3 };
  }
  return undefined;
}

function parseAngularJsPostfixChain(tokens: AngularJsToken[], initialEnd: number): AngularJsChain {
  const registrations: AngularJsRegistrationMatch[] = [];
  let nextIndex = initialEnd;
  while (nextIndex < tokens.length) {
    const member = parseAngularJsMember(tokens, nextIndex);
    if (!member || tokens[member.nextIndex]?.value !== "(") break;
    const closeIndex = findAngularJsClosingToken(tokens, member.nextIndex);
    if (closeIndex === undefined) break;
    const kind = parseRegistrationKind(member.name);
    const firstArgument = tokens[member.nextIndex + 1];
    if (kind && firstArgument?.kind === "string" && firstArgument.value.trim()) {
      registrations.push({
        registration: { kind, name: firstArgument.value.trim() },
        tokenIndex: member.nextIndex,
      });
    }
    nextIndex = closeIndex + 1;
  }
  return { nextIndex, registrations };
}

function isAngularJsAssignmentBoundary(tokens: AngularJsToken[], index: number): boolean {
  const next = tokens[index];
  if (!next) return true;
  if (next.kind === "identifier") return true;
  return ";,)]}".includes(next.value);
}

function findAngularJsAssignedVariable(
  tokens: AngularJsToken[],
  start: number,
  end: number,
): string | undefined {
  if (!isAngularJsAssignmentBoundary(tokens, end) || tokens[start - 1]?.value !== "=") return undefined;
  const candidate = tokens[start - 2];
  if (candidate?.kind !== "identifier") return undefined;
  const previous = tokens[start - 3]?.value;
  if (previous === "." || previous === "]") return undefined;
  return candidate.value;
}

function isAngularJsVariableRoot(tokens: AngularJsToken[], start: number): boolean {
  const previous = tokens[start - 1]?.value;
  return previous !== "." && previous !== "]";
}

function collectAngularJsRegistrationMatches(source: string): AngularJsRegistrationMatch[] {
  const tokens = tokenizeAngularJsSource(source);
  const moduleVariables = new Set<string>();
  const matches: AngularJsRegistrationMatch[] = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const moduleEnd = parseAngularJsModuleStart(tokens, index);
      if (moduleEnd !== undefined) {
        const chain = parseAngularJsPostfixChain(tokens, moduleEnd);
        matches.push(...chain.registrations);
        const assignedVariable = findAngularJsAssignedVariable(tokens, index, chain.nextIndex);
        if (assignedVariable && !moduleVariables.has(assignedVariable)) {
          moduleVariables.add(assignedVariable);
          changed = true;
        }
        continue;
      }

      const token = tokens[index];
      if (
        token?.kind !== "identifier" ||
        !moduleVariables.has(token.value) ||
        !isAngularJsVariableRoot(tokens, index)
      ) {
        continue;
      }
      const chain = parseAngularJsPostfixChain(tokens, index + 1);
      matches.push(...chain.registrations);
      const assignedVariable = findAngularJsAssignedVariable(tokens, index, chain.nextIndex);
      if (assignedVariable && !moduleVariables.has(assignedVariable)) {
        moduleVariables.add(assignedVariable);
        changed = true;
      }
    }
  }
  return matches;
}

const ANGULAR_JS_ARRAY_INJECTION_PATTERN =
  /\.\s*(controller|service|factory|directive|component|provider|filter)\s*\(\s*(['"])([^'"`]+)\2\s*,\s*\[([\s\S]*?)function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/gs;

const ANGULAR_JS_FUNCTION_INJECTION_PATTERN =
  /\.\s*(controller|service|factory|directive|component|provider|filter)\s*\(\s*(['"])([^'"`]+)\2\s*,\s*function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/gs;

const ANGULAR_JS_COMPONENT_CONTROLLER_PATTERN =
  /\.\s*component\s*\(\s*(['"])([^'"`]+)\1\s*,\s*\{[\s\S]*?controller\s*:\s*function(?:\s+[A-Za-z_$][\w$]*)?\s*\(([^)]*)\)/gs;

const ANGULAR_JS_INJECT_ASSIGNMENT_PATTERN = /([A-Za-z_$][\w$]*)\s*\.\s*\$inject\s*=\s*\[([\s\S]*?)\]/gs;

const ANGULAR_JS_TEMPLATE_URL_PATTERN = /templateUrl\s*:\s*(['"`])([^'"`]+)\1/gs;

const ANGULAR_JS_CONTROLLER_REF_PATTERN = /controller\s*:\s*(['"])([^'"`]+)\1/gs;

function looksLikeAngularJsSource(source: string): boolean {
  // `angular.module(` (common) or `angular["module"](`/`angular['module'](` (bracket access,
  // e.g. from minified or lint-avoidance code) both register/retrieve an Angular module.
  return /angular\s*(?:\.\s*module|\[\s*(['"])module\1\s*\])\s*\(/.test(source);
}

function parseRegistrationKind(value: string): AngularJsRegistrationKind | undefined {
  if (value === "component") return "component";
  if (value === "constant") return "constant";
  if (value === "controller") return "controller";
  if (value === "directive") return "directive";
  if (value === "factory") return "factory";
  if (value === "filter") return "filter";
  if (value === "provider") return "provider";
  if (value === "service") return "service";
  if (value === "value") return "value";
  return undefined;
}

function parseQuotedValues(value: string): string[] {
  const out: string[] = [];
  const quotedValuePattern = /(['"])([^'"`]+)\1/g;
  for (const match of value.matchAll(quotedValuePattern)) {
    const token = match[2]?.trim();
    if (token) out.push(token);
  }
  return out;
}

function parseParameterNames(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/^\.{3}/, ""))
    .map((entry) => entry.replace(/\s*=.*$/, ""))
    .map((entry) => entry.replace(/[\{\}\[\]]/g, "").trim())
    .filter(Boolean);
}

function pushUnique(target: string[], seen: Set<string>, value: string): void {
  if (seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

export function extractAngularJsRegistrations(source: string): AngularJsRegistration[] {
  if (!looksLikeAngularJsSource(source)) return [];

  const out: AngularJsRegistration[] = [];
  const seen = new Set<string>();
  const matches = collectAngularJsRegistrationMatches(source).sort(
    (left, right) => left.tokenIndex - right.tokenIndex,
  );
  for (const match of matches) {
    const { kind, name } = match.registration;
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match.registration);
  }
  return out;
}

export function extractAngularJsReferences(source: string): AngularJsReference[] {
  if (!looksLikeAngularJsSource(source)) return [];

  const out: AngularJsReference[] = [];
  const seen = new Set<string>();

  for (const match of source.matchAll(ANGULAR_JS_TEMPLATE_URL_PATTERN)) {
    const value = match[2]?.trim();
    if (!value) continue;
    const key = `templateUrl:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "templateUrl", value });
  }

  for (const match of source.matchAll(ANGULAR_JS_CONTROLLER_REF_PATTERN)) {
    const value = match[2]?.trim();
    if (!value) continue;
    const key = `controller:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "controller", value });
  }

  const injectionTokens: string[] = [];
  const injectionSeen = new Set<string>();
  for (const match of source.matchAll(ANGULAR_JS_ARRAY_INJECTION_PATTERN)) {
    for (const value of parseQuotedValues(match[4] ?? "")) {
      pushUnique(injectionTokens, injectionSeen, value);
    }
  }
  for (const match of source.matchAll(ANGULAR_JS_FUNCTION_INJECTION_PATTERN)) {
    for (const value of parseParameterNames(match[4] ?? "")) {
      pushUnique(injectionTokens, injectionSeen, value);
    }
  }
  for (const match of source.matchAll(ANGULAR_JS_COMPONENT_CONTROLLER_PATTERN)) {
    for (const value of parseParameterNames(match[3] ?? "")) {
      pushUnique(injectionTokens, injectionSeen, value);
    }
  }
  for (const match of source.matchAll(ANGULAR_JS_INJECT_ASSIGNMENT_PATTERN)) {
    for (const value of parseQuotedValues(match[2] ?? "")) {
      pushUnique(injectionTokens, injectionSeen, value);
    }
  }

  for (const value of injectionTokens) {
    const key = `inject:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: "inject", value });
  }

  return out;
}
