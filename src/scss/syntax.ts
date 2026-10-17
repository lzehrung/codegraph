import type { Range } from "../types.js";
import { collectLineStartOffsets, positionAtOffset } from "../util/lines.js";
import { buildTriviaMask } from "../util/trivia.js";

/**
 * SCSS module facts read from source text.
 *
 * The pinned grammar leaves `@use as`, `@forward as`/`show`/`hide`, namespaced access, and
 * `@extend %placeholder` as ERROR nodes or opaque values, so those forms are scanned lexically.
 * Comments, strings, and unquoted `url(...)` content stay masked; `#{...}` interpolation stays
 * visible because it is code. The scan is one linear pass. Nothing here decides which file a URL
 * loads.
 */

export const SCSS_LANGUAGE_ID = "scss";

/** A Sass identifier. Hyphens are significant spelling; a leading `$` marks a variable. */
export const SCSS_IDENTIFIER_PATTERN = /^\$?-?[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF-]*$/u;

export type ScssMemberKind = "variable" | "mixin" | "function" | "placeholder";

/** What a use names. `callable` is a bare name in a `show` or `hide` list: a mixin or a function. */
export type ScssUseKind = ScssMemberKind | "callable";

export type ScssDeclaration = {
  kind: ScssMemberKind;
  /** Spelling in source: `$primary`, `pad`, or `ph` (no `%`). */
  name: string;
  /**
   * Sass identity of the name: `-` and `_` are one character, and the sigil is dropped. A
   * placeholder keeps its exact spelling, so `%a-b` and `%a_b` are two placeholders.
   */
  canonical: string;
  range: Range;
  /** True for a module member: a top-level declaration, or a `$name: value !global` assignment. */
  topLevel: boolean;
  /** Variable declared with `!default`. */
  isDefault: boolean;
};

export type ScssConfiguredName = {
  name: string;
  range: Range;
  /** `variable` when the source spells `$name`; a bare name is a mixin or a function. */
  kind: "variable" | "callable";
};

export type ScssModuleLoad = {
  kind: "use" | "forward" | "import";
  /** URL text inside the quotes, without quotes. */
  url: string;
  /** Bound `@use` namespace, exactly as Sass spells it. Null for `as *`, `@forward`, and `@import`. */
  namespace: string | null;
  /** True for `@use ... as *`. */
  star: boolean;
  /** `@forward ... as prefix-*`: the text before the `*`, such as `prefix-`. */
  prefix: string;
  show: ScssConfiguredName[] | null;
  hide: ScssConfiguredName[] | null;
  /** `@use ... with ($name: ...)` keys. */
  withKeys: ScssConfiguredName[];
  /** An `@import` inside a rule or an at-rule block: Sass declares what it imports in that block only. */
  nested: boolean;
};

export type ScssUseSyntax = "variable" | "call" | "include" | "extend" | "config" | "show" | "hide";

export type ScssUse = {
  kind: ScssUseKind;
  syntax: ScssUseSyntax;
  /** Namespace before the dot, when the use is namespaced. */
  namespace: string | null;
  /** Member token as written (`$primary`, `$theme-primary`, `pad`). */
  text: string;
  /** Sass identity of `text`; a placeholder keeps its exact spelling. */
  canonical: string;
  nameStart: number;
  nameEnd: number;
  /** First offset a click can hit: `nameStart`, or the `%` before a placeholder name. */
  hitStart: number;
  /**
   * Load this name configures (`with`, `show`, `hide`), or null for an ordinary use.
   * The index refers to `loads` on the same file.
   */
  loadIndex: number | null;
};

/** A parameter, a loop variable, or a block variable. It hides a module member of the same name. */
export type ScssLocalBinding = {
  canonical: string;
  /** First offset where the binding hides a member. */
  from: number;
  /** Offset after the last character of the block that owns the binding. */
  to: number;
  range: Range;
};

export type ScssDynamicForm =
  | "load-css"
  | "get-function"
  | "get-mixin"
  | "module-variables"
  | "module-functions"
  | "module-mixins";

export type ScssDynamic = {
  form: ScssDynamicForm;
  /** String argument, or null when the argument is not a literal. */
  arg: string | null;
};

export type ScssFileFacts = {
  declarations: ScssDeclaration[];
  loads: ScssModuleLoad[];
  uses: ScssUse[];
  locals: ScssLocalBinding[];
  dynamics: ScssDynamic[];
  /** Offsets of line starts, for linear offset-to-position conversion. */
  lineStarts: readonly number[];
};

const DYNAMIC_FORMS = new Set<string>([
  "load-css",
  "get-function",
  "get-mixin",
  "module-variables",
  "module-functions",
  "module-mixins",
]);

/** Sass compares identifiers after treating `_` as `-`, and ignores one leading `$` or `%`. */
export function sassCanonical(name: string): string {
  const bare = name.startsWith("$") || name.startsWith("%") ? name.slice(1) : name;
  return bare.replace(/_/g, "-");
}

/** The name without its `$` or `%` sigil. */
export function sassBare(name: string): string {
  return name.startsWith("$") || name.startsWith("%") ? name.slice(1) : name;
}

/**
 * The namespace `@use url` binds without `as`: the last path segment without a leading `_` and
 * without anything from the first `.`. Sass compares namespaces exactly, so the spelling is kept.
 * Null when the segment is empty.
 */
function sassDefaultNamespace(url: string): string | null {
  const clean = (url.split(/[?#]/u)[0] ?? url).replace(/\/+$/u, "");
  let segment = clean.split("/").pop() ?? clean;
  if (segment.includes(":")) segment = segment.split(":").pop() ?? segment;
  if (segment.startsWith("_")) segment = segment.slice(1);
  const dot = segment.indexOf(".");
  if (dot >= 0) segment = segment.slice(0, dot);
  return segment || null;
}

/** Stem used to compare a module URL or a directory with a stylesheet file name. */
export function moduleStem(pathOrUrl: string): string {
  const clean = (pathOrUrl.split(/[?#]/u)[0] ?? pathOrUrl).replace(/[\\/]+$/u, "");
  let segment = clean.split(/[\\/]/u).pop() ?? clean;
  segment = segment.replace(/\.(scss|sass|css)$/iu, "");
  if (segment.includes(":")) segment = segment.split(":").pop() ?? segment;
  segment = segment.replace(/^[~_]+/u, "");
  return sassCanonical(segment);
}

export function isSassBuiltinUrl(url: string): boolean {
  return url.trim().startsWith("sass:");
}

/** Range of `[start, end)` in the file the facts came from. */
export function scssOffsetRange(facts: ScssFileFacts, start: number, end: number): Range {
  return { start: positionAtOffset(facts.lineStarts, start), end: positionAtOffset(facts.lineStarts, end) };
}

/** Offset of a 1-based `line` and `column`, or -1 when the line does not exist. */
export function scssOffsetAt(facts: ScssFileFacts, line: number, column: number): number {
  const lineStart = facts.lineStarts[line - 1];
  return lineStart === undefined ? -1 : lineStart + Math.max(0, column - 1);
}

function isSpaceUnit(unit: number): boolean {
  return unit === 0x20 || unit === 0x09 || unit === 0x0a || unit === 0x0d || unit === 0x0c;
}

function isIdentStart(unit: number): boolean {
  return (unit >= 0x41 && unit <= 0x5a) || (unit >= 0x61 && unit <= 0x7a) || unit === 0x5f || unit >= 0x80;
}

function isIdentPart(unit: number): boolean {
  return isIdentStart(unit) || (unit >= 0x30 && unit <= 0x39) || unit === 0x2d;
}

function readIdent(source: string, index: number): { text: string; end: number } | null {
  let cursor = index;
  while (source.charCodeAt(cursor) === 0x2d) cursor += 1;
  if (!isIdentStart(source.charCodeAt(cursor))) return null;
  cursor += 1;
  while (isIdentPart(source.charCodeAt(cursor))) cursor += 1;
  return { text: source.slice(index, cursor), end: cursor };
}

function readQuoted(source: string, index: number): { text: string; end: number } | null {
  const quote = source[index];
  if (quote !== '"' && quote !== "'") return null;
  let text = "";
  let cursor = index + 1;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "\\") {
      text += source[cursor + 1] ?? "";
      cursor += 2;
      continue;
    }
    if (ch === quote) return { text, end: cursor + 1 };
    text += ch ?? "";
    cursor += 1;
  }
  return { text, end: source.length };
}

function isDynamicForm(name: string): name is ScssDynamicForm {
  return DYNAMIC_FORMS.has(name);
}

/**
 * Sass reads an `@import` as plain CSS, not as a module load, when the URL ends in `.css`, starts
 * with `//`, `http://`, or `https://`, holds an interpolation, or is written as `url(...)`, or when
 * the argument has media queries.
 */
function isPlainCssImportUrl(url: string): boolean {
  if (url.endsWith(".css") || url.includes("#{")) return true;
  return url.startsWith("//") || url.startsWith("http://") || url.startsWith("https://");
}

type ParenFrame = {
  /** `call` is a function or mixin argument list, `params` a parameter list, `group` any other parentheses. */
  mode: "call" | "group" | "params";
  /** True at the start of an argument or parameter, before its first token. */
  argStart: boolean;
};

type BlockFrame = {
  locals: ScssLocalBinding[];
  /** True for the block of `@if`, `@else`, `@each`, `@for`, or `@while`. */
  flow: boolean;
};

/** Blocks of these at-rules share the variable scope that holds them. */
const FLOW_RULES = new Set(["if", "else", "each", "for", "while"]);

type MemberAt = {
  namespace: string | null;
  member: string;
  memberText: string;
  start: number;
  memberStart: number;
  memberEnd: number;
  end: number;
};

export function extractScssFacts(source: string): ScssFileFacts {
  const mask = buildTriviaMask(source, SCSS_LANGUAGE_ID, { holes: true, maskCssUrls: true });
  const lineStarts = collectLineStartOffsets(source);
  const length = source.length;
  const consumed = new Uint8Array(length);
  const declarations: ScssDeclaration[] = [];
  const loads: ScssModuleLoad[] = [];
  const uses: ScssUse[] = [];
  const locals: ScssLocalBinding[] = [];
  const dynamics: ScssDynamic[] = [];
  const parens: ParenFrame[] = [];
  const braces: boolean[] = [];
  const blocks: BlockFrame[] = [];
  const metaNamespaces = new Set<string>(["meta"]);
  let metaStar = false;
  let pendingLocals: ScssLocalBinding[] = [];
  let statementStart = true;
  let inInclude = false;
  let statementRule = "";
  let nonFlowBlocks = 0;
  const globalVariables = new Set<string>();
  /** How many bindings of each name are in scope now: parameters, loop variables, and block variables. */
  const localCounts = new Map<string, number>();
  let paramsParenAt = -1;
  let callParenAt = -1;
  /** Offset where the current statement starts: after the last `;` or block brace. */
  let statementBegin = 0;
  let headCache: { begin: number; atRule: boolean; block: boolean } | null = null;

  const rangeOf = (start: number, end: number): Range => ({
    start: positionAtOffset(lineStarts, start),
    end: positionAtOffset(lineStarts, end),
  });

  const consume = (start: number, end: number): void => {
    for (let cursor = start; cursor < end; cursor += 1) consumed[cursor] = 1;
  };

  const touch = (): void => {
    const top = parens[parens.length - 1];
    if (top) top.argStart = false;
  };

  /** Skips whitespace and masked text. */
  const skipBlank = (from: number): number => {
    let cursor = from;
    while (cursor < length && (mask[cursor] || isSpaceUnit(source.charCodeAt(cursor)))) cursor += 1;
    return cursor;
  };

  /** Skips whitespace and comments, and stops at a quote, so a module URL can be read from the source. */
  const skipSpaceAndComments = (from: number): number => {
    let cursor = from;
    while (cursor < length) {
      const unit = source.charCodeAt(cursor);
      if (isSpaceUnit(unit)) {
        cursor += 1;
        continue;
      }
      if (unit === 0x2f && source.charCodeAt(cursor + 1) === 0x2f) {
        while (cursor < length && source[cursor] !== "\n" && source[cursor] !== "\r") cursor += 1;
        continue;
      }
      if (unit === 0x2f && source.charCodeAt(cursor + 1) === 0x2a) {
        const close = source.indexOf("*/", cursor + 2);
        cursor = close < 0 ? length : close + 2;
        continue;
      }
      break;
    }
    return cursor;
  };

  const makeLocal = (nameStart: number, nameEnd: number, from: number): ScssLocalBinding => ({
    canonical: sassCanonical(source.slice(nameStart + 1, nameEnd)),
    from,
    to: -1,
    range: rangeOf(nameStart, nameEnd),
  });

  const addUse = (use: Omit<ScssUse, "canonical" | "hitStart"> & { hitStart?: number }): void => {
    // Sass folds `_` into `-` for variables, mixins, and functions, but compares a placeholder as written.
    const canonical = use.kind === "placeholder" ? use.text : sassCanonical(use.text);
    uses.push({ ...use, canonical, hitStart: use.hitStart ?? use.nameStart });
  };

  const addVariableUse = (start: number, end: number, namespace: string | null): void => {
    addUse({
      kind: "variable",
      syntax: "variable",
      namespace,
      text: source.slice(start, end),
      nameStart: start,
      nameEnd: end,
      loadIndex: null,
    });
  };

  const readNameAt = (from: number): { text: string; start: number; end: number } | null => {
    const cursor = skipBlank(from);
    const ident = readIdent(source, cursor);
    return ident ? { text: ident.text, start: cursor, end: ident.end } : null;
  };

  /** Reads `name`, `ns.name`, or `ns.$name` starting at `from`. */
  const readMemberAt = (from: number): MemberAt | null => {
    const first = readNameAt(from);
    if (!first) return null;
    const dot = skipBlank(first.end);
    if (source.charCodeAt(dot) !== 0x2e) {
      return {
        namespace: null,
        member: first.text,
        memberText: first.text,
        start: first.start,
        memberStart: first.start,
        memberEnd: first.end,
        end: first.end,
      };
    }
    if (source.charCodeAt(dot + 1) === 0x24) {
      const variable = readIdent(source, dot + 2);
      if (!variable) return null;
      return {
        namespace: first.text,
        member: variable.text,
        memberText: source.slice(dot + 1, variable.end),
        start: first.start,
        memberStart: dot + 1,
        memberEnd: variable.end,
        end: variable.end,
      };
    }
    const member = readIdent(source, dot + 1);
    if (!member) return null;
    return {
      namespace: first.text,
      member: member.text,
      memberText: member.text,
      start: first.start,
      memberStart: dot + 1,
      memberEnd: member.end,
      end: member.end,
    };
  };

  /** The first argument of a call when it is a string literal, read from the source. */
  const readCallArgument = (from: number): string | null => {
    const paren = skipBlank(from);
    if (source.charCodeAt(paren) !== 0x28) return null;
    return readQuoted(source, skipSpaceAndComments(paren + 1))?.text ?? null;
  };

  const isMetaCall = (namespace: string | null, member: string): boolean => {
    if (!isDynamicForm(member)) return false;
    return namespace === null ? metaStar : metaNamespaces.has(namespace);
  };

  const bindLocal = (frame: BlockFrame, local: ScssLocalBinding): void => {
    frame.locals.push(local);
    locals.push(local);
    localCounts.set(local.canonical, (localCounts.get(local.canonical) ?? 0) + 1);
  };

  const unbindLocal = (local: ScssLocalBinding): void => {
    const count = (localCounts.get(local.canonical) ?? 1) - 1;
    if (count > 0) localCounts.set(local.canonical, count);
    else localCounts.delete(local.canonical);
  };

  const openBlock = (braceIndex: number): void => {
    const flow = FLOW_RULES.has(statementRule);
    const frame: BlockFrame = { locals: [], flow };
    if (!flow) nonFlowBlocks += 1;
    for (const local of pendingLocals) {
      if (local.from < 0) local.from = braceIndex;
      bindLocal(frame, local);
    }
    pendingLocals = [];
    braces.push(true);
    blocks.push(frame);
    statementStart = true;
    statementBegin = braceIndex + 1;
    statementRule = "";
    inInclude = false;
    parens.length = 0;
  };

  const closeBlock = (braceIndex: number): void => {
    const frame = blocks.pop();
    if (frame) {
      for (const local of frame.locals) {
        local.to = braceIndex;
        unbindLocal(local);
      }
      if (!frame.flow) nonFlowBlocks -= 1;
    }
    statementStart = true;
    statementBegin = braceIndex + 1;
    statementRule = "";
    inInclude = false;
    parens.length = 0;
  };

  /** Flags and end of the statement whose value starts at `from`: `!default`, `!global`, and its `;`. */
  const statementFlags = (from: number): { isDefault: boolean; isGlobal: boolean; end: number } => {
    let cursor = from;
    let paren = 0;
    let interpolation = 0;
    let isDefault = false;
    let isGlobal = false;
    while (cursor < length) {
      if (!mask[cursor]) {
        const unit = source.charCodeAt(cursor);
        if (unit === 0x28) paren += 1;
        else if (unit === 0x29) paren = Math.max(0, paren - 1);
        else if (unit === 0x7b) {
          if (source.charCodeAt(cursor - 1) === 0x23) interpolation += 1;
          else if (paren === 0) break;
        } else if (unit === 0x7d) {
          if (interpolation > 0) interpolation -= 1;
          else if (paren === 0) break;
        } else if (unit === 0x3b && paren === 0 && interpolation === 0) break;
        else if (unit === 0x21 && paren === 0) {
          const flag = readIdent(source, cursor + 1);
          if (flag?.text === "default") isDefault = true;
          if (flag?.text === "global") isGlobal = true;
          cursor = flag ? flag.end : cursor + 1;
          continue;
        }
      }
      cursor += 1;
    }
    return { isDefault, isGlobal, end: cursor };
  };

  const handleCallable = (keyword: "mixin" | "function", from: number): number => {
    const name = readNameAt(from);
    if (!name) return from;
    consume(name.start, name.end);
    if (!blocks.length) {
      declarations.push({
        kind: keyword,
        name: name.text,
        canonical: sassCanonical(name.text),
        range: rangeOf(name.start, name.end),
        topLevel: true,
        isDefault: false,
      });
    }
    const paren = skipBlank(name.end);
    if (source.charCodeAt(paren) === 0x28) paramsParenAt = paren;
    return name.end;
  };

  const handleInclude = (from: number): number => {
    const member = readMemberAt(from);
    if (!member) return from;
    consume(member.start, member.end);
    const after = skipBlank(member.end);
    if (source.charCodeAt(after) === 0x28) callParenAt = after;
    inInclude = true;
    if (isMetaCall(member.namespace, member.member)) {
      dynamics.push({ form: member.member as ScssDynamicForm, arg: readCallArgument(member.end) });
      return member.end;
    }
    addUse({
      kind: "mixin",
      syntax: "include",
      namespace: member.namespace,
      text: member.memberText,
      nameStart: member.memberStart,
      nameEnd: member.memberEnd,
      loadIndex: null,
    });
    return member.end;
  };

  /** `@extend` lists any number of selectors; each `%placeholder` among them is a use. */
  const handleExtend = (from: number): number => {
    let cursor = from;
    let interpolation = 0;
    while (cursor < length) {
      if (mask[cursor]) {
        cursor += 1;
        continue;
      }
      const unit = source.charCodeAt(cursor);
      if (unit === 0x3b) break;
      if (unit === 0x7b) {
        if (source.charCodeAt(cursor - 1) !== 0x23) break;
        interpolation += 1;
      }
      if (unit === 0x7d) {
        if (!interpolation) break;
        interpolation -= 1;
      }
      if (unit === 0x25) {
        const ident = readIdent(source, cursor + 1);
        if (ident) {
          addUse({
            kind: "placeholder",
            syntax: "extend",
            namespace: null,
            text: ident.text,
            nameStart: cursor + 1,
            nameEnd: ident.end,
            hitStart: cursor,
            loadIndex: null,
          });
          consume(cursor, ident.end);
          cursor = ident.end;
          continue;
        }
      }
      cursor += 1;
    }
    return from;
  };

  /** `@each $a, $b in list {` and `@for $i from 1 through 3 {`: the variables belong to the block. */
  const handleLoopVariables = (from: number, several: boolean): number => {
    let cursor = skipBlank(from);
    while (source.charCodeAt(cursor) === 0x24) {
      const variable = readIdent(source, cursor + 1);
      if (!variable) break;
      pendingLocals.push(makeLocal(cursor, variable.end, -1));
      consume(cursor, variable.end);
      cursor = skipBlank(variable.end);
      if (!several || source.charCodeAt(cursor) !== 0x2c) break;
      cursor = skipBlank(cursor + 1);
    }
    return from;
  };

  const collectWithKeys = (load: ScssModuleLoad, parenIndex: number): void => {
    let cursor = parenIndex + 1;
    let depth = 1;
    while (cursor < length && depth > 0) {
      if (mask[cursor]) {
        cursor += 1;
        continue;
      }
      const unit = source.charCodeAt(cursor);
      if (unit === 0x28) depth += 1;
      if (unit === 0x29) depth -= 1;
      if (depth === 1 && unit === 0x24) {
        const name = readIdent(source, cursor + 1);
        if (name) {
          const colon = skipBlank(name.end);
          if (source.charCodeAt(colon) === 0x3a) {
            load.withKeys.push({
              name: source.slice(cursor, name.end),
              range: rangeOf(cursor, name.end),
              kind: "variable",
            });
            consume(cursor, name.end);
          }
          cursor = name.end;
          continue;
        }
      }
      cursor += 1;
    }
  };

  const readNameList = (from: number): { names: ScssConfiguredName[]; end: number } => {
    const names: ScssConfiguredName[] = [];
    let cursor = from;
    while (cursor < length) {
      cursor = skipSpaceAndComments(cursor);
      const unit = source.charCodeAt(cursor);
      if (unit === 0x3b || unit === 0x7b || cursor >= length) break;
      const word = readIdent(source, cursor);
      if (word && (word.text === "with" || word.text === "as" || word.text === "show" || word.text === "hide")) break;
      if (unit === 0x24) {
        const variable = readIdent(source, cursor + 1);
        if (!variable) break;
        names.push({
          name: source.slice(cursor, variable.end),
          range: rangeOf(cursor, variable.end),
          kind: "variable",
        });
        consume(cursor, variable.end);
        cursor = skipSpaceAndComments(variable.end);
      } else if (word) {
        names.push({ name: word.text, range: rangeOf(cursor, word.end), kind: "callable" });
        consume(cursor, word.end);
        cursor = skipSpaceAndComments(word.end);
      } else {
        break;
      }
      if (source.charCodeAt(cursor) === 0x2c) cursor += 1;
    }
    return { names, end: cursor };
  };

  const recordLoad = (load: ScssModuleLoad): void => {
    const loadIndex = loads.length;
    loads.push(load);
    if (load.kind === "use" && load.url.trim() === "sass:meta") {
      if (load.star) metaStar = true;
      if (load.namespace !== null) metaNamespaces.add(load.namespace);
    }
    for (const key of load.withKeys) {
      addUse({
        kind: "variable",
        syntax: "config",
        namespace: null,
        text: key.name,
        nameStart: key.range.start.index ?? 0,
        nameEnd: key.range.end.index ?? 0,
        loadIndex,
      });
    }
    const lists: Array<[ScssConfiguredName[], "show" | "hide"]> = [
      [load.show ?? [], "show"],
      [load.hide ?? [], "hide"],
    ];
    for (const [names, syntax] of lists) {
      for (const name of names) {
        addUse({
          kind: name.kind,
          syntax,
          namespace: null,
          text: name.name,
          nameStart: name.range.start.index ?? 0,
          nameEnd: name.range.end.index ?? 0,
          loadIndex,
        });
      }
    }
  };

  const handleModuleLoad = (keyword: "use" | "forward", from: number): number => {
    const urlAt = skipSpaceAndComments(from);
    const url = readQuoted(source, urlAt);
    if (!url) return from;
    const load: ScssModuleLoad = {
      kind: keyword,
      url: url.text,
      namespace: keyword === "use" ? sassDefaultNamespace(url.text) : null,
      star: false,
      prefix: "",
      show: null,
      hide: null,
      withKeys: [],
      nested: false,
    };
    let cursor = url.end;
    let stopAt = cursor;
    while (cursor < length) {
      cursor = skipSpaceAndComments(cursor);
      const unit = source.charCodeAt(cursor);
      if (unit === 0x3b || unit === 0x7b || cursor >= length) {
        stopAt = cursor;
        break;
      }
      const word = readIdent(source, cursor);
      if (!word) {
        stopAt = cursor;
        break;
      }
      if (word.text === "as") {
        const aliasAt = skipSpaceAndComments(word.end);
        if (source.charCodeAt(aliasAt) === 0x2a) {
          load.star = true;
          load.namespace = null;
          cursor = aliasAt + 1;
          continue;
        }
        const alias = readIdent(source, aliasAt);
        if (!alias) {
          stopAt = word.end;
          break;
        }
        const afterAlias = skipSpaceAndComments(alias.end);
        if (source.charCodeAt(afterAlias) === 0x2a) {
          load.prefix = alias.text;
          if (keyword === "forward") load.namespace = null;
          cursor = afterAlias + 1;
          continue;
        }
        if (keyword === "use") {
          load.namespace = alias.text;
          load.star = false;
        }
        cursor = alias.end;
        continue;
      }
      if (word.text === "with") {
        const paren = skipSpaceAndComments(word.end);
        if (source.charCodeAt(paren) === 0x28) collectWithKeys(load, paren);
        stopAt = paren;
        break;
      }
      if (word.text === "show" || word.text === "hide") {
        const list = readNameList(word.end);
        if (word.text === "show") load.show = list.names;
        else load.hide = list.names;
        cursor = list.end;
        continue;
      }
      stopAt = cursor;
      break;
    }
    recordLoad(load);
    return Math.max(from + 1, stopAt);
  };

  /** The end of an `@import` argument written as `url(...)`, or -1 when `cursor` does not start one. */
  const urlFunctionEnd = (cursor: number): number => {
    if (source.slice(cursor, cursor + 4).toLowerCase() !== "url(") return -1;
    const inner = skipSpaceAndComments(cursor + 4);
    const quoted = readQuoted(source, inner);
    const close = source.indexOf(")", quoted ? quoted.end : inner);
    return close < 0 ? length : close + 1;
  };

  /**
   * Records the Sass loads of an `@import`. The arguments stay in the main scan, so a variable in a
   * media query or in the interpolation of `url(...)` is a use. A quoted URL is the exception: Sass
   * keeps it as raw text, so `@import "https://x/#{$a}.css"` reads nothing.
   */
  const handleImport = (from: number): number => {
    let cursor = from;
    while (cursor < length) {
      cursor = skipSpaceAndComments(cursor);
      const quoted = readQuoted(source, cursor);
      if (quoted) consume(cursor, quoted.end);
      const functionEnd = quoted ? -1 : urlFunctionEnd(cursor);
      if (!quoted && functionEnd < 0) break;
      const end = quoted ? quoted.end : functionEnd;
      const after = skipSpaceAndComments(end);
      const next = source.charCodeAt(after);
      const hasModifiers = after < length && next !== 0x2c && next !== 0x3b && next !== 0x7d;
      const isPlain = functionEnd >= 0 || hasModifiers || isPlainCssImportUrl(quoted?.text ?? "");
      if (quoted && !isPlain) {
        loads.push({
          kind: "import",
          url: quoted.text,
          namespace: null,
          star: false,
          prefix: "",
          show: null,
          hide: null,
          withKeys: [],
          nested: blocks.length > 0,
        });
      }
      cursor = after;
      if (hasModifiers) {
        while (cursor < length && source.charCodeAt(cursor) !== 0x3b && source.charCodeAt(cursor) !== 0x7b) {
          if (source.charCodeAt(cursor) === 0x2c) {
            const argument = skipSpaceAndComments(cursor + 1);
            if (readQuoted(source, argument) || urlFunctionEnd(argument) >= 0) break;
          }
          cursor += 1;
        }
      }
      if (source.charCodeAt(cursor) !== 0x2c) break;
      cursor += 1;
    }
    return from;
  };

  /** The offset after the `}` that closes the interpolation whose `{` is at `open`, or -1 when it never closes. */
  const interpolationEnd = (open: number): number => {
    let depth = 0;
    for (let cursor = open; cursor < length; cursor += 1) {
      if (mask[cursor]) continue;
      const unit = source.charCodeAt(cursor);
      if (unit === 0x7b) depth += 1;
      if (unit === 0x7d) {
        depth -= 1;
        if (!depth) return cursor + 1;
      }
    }
    return -1;
  };

  /**
   * The offset of the `:` after a custom property name that starts at `start` (`--name`, or a name
   * with an interpolation such as `--#{$prefix}name`), or -1 when the text is no custom property.
   */
  const customPropertyColon = (start: number): number => {
    if (source.charCodeAt(start) !== 0x2d || source.charCodeAt(start + 1) !== 0x2d) return -1;
    let cursor = start + 2;
    while (cursor < length && !mask[cursor]) {
      const unit = source.charCodeAt(cursor);
      if (unit === 0x23 && source.charCodeAt(cursor + 1) === 0x7b) {
        const end = interpolationEnd(cursor + 1);
        if (end < 0) return -1;
        cursor = end;
      } else if (isIdentPart(unit)) {
        cursor += 1;
      } else {
        break;
      }
    }
    const colon = skipBlank(cursor);
    return source.charCodeAt(colon) === 0x3a ? colon : -1;
  };

  /**
   * The value of a custom property (`--name: value`) is literal CSS, and only `#{...}` is code. The
   * text from `from` to the end of the declaration is consumed, so a `$name` or a call in it is no
   * use, and a brace in it opens no block. The declaration ends at a `;` or at the `}` of its
   * block, outside any bracket.
   */
  const skipCustomPropertyValue = (from: number): void => {
    let depth = 0;
    let cursor = from;
    while (cursor < length) {
      if (mask[cursor]) {
        cursor += 1;
        continue;
      }
      const unit = source.charCodeAt(cursor);
      if (unit === 0x23 && source.charCodeAt(cursor + 1) === 0x7b) {
        const end = interpolationEnd(cursor + 1);
        if (end < 0) return;
        cursor = end;
        continue;
      }
      if (!depth && (unit === 0x7d || unit === 0x3b)) return;
      if (unit === 0x28 || unit === 0x5b || unit === 0x7b) depth += 1;
      if (unit === 0x29 || unit === 0x5d || unit === 0x7d) depth = Math.max(0, depth - 1);
      consumed[cursor] = 1;
      cursor += 1;
    }
  };

  const handleAtRule = (keyword: string, from: number): number => {
    if (keyword === "mixin" || keyword === "function") return handleCallable(keyword, from);
    if (keyword === "include") return handleInclude(from);
    if (keyword === "extend") return handleExtend(from);
    if (keyword === "use" || keyword === "forward") return handleModuleLoad(keyword, from);
    if (keyword === "import") return handleImport(from);
    if (keyword === "each") return handleLoopVariables(from, true);
    if (keyword === "for") return handleLoopVariables(from, false);
    return from;
  };

  /**
   * The offset of the `,` or `)` that ends a parameter whose default value starts at `from`. A
   * comma or a parenthesis inside a nested bracket or an interpolation does not end it.
   */
  const parameterEnd = (from: number): number => {
    let depth = 0;
    let interpolation = 0;
    for (let cursor = from; cursor < length; cursor += 1) {
      if (mask[cursor]) continue;
      const unit = source.charCodeAt(cursor);
      if (unit === 0x23 && source.charCodeAt(cursor + 1) === 0x7b) {
        interpolation += 1;
        cursor += 1;
      } else if (interpolation) {
        if (unit === 0x7b) interpolation += 1;
        if (unit === 0x7d) interpolation -= 1;
      } else if (unit === 0x28 || unit === 0x5b) {
        depth += 1;
      } else if (unit === 0x29 || unit === 0x5d) {
        if (!depth) return cursor;
        depth -= 1;
      } else if (unit === 0x2c && !depth) {
        return cursor;
      } else if (unit === 0x3b || unit === 0x7b || unit === 0x7d) {
        return cursor;
      }
    }
    return length;
  };

  /** One `$name` token: a parameter, a declaration, a keyword-argument name, or a use. */
  const handleVariable = (start: number): number => {
    const variable = readIdent(source, start + 1);
    if (!variable) return start + 1;
    const end = variable.end;
    const next = skipBlank(end);
    const isColon = source.charCodeAt(next) === 0x3a && source.charCodeAt(next + 1) !== 0x3a;
    const top = parens[parens.length - 1];
    if (top?.mode === "params" && top.argStart) {
      // A parameter hides a member from the end of its default value to the end of the body. Its own
      // default still reads the member. The default of a later parameter reads the parameter.
      pendingLocals.push(makeLocal(start, end, isColon ? parameterEnd(next + 1) : end));
    } else if (statementStart && isColon) {
      const flags = statementFlags(next);
      const canonical = sassCanonical(variable.text);
      // A flow-control block that holds no rule or mixin shares the scope of the file: assigning
      // a name the file already declared changes that variable instead of hiding it. A loop
      // variable of the same name is the exception: `@each $x in ...` binds `$x` for the block, so
      // `$x: $x + 1` changes the loop variable and leaves the file variable alone.
      const boundLocally = localCounts.has(canonical);
      const reassigns = blocks.length > 0 && nonFlowBlocks === 0 && globalVariables.has(canonical) && !boundLocally;
      if (!blocks.length || flags.isGlobal || reassigns) {
        globalVariables.add(canonical);
        declarations.push({
          kind: "variable",
          name: source.slice(start, end),
          canonical,
          range: rangeOf(start, end),
          topLevel: true,
          isDefault: flags.isDefault,
        });
      } else {
        // The new variable hides a member only after its own statement, so `$x: $x + 1` reads the member.
        const frame = blocks[blocks.length - 1];
        if (frame) bindLocal(frame, makeLocal(start, end, flags.end));
      }
    } else if (!(top?.mode === "call" && top.argStart && isColon)) {
      addVariableUse(start, end, null);
    }
    return end;
  };

  /**
   * What the statement that starts at `statementBegin` is: an at-rule or not, and whether a block
   * follows its head (a style rule) or it ends at a `;` or at the `}` of its own block (a
   * declaration). The scan runs once per statement.
   */
  const statementHead = (): { atRule: boolean; block: boolean } => {
    if (headCache?.begin === statementBegin) return headCache;
    let cursor = skipBlank(statementBegin);
    const atRule = source.charCodeAt(cursor) === 0x40;
    let interpolation = 0;
    let block = false;
    for (; cursor < length; cursor += 1) {
      if (mask[cursor]) continue;
      const unit = source.charCodeAt(cursor);
      if (unit === 0x23 && source.charCodeAt(cursor + 1) === 0x7b) {
        interpolation += 1;
        cursor += 1;
        continue;
      }
      if (interpolation) {
        if (unit === 0x7b) interpolation += 1;
        if (unit === 0x7d) interpolation -= 1;
        continue;
      }
      if (unit === 0x7b) {
        block = true;
        break;
      }
      if (unit === 0x7d || unit === 0x3b) break;
    }
    headCache = { begin: statementBegin, atRule, block };
    return headCache;
  };

  /** True inside the head of a style rule, where `:is(` and `:not(` are selectors, not calls. */
  const opensStyleRule = (): boolean => {
    const head = statementHead();
    return head.block && !head.atRule;
  };

  /** `ns.member` access, a call, or a plain identifier. Returns the offset to continue from. */
  const handleIdentifier = (start: number, ident: { text: string; end: number }): number => {
    if (inInclude && ident.text === "using") {
      const paren = skipBlank(ident.end);
      if (source.charCodeAt(paren) === 0x28) paramsParenAt = paren;
      return ident.end;
    }
    const previous = source.charCodeAt(start - 1);
    if (previous === 0x2e || previous === 0x23) return ident.end;
    const next = skipBlank(ident.end);
    if (source.charCodeAt(next) === 0x2e) {
      const member = readMemberAt(start);
      if (!member || member.namespace === null) return ident.end;
      const isVariable = member.memberText.startsWith("$");
      const isCall = source.charCodeAt(skipBlank(member.end)) === 0x28;
      if (!isVariable && isCall && isMetaCall(member.namespace, member.member)) {
        dynamics.push({ form: member.member as ScssDynamicForm, arg: readCallArgument(member.end) });
      } else if (isVariable) {
        addUse({
          kind: "variable",
          syntax: "variable",
          namespace: member.namespace,
          text: member.memberText,
          nameStart: member.memberStart,
          nameEnd: member.memberEnd,
          loadIndex: null,
        });
      } else if (isCall) {
        addUse({
          kind: "function",
          syntax: "call",
          namespace: member.namespace,
          text: member.memberText,
          nameStart: member.memberStart,
          nameEnd: member.memberEnd,
          loadIndex: null,
        });
      }
      // Any other `ns.name` text is a selector, a unit, or a file name, not a module member.
      return member.end;
    }
    if (source.charCodeAt(ident.end) === 0x28) {
      if (isMetaCall(null, ident.text)) {
        dynamics.push({ form: ident.text as ScssDynamicForm, arg: readCallArgument(ident.end) });
        return ident.end;
      }
      // A CSS functional pseudo-class or pseudo-element in a selector (`:is(`, `:not(`, `::part(`)
      // is no Sass function call.
      if (previous === 0x3a && opensStyleRule()) return ident.end;
      addUse({
        kind: "function",
        syntax: "call",
        namespace: null,
        text: ident.text,
        nameStart: start,
        nameEnd: ident.end,
        loadIndex: null,
      });
    }
    return ident.end;
  };

  let index = 0;
  while (index < length) {
    if (mask[index] || consumed[index]) {
      index += 1;
      continue;
    }
    const unit = source.charCodeAt(index);
    if (isSpaceUnit(unit)) {
      index += 1;
      continue;
    }
    if (unit === 0x7b) {
      if (source.charCodeAt(index - 1) === 0x23) {
        braces.push(false);
        statementStart = false;
        touch();
      } else {
        openBlock(index);
      }
      index += 1;
      continue;
    }
    if (unit === 0x7d) {
      const isBlock = braces.pop();
      if (isBlock === false) {
        statementStart = false;
        touch();
      } else {
        closeBlock(index);
      }
      index += 1;
      continue;
    }
    if (unit === 0x3b) {
      statementStart = true;
      statementBegin = index + 1;
      inInclude = false;
      statementRule = "";
      pendingLocals = [];
      parens.length = 0;
      index += 1;
      continue;
    }
    if (unit === 0x28) {
      let mode: ParenFrame["mode"] = "group";
      if (paramsParenAt === index) mode = "params";
      else if (callParenAt === index || isIdentPart(source.charCodeAt(index - 1))) mode = "call";
      touch();
      parens.push({ mode, argStart: true });
      statementStart = false;
      index += 1;
      continue;
    }
    if (unit === 0x29) {
      parens.pop();
      touch();
      statementStart = false;
      index += 1;
      continue;
    }
    if (unit === 0x2c) {
      const top = parens[parens.length - 1];
      if (top) top.argStart = true;
      statementStart = false;
      index += 1;
      continue;
    }
    if (unit === 0x40) {
      const keyword = readIdent(source, index + 1);
      touch();
      statementStart = false;
      statementRule = keyword?.text ?? "";
      index = keyword ? Math.max(handleAtRule(keyword.text, keyword.end), keyword.end) : index + 1;
      continue;
    }
    if (unit === 0x24) {
      index = handleVariable(index);
      touch();
      statementStart = false;
      continue;
    }
    if (unit === 0x25) {
      const placeholder = readIdent(source, index + 1);
      if (placeholder) {
        const nextUnit = source.charCodeAt(skipBlank(placeholder.end));
        if (!blocks.length && (statementStart || nextUnit === 0x7b || nextUnit === 0x2c)) {
          declarations.push({
            kind: "placeholder",
            name: placeholder.text,
            canonical: placeholder.text,
            range: rangeOf(index + 1, placeholder.end),
            topLevel: true,
            isDefault: false,
          });
        }
      }
      touch();
      statementStart = false;
      index = placeholder ? placeholder.end : index + 1;
      continue;
    }
    if (unit === 0x2d || isIdentStart(unit)) {
      const ident = readIdent(source, index);
      const startsDeclaration = statementStart;
      touch();
      statementStart = false;
      if (startsDeclaration && unit === 0x2d) {
        const colon = customPropertyColon(index);
        if (colon >= 0) skipCustomPropertyValue(colon + 1);
      }
      index = ident ? Math.max(handleIdentifier(index, ident), ident.end) : index + 1;
      continue;
    }
    touch();
    statementStart = false;
    index += 1;
  }

  for (const local of locals) {
    if (local.to < 0) local.to = length;
  }
  return { declarations, loads, uses, locals, dynamics, lineStarts };
}

/**
 * Editable slice of a member token, relative to the token.
 * A forward prefix stays outside the slice when the token starts with it, after the `$` of a
 * variable; `-` and `_` count as one character. Returns null when the prefix does not split off.
 */
export function memberEditSpan(text: string, prefix: string): { start: number; end: number } | null {
  if (!prefix) return { start: 0, end: text.length };
  const sigil = text.startsWith("$") ? 1 : 0;
  const head = text.slice(sigil, sigil + prefix.length);
  if (head.length !== prefix.length || head.replace(/_/g, "-") !== prefix.replace(/_/g, "-")) return null;
  return { start: sigil + prefix.length, end: text.length };
}
