import type { Range } from "../types.js";
import { collectLineStartOffsets, positionAtOffset } from "../util/lines.js";
import { buildTriviaMask, skipScssEscape } from "../util/trivia.js";

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
  /**
   * True for a module member: a top-level declaration, a `$name: value !global` assignment, or a
   * placeholder at any depth, because Sass extends a placeholder wherever its rule sits.
   */
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
  /** Offset of this load. An eager call only sees loads that precede it. */
  at: number;
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
  /** A lookup-shaped call; only a proven sass:meta binding makes it dynamic. */
  dynamic?: ScssDynamic;
  /**
   * True when the call or include sits in a mixin or function, including a parameter default.
   * Those bodies run later, so a declaration after the call in source may still own it.
   */
  deferred?: true;
};

/**
 * A file-scope flow-control assignment that follows an `@import`. Resolution joins `local` to the
 * imported variable when exactly one import declares the name, and keeps it when none does.
 * The binding is provisional: it does not count as a loop local, so a later assignment of the
 * same name in that flow is recorded too. An `@each` or `@for` variable stays a real local.
 */
export type ScssFlowAssignment = {
  canonical: string;
  range: Range;
  local: ScssLocalBinding;
};

/** A parameter, a loop variable, or a block variable. It hides a module member of the same name. */
export type ScssLocalBinding = {
  canonical: string;
  /** Source spelling; the generic scope walker cannot prove an equivalent differently spelled binding. */
  spelling: string;
  /** First offset where the binding hides a member. */
  from: number;
  /** Offset after the last character of the block that owns the binding. */
  to: number;
  range: Range;
};

export type ScssCallableLocal = {
  kind: "mixin" | "function";
  canonical: string;
  from: number;
  to: number;
};

export type ScssDynamicForm =
  | "load-css"
  | "get-function"
  | "get-mixin"
  | "module-variables"
  | "module-functions"
  | "module-mixins"
  | "variable-exists"
  | "global-variable-exists"
  | "function-exists"
  | "mixin-exists"
  | "call";

export type ScssDynamic = {
  form: ScssDynamicForm;
  /** String argument, or null when the argument is not a literal. */
  arg: string | null;
  /**
   * Bare legacy built-in with no `sass:meta` load: `get-function`, `call`, and the existence predicates.
   * Resolution drops the lookup when a user-defined function of that name, already in scope, is
   * proved to own the call.
   */
  legacyBare?: true;
  /**
   * Offset of the callee. A `get-function` declared later in the file does not own this call.
   * A scoped callable uses it to see whether the lookup sits where that callable is visible.
   */
  at?: number;
};

export type ScssFileFacts = {
  declarations: ScssDeclaration[];
  loads: ScssModuleLoad[];
  uses: ScssUse[];
  locals: ScssLocalBinding[];
  callableLocals: ScssCallableLocal[];
  /**
   * File-scope `@if` / `@each` / `@for` / `@while` assignments that follow an `@import`.
   * Each one may reassign an imported variable instead of introducing a local. A provisional
   * binding does not hide the next assignment. `@use ... as *` is not included: Sass creates a
   * local in that flow block and does not assign the star-loaded variable.
   */
  flowAssignments: ScssFlowAssignment[];
  dynamics: ScssDynamic[];
  /** Interpolated @extend selectors cannot be assigned a static placeholder target. */
  interpolatedExtend: boolean;
  /** An interpolated placeholder declaration has no proven static name. */
  interpolatedPlaceholder: boolean;
  /** Prefix tokens inside an interpolated placeholder; clicks must not use the generic walker. */
  interpolatedPlaceholderRanges: Range[];
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
  "variable-exists",
  "global-variable-exists",
  "function-exists",
  "mixin-exists",
  "call",
]);

/**
 * Global built-ins that name a member by a string. A bare call is one of these unless a user
 * function of that name is already declared. `get-mixin` and the `module-*` lookups are not global.
 */
const LEGACY_BARE_FORMS = new Set<ScssDynamicForm>([
  "get-function",
  "variable-exists",
  "global-variable-exists",
  "function-exists",
  "mixin-exists",
  "call",
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
 * The dynamic lookup that a function or mixin name spells, or null. Sass reads `_` as `-` in such
 * a name, so `get_function` and `get-function` are one function.
 */
function dynamicFormOf(name: string): ScssDynamicForm | null {
  const folded = name.replace(/_/g, "-");
  return isDynamicForm(folded) ? folded : null;
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
  /**
   * `call` is a function or mixin argument list, `params` a parameter list, `selector` is the
   * `selector(...)` argument of an `@supports` head, and `group` is any other parentheses or a
   * square-bracket list.
   */
  mode: "call" | "group" | "params" | "selector";
  /** True at the start of an argument or parameter, before its first token. */
  argStart: boolean;
  /** True for a `[` group, so a later `]` does not pop a parenthesis. */
  bracket?: boolean;
};

type BlockFrame = {
  locals: ScssLocalBinding[];
  callables: ScssCallableLocal[];
  /** True for the block of `@if`, `@else`, `@each`, `@for`, or `@while`. */
  flow: boolean;
  /** True for the body block of a mixin or function. Calls inside it are deferred. */
  callable: boolean;
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
  const callableLocals: ScssCallableLocal[] = [];
  const flowAssignments: ScssFlowAssignment[] = [];
  const dynamics: ScssDynamic[] = [];
  const interpolatedPlaceholderRanges: Range[] = [];
  let interpolatedExtend = false;
  let interpolatedPlaceholder = false;
  const parens: ParenFrame[] = [];
  const braces: boolean[] = [];
  const blocks: BlockFrame[] = [];
  const metaNamespaces = new Set<string>();
  let metaStar = false;
  let pendingLocals: ScssLocalBinding[] = [];
  let statementStart = true;
  let inInclude = false;
  let statementRule = "";
  let nonFlowBlocks = 0;
  const globalVariables = new Set<string>();
  /**
   * How many genuine bindings of each name are in scope: parameters, loop variables, and block
   * variables. A provisional import-flow assignment is not counted, so the next assignment in
   * that flow is not hidden by it.
   */
  const localCounts = new Map<string, number>();
  /** Flow-assignment bindings that must not change {@link localCounts}. */
  const provisionalFlows = new Set<ScssLocalBinding>();
  /** Canonical names of the top-level functions declared so far. A call after one of them is that function. */
  const declaredFunctions = new Set<string>();
  let paramsParenAt = -1;
  let callParenAt = -1;
  /** Offset of `(` after `selector` in an `@supports` head, so the paren is selector context. */
  let selectorParenAt = -1;
  /** Offset where the current statement starts: after the last `;` or block brace. */
  let statementBegin = 0;
  let headCache: { begin: number; styleRule: boolean; interpolated: boolean } | null = null;
  /** Set by {@link opensStyleRule}. The outer scan cannot see the closure write on `headCache`. */
  let selectorHeadInterpolated = false;
  /** True from `@mixin` / `@function` until the body brace opens, so parameter defaults are deferred. */
  let pendingCallable = false;
  /** Nested mixin and function bodies. Calls inside them run when the callable is invoked. */
  let callableDepth = 0;
  /** A loud-comment interpolation is code, but not part of its surrounding statement. */
  let commentMask: Uint8Array | undefined;
  let commentState: {
    statementStart: boolean;
    statementBegin: number;
    statementRule: string;
    inInclude: boolean;
    parens: ParenFrame[];
    headCache: typeof headCache;
  } | null = null;

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
    spelling: source.slice(nameStart, nameEnd),
    from,
    to: -1,
    range: rangeOf(nameStart, nameEnd),
  });

  const addUse = (use: Omit<ScssUse, "canonical" | "hitStart"> & { hitStart?: number }): void => {
    // Sass folds `_` into `-` for variables, mixins, and functions, but compares a placeholder as written.
    const canonical = use.kind === "placeholder" ? use.text : sassCanonical(use.text);
    const recorded: ScssUse = { ...use, canonical, hitStart: use.hitStart ?? use.nameStart };
    if ((use.syntax === "call" || use.syntax === "include") && (callableDepth > 0 || pendingCallable)) {
      recorded.deferred = true;
    }
    if (use.syntax === "call" || use.syntax === "include") {
      const form = dynamicFormOf(use.text);
      if (form) recorded.dynamic = { form, arg: readCallArgument(use.nameEnd), at: use.nameStart };
    }
    uses.push(recorded);
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

  /**
   * The lookup that a call through `sass:meta` names, or null. The name folds `_` into `-`, and the
   * namespace compares as written, so `meta.get_function` is a lookup and `my-meta.get-function` is
   * not when the module is bound to `my_meta`.
   */
  const metaCallForm = (namespace: string | null, member: string): ScssDynamicForm | null => {
    const form = dynamicFormOf(member);
    if (!form) return null;
    const viaMeta = namespace === null ? metaStar : metaNamespaces.has(namespace);
    return viaMeta ? form : null;
  };

  const bindLocal = (frame: BlockFrame, local: ScssLocalBinding, provisional = false): void => {
    frame.locals.push(local);
    locals.push(local);
    if (provisional) {
      provisionalFlows.add(local);
      return;
    }
    localCounts.set(local.canonical, (localCounts.get(local.canonical) ?? 0) + 1);
  };

  const unbindLocal = (local: ScssLocalBinding): void => {
    if (provisionalFlows.delete(local)) return;
    const count = (localCounts.get(local.canonical) ?? 1) - 1;
    if (count > 0) localCounts.set(local.canonical, count);
    else localCounts.delete(local.canonical);
  };

  const openBlock = (braceIndex: number): void => {
    const flow = FLOW_RULES.has(statementRule);
    const callable = pendingCallable;
    if (callable) {
      callableDepth += 1;
      pendingCallable = false;
    }
    const frame: BlockFrame = { locals: [], callables: [], flow, callable };
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
      for (const callable of frame.callables) callable.to = braceIndex;
      if (!frame.flow) nonFlowBlocks -= 1;
      if (frame.callable) callableDepth -= 1;
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
    const enclosing = blocks[blocks.length - 1];
    if (enclosing) {
      const local: ScssCallableLocal = { kind: keyword, canonical: sassCanonical(name.text), from: name.end, to: -1 };
      enclosing.callables.push(local);
      callableLocals.push(local);
    } else {
      declarations.push({
        kind: keyword,
        name: name.text,
        canonical: sassCanonical(name.text),
        range: rangeOf(name.start, name.end),
        topLevel: true,
        isDefault: false,
      });
      if (keyword === "function") declaredFunctions.add(sassCanonical(name.text));
    }
    const paren = skipBlank(name.end);
    if (source.charCodeAt(paren) === 0x28) paramsParenAt = paren;
    pendingCallable = true;
    return name.end;
  };

  const handleInclude = (from: number): number => {
    const member = readMemberAt(from);
    if (!member) return from;
    consume(member.start, member.end);
    const after = skipBlank(member.end);
    if (source.charCodeAt(after) === 0x28) callParenAt = after;
    inInclude = true;
    const dynamicForm = metaCallForm(member.namespace, member.member);
    if (dynamicForm) {
      dynamics.push({ form: dynamicForm, arg: readCallArgument(member.end), at: member.memberStart });
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
    let interpolatedSelector = false;
    while (cursor < length) {
      if (mask[cursor]) {
        cursor += 1;
        continue;
      }
      const unit = source.charCodeAt(cursor);
      if (unit === 0x2c && !interpolation) interpolatedSelector = false;
      if (unit === 0x23 && source.charCodeAt(cursor + 1) === 0x7b) {
        interpolatedExtend = true;
        interpolatedSelector = true;
      }
      if (unit === 0x3b) break;
      if (unit === 0x7b) {
        if (source.charCodeAt(cursor - 1) !== 0x23) break;
        interpolation += 1;
      }
      if (unit === 0x7d) {
        if (!interpolation) break;
        interpolation -= 1;
      }
      if (unit === 0x25 && !interpolation) {
        const ident = readIdent(source, cursor + 1);
        if (ident) {
          const afterName = skipSpaceAndComments(ident.end);
          const interpolatedSuffix = source.charCodeAt(afterName) === 0x23 && source.charCodeAt(afterName + 1) === 0x7b;
          if (interpolatedSelector || interpolatedSuffix) {
            interpolatedPlaceholderRanges.push(rangeOf(cursor, ident.end));
          } else {
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
          }
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
      if (source.charCodeAt(cursor) !== 0x2c) break;
      cursor += 1;
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
      at: from,
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
          at: cursor,
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
      // `$x: $x + 1` changes the loop variable and leaves the file variable alone. A provisional
      // import-flow binding is not such a local, so `$x: 2; $x: 3` records both assignments.
      const boundLocally = localCounts.has(canonical);
      const fileFlow = blocks.length > 0 && nonFlowBlocks === 0 && !boundLocally;
      const reassigns = fileFlow && globalVariables.has(canonical);
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
      } else if (fileFlow && loads.some((load) => load.kind === "import" && !load.nested)) {
        // A file-scope flow block shares the file scope. An earlier @import may already have
        // declared this name; resolution joins every such assignment or keeps the local.
        // `@use ... as *` is not an import. Sass creates a local in the flow block, and that
        // local does not assign or escape to the star-loaded variable.
        const frame = blocks[blocks.length - 1];
        const local = makeLocal(start, end, flags.end);
        flowAssignments.push({ canonical, range: local.range, local });
        if (frame) bindLocal(frame, local, true);
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
   * True inside the head of a style rule: a block follows the head, and the statement is no
   * at-rule, except `@at-root`, which takes a selector. There `:is(` and `:not(` are selectors, not
   * calls, and a `%name` declares a placeholder. A declaration ends at a `;` or at the `}` of its
   * own block. The scan runs once per statement.
   */
  const opensStyleRule = (): boolean => {
    if (headCache?.begin === statementBegin) {
      selectorHeadInterpolated = headCache.interpolated;
      return headCache.styleRule;
    }
    let cursor = skipBlank(statementBegin);
    const isAtRule = source.charCodeAt(cursor) === 0x40;
    const takesSelector = !isAtRule || readIdent(source, cursor + 1)?.text === "at-root";
    let interpolation = 0;
    let block = false;
    let interpolatedHead = false;
    for (; cursor < length; cursor += 1) {
      if (mask[cursor]) continue;
      const unit = source.charCodeAt(cursor);
      if (unit === 0x23 && source.charCodeAt(cursor + 1) === 0x7b) {
        interpolatedHead = true;
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
    selectorHeadInterpolated = interpolatedHead;
    headCache = { begin: statementBegin, styleRule: block && takesSelector, interpolated: interpolatedHead };
    return headCache.styleRule;
  };

  /**
   * True when `:` starts a CSS pseudo, not a Sass call: a style-rule head, or `selector(...)` in
   * an `@supports` head. Interpolation inside either is an expression, so `#{has(1)}` stays a call.
   */
  const inSelectorContext = (): boolean => {
    if (braces.includes(false)) return false;
    if (parens.some((frame) => frame.mode === "selector")) return true;
    return opensStyleRule();
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
      const dynamicForm = isCall && !isVariable ? metaCallForm(member.namespace, member.member) : null;
      if (dynamicForm) {
        dynamics.push({
          form: dynamicForm,
          arg: readCallArgument(member.end),
          at: member.memberStart,
        });
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
    // `@supports selector(...)` takes a selector. The name is CSS, not a Sass function, and so is
    // `:has(` inside it. A call in an at-rule expression, such as `@if has(1)`, stays a call.
    if (statementRule === "supports" && !braces.includes(false) && ident.text.toLowerCase() === "selector") {
      const paren = skipBlank(ident.end);
      if (source.charCodeAt(paren) === 0x28) {
        selectorParenAt = paren;
        return ident.end;
      }
    }
    if (source.charCodeAt(ident.end) === 0x28) {
      const folded = dynamicFormOf(ident.text);
      const legacyForm = folded !== null && LEGACY_BARE_FORMS.has(folded) ? folded : null;
      // A function this file already declared owns the call, even after `@use "sass:meta" as *`.
      // A declaration later in the file does not, so the earlier call stays the built-in.
      const declaredHere = legacyForm !== null && declaredFunctions.has(legacyForm);
      const bareForm = declaredHere ? null : metaCallForm(null, ident.text);
      if (bareForm) {
        dynamics.push({
          form: bareForm,
          arg: readCallArgument(ident.end),
          at: start,
        });
        return ident.end;
      }
      if (legacyForm && !declaredHere) {
        dynamics.push({ form: legacyForm, arg: readCallArgument(ident.end), legacyBare: true, at: start });
        addUse({
          kind: "function",
          syntax: "call",
          namespace: null,
          text: ident.text,
          nameStart: start,
          nameEnd: ident.end,
          loadIndex: null,
        });
        return ident.end;
      }
      // A CSS functional pseudo-class or pseudo-element in a selector (`:is(`, `:not(`, `::part(`)
      // is no Sass function call. `selector(...)` in an `@supports` head is selector context too.
      if (previous === 0x3a && inSelectorContext()) return ident.end;
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
    if (commentState && commentMask && !commentMask[index]) {
      statementStart = commentState.statementStart;
      statementBegin = commentState.statementBegin;
      statementRule = commentState.statementRule;
      inInclude = commentState.inInclude;
      headCache = commentState.headCache;
      parens.length = 0;
      parens.push(...commentState.parens);
      commentState = null;
    }
    if (mask[index] || consumed[index]) {
      // The trivia mask exposes the expression of a loud comment but masks its `#{` and `}`.
      // Save the enclosing declaration and argument state before scanning that expression.
      if (!commentState && mask[index] && source.charCodeAt(index) === 0x23 && source.charCodeAt(index + 1) === 0x7b) {
        commentMask ??= buildTriviaMask(source, SCSS_LANGUAGE_ID, { maskStrings: false });
        if (commentMask[index]) {
          commentState = {
            statementStart,
            statementBegin,
            statementRule,
            inInclude,
            parens: parens.slice(),
            headCache,
          };
          statementStart = false;
          statementRule = "";
          inInclude = false;
          parens.length = 0;
        }
      }
      index += 1;
      continue;
    }
    const unit = source.charCodeAt(index);
    if (isSpaceUnit(unit)) {
      index += 1;
      continue;
    }
    if (unit === 0x5c) {
      touch();
      statementStart = false;
      index = skipScssEscape(source, index);
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
      pendingCallable = false;
      parens.length = 0;
      index += 1;
      continue;
    }
    if (unit === 0x5b) {
      touch();
      parens.push({ mode: "group", argStart: true, bracket: true });
      statementStart = false;
      index += 1;
      continue;
    }
    if (unit === 0x5d) {
      if (parens[parens.length - 1]?.bracket) parens.pop();
      touch();
      statementStart = false;
      index += 1;
      continue;
    }
    if (unit === 0x28) {
      let mode: ParenFrame["mode"] = "group";
      if (paramsParenAt === index) mode = "params";
      else if (selectorParenAt === index) mode = "selector";
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
      // A placeholder in the head of a style rule is a declaration at any depth: Sass extends it
      // wherever its rule sits, in a media query, in another rule, or in a mixin.
      if (placeholder && opensStyleRule()) {
        // `%btn#{$suffix}` and `#{$prefix}%btn` are not the static placeholder `btn`. The name
        // depends on the interpolation, so it stays out of the static group.
        if (selectorHeadInterpolated) {
          interpolatedPlaceholder = true;
          interpolatedPlaceholderRanges.push(rangeOf(index, placeholder.end));
        } else {
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
  for (const callable of callableLocals) {
    if (callable.to < 0) callable.to = length;
  }
  return {
    declarations,
    loads,
    uses,
    locals,
    callableLocals,
    flowAssignments,
    dynamics,
    interpolatedExtend,
    interpolatedPlaceholder,
    interpolatedPlaceholderRanges,
    lineStarts,
  };
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
