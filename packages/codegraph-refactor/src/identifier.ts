function wordSet(source: string): Set<string> {
  return new Set(source.trim().split(/\s+/));
}

const ecmascriptReservedWords = wordSet(`
  await break case catch class const continue debugger default delete do else enum export extends false finally for
  function if import in instanceof let new null return super switch this throw true try typeof var void while with yield
`);

const typeScriptReservedWords = new Set([
  ...ecmascriptReservedWords,
  ...wordSet(`
    abstract as asserts async boolean constructor declare from get global implements infer interface intrinsic is keyof
    module namespace never number object package private protected public readonly require set static string symbol type
    undefined unique unknown
  `),
]);

const cReservedWords = wordSet(`
  _Alignas _Alignof _Atomic _Bool _Complex _Generic _Imaginary _Noreturn _Static_assert _Thread_local
  auto break case char const continue default do double else enum extern float for goto if inline int long register
  restrict return short signed sizeof static struct switch typedef union unsigned void volatile while
`);

const reservedWords: Record<string, Set<string>> = {
  c: cReservedWords,
  cpp: new Set([
    ...cReservedWords,
    ...wordSet(`
      alignas alignof and and_eq asm bitand bitor bool catch char16_t char32_t char8_t class compl concept const_cast
      consteval constexpr constinit co_await co_return co_yield decltype delete dynamic_cast explicit export false final
      friend import module mutable namespace new noexcept not not_eq nullptr operator or or_eq override private protected
      public reinterpret_cast requires static_assert static_cast template this thread_local throw true try typeid typename
      using virtual wchar_t xor xor_eq
    `),
  ]),
  csharp: wordSet(`
    abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum
    event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace
    new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof
    stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void
    volatile while
  `),
  go: wordSet(`
    break case chan const continue default defer else fallthrough for func go goto if import interface map package range return
    select struct switch type var
  `),
  java: wordSet(`
    abstract assert boolean break byte case catch char class const continue default do double else enum exports extends final
    finally float for goto if implements import instanceof int interface long module native new open opens package private
    protected provides public requires return short static strictfp super switch synchronized this throw throws to transient
    transitive try uses var void volatile while with yield
  `),
  js: ecmascriptReservedWords,
  jsx: ecmascriptReservedWords,
  kotlin: wordSet(`
    as break class continue do else false for fun if in interface is null object package return super this throw true try
    typealias typeof val var when while
  `),
  php: wordSet(`
    __halt_compiler abstract and array as break callable case catch class clone const continue declare default die do echo else
    elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function
    global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private
    protected public readonly require require_once return static switch throw trait try unset use var while xor yield
  `),
  python: wordSet(`
    False None True and as assert async await break class continue def del elif else except finally for from global if import in
    is lambda nonlocal not or pass raise return try while with yield
  `),
  ruby: wordSet(`
    BEGIN END __ENCODING__ __FILE__ __LINE__ alias and begin break case class def defined? do else elsif end ensure false
    for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield
  `),
  rust: wordSet(`
    Self abstract as async await become box break const continue crate do dyn else enum extern false final fn for if impl in let
    loop macro match mod move mut override priv pub ref return self static struct super trait true try type typeof unsafe
    unsized use virtual where while yield
  `),
  swift: wordSet(`
    Any Self Type as associatedtype break case catch class continue default defer deinit do else enum extension fallthrough false
    fileprivate for func guard if import in init inout internal is let nil open operator private protocol public repeat rethrows
    return self static struct subscript super switch throw throws true try typealias var where while
  `),
  ts: typeScriptReservedWords,
  tsx: typeScriptReservedWords,
  zig: wordSet(`
    addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum
    errdefer error export extern false fn for if inline noalias noinline nosuspend null opaque or orelse packed pub resume
    return linksection struct suspend switch test threadlocal true try undefined union unreachable usingnamespace var volatile
    while
  `),
};

export function isValidIdentifier(languageId: string, name: string): { ok: true } | { ok: false; reason: string } {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) {
    return { ok: false, reason: `"${name}" is not a valid ASCII identifier` };
  }
  if (reservedWords[languageId]?.has(name)) {
    return { ok: false, reason: `"${name}" is a reserved word` };
  }
  return { ok: true };
}
