# Language coverage parity matrix

Parity means each listed language gives correct results for ordinary code, from syntax and facts proven in source; codegraph is not a compiler.
For rare forms, or anything needing expression type inference, overload ranking beyond arity, generic constraint solving, or build-system membership, it returns `not_found` or `partial` coverage instead of guessing.
This is the [Semantic Accuracy Bar](../AGENTS.md#semantic-accuracy-bar): a miss is acceptable, a confident wrong answer is not.

Status key: Yes = supported and covered; Partial = supported with intentional limitations; No = not supported for that capability.

| Language         | Dependency graph | Symbol extraction | Go-to-definition | Find references | Chunking | SFC integration | PR impact mapping | Call compatibility | Native addon | Native parity tests |
| ---------------- | ---------------- | ----------------- | ---------------- | --------------- | -------- | --------------- | ----------------- | ------------------ | ------------ | ------------------- |
| TypeScript       | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| TSX              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| JavaScript       | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Python           | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| PHP              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Go               | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Java             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| C                | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| C++              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| C#               | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Kotlin           | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Ruby             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Rust             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Swift            | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| Zig              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | Yes                | Yes          | Yes                 |
| HTML             | Yes              | No                | No               | No              | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| Astro            | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| Handlebars       | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| CSS              | Yes              | No                | No               | No              | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| SCSS             | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| Less             | Yes              | No                | No               | No              | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| Markdown         | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| MDX              | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| reStructuredText | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| AsciiDoc         | Yes              | No                | No               | No              | No       | No              | Yes               | No                 | No           | No                  |
| Vue              | Yes              | No                | No               | No              | Yes      | Yes             | Yes               | No                 | Partial      | Yes                 |
| Svelte           | Yes              | No                | No               | No              | Yes      | Yes             | Yes               | No                 | Partial      | Yes                 |
| SQL              | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | No                 | Yes          | Yes                 |
| Terraform        | Yes              | Yes               | Yes              | Yes             | Yes      | No              | Yes               | No                 | Yes          | Yes                 |

The matrix states supported capability classes, not measured accuracy.
See the generated [fixture test matrix](./benchmarks/fixture-snapshot.md) for per-language test status and the [call-form coverage matrix](./coverage/call-forms.md) for go-to-definition, references, and call-graph agreement per call form.

- Source languages are the 15 rows from TypeScript through Zig.
- Native parity tests cover extraction and end-to-end semantics for source languages, SQL, and Terraform.
- HTML, CSS, Less, Vue, and Svelte get graph and specifier parity; SCSS adds symbols, same-file navigation, and references.
- Intentional `not_found` results: navigation in HTML, CSS, Less, Vue, Svelte, and document formats.

## All languages

### Parsing and formats

- The native addon is required; if it cannot load, codegraph errors, with no second parser or regex fallback.
- Files over the native size limit are skipped (`sourceTooLarge`); query failures report `queryFailure`; an empty result is final.

### Symbols and exports

- `exports` is module scope: names inside a function, lambda, or closure, and a local type's members, are never importable.
- Type members export only where the language's exports query captures them: PHP omits methods, Zig a container's member functions.
- A visibility-hidden declaration stays file-local and never binds through another file's import; languages without visibility rules export every top-level declaration.
- Hidden from other files: Java `private`; Kotlin `private`/`internal`; Swift `private`/`fileprivate`; C# `private`, and `internal` at namespace or file scope; Rust items without `pub`, and `pub(self)`.
- Unused-export detection is not available.
- `getUndocumentedApiSurface` and `apisurface --undocumented` check docstrings only for TypeScript, TSX, JavaScript, Go, Java, C#, Kotlin, Rust, Zig, and SCSS.
- Unchecked: Python (no triple-quoted docstrings), PHP, C, C++, Ruby, Swift, SQL, Terraform, skipped files; they appear in partial `coverage.uncheckedFiles`.

### Navigation and references

#### Lookup

- C# and Java: a same-signature override hides ancestors before arity is checked; the graph adds no edge to them.
- Unqualified names in a type body reach its own members only in Java, C#, Kotlin, Swift, Ruby, and C++.
- Generic alias targets (`using X = N.Box<int>`, `typealias X = Y<Int>`, `type X = Y<string>`) give `not_found` for member navigation; C# also fails on the alias name.
- Type-qualified calls such as `Util.Two(1, 2)` pick a static overload by argument count in Java and C#; a method group or an ambiguous count stays unresolved.
- `refs` reports named and default import tokens, not namespace or side-effect imports.
- A use before a later declaration in the same scope is a reference only where the language makes it visible: functions, classes, methods, Python function-local assignment, JavaScript `let`/`const`.

#### Receivers

- Receiver navigation (`obj.method()`) works in every source language except C; the others are `limitedLanguages` in `diagnostics.memberResolutionCoverage` and may miss receiver-only consumers in impact.
- `super`, `base`, `parent` walk class ancestors breadth-first and return only a unique shallowest match; interfaces beside the superclass are skipped.
- TypeScript, TSX, Java, C#, and Kotlin follow explicitly typed field chains (`this.middle.repo.find()`); unannotated or ambiguous hops stay unresolved.
- A member call on a local, parameter, field, or `this`/`self` never uses a free function, except in Kotlin and Go.

#### Same-package peers

- Bare names reach same-unit peers: same directory and package (Go, Java, Kotlin), compatible namespaces (C#), same directory (Swift).
- C# partial types and Swift extensions share members only with a matching full owner identity.
- Maven/Gradle source sets, `.csproj` items, and SwiftPM targets are not read: same-package JVM files outside the directory, and C# or Swift files elsewhere, give `partial` (`strategy_unavailable`).
- A package-less JVM file is complete only if no other indexed JVM file can join it and all were readable.
- C# partial-type and Swift extension members follow the same rule.
- A Java or Kotlin file that was not read in full is `incomplete`: it has no usable syntax tree (over the native source limit) or a syntax error reaches the top of its tree. It keeps its package and the names read before the error, and may declare others. A file that cannot be parsed at all, not even its head, has no known package and may declare any name in any package.
- A named import from that package stays unresolved while an incomplete file may declare the name, and the importer is marked `parserDegraded`. Every import form asks this of the name it looks up: the type, the owner of a static member, or the type of a wildcard that names no package; its dependency edge asks the same. An incomplete Kotlin file may declare any class, function, or typealias. An incomplete Java file may declare a public type only in the file its name spells, but a package-private type under any name, which only an importer of the same package can name. A Java import of a type that another file proves still binds, but a Kotlin import is not proven by a class alone, because a function or typealias can share its name. A wildcard import of a package still includes the file, and its importer is marked the same way, because the wildcard names every file of the package: an incomplete file may declare names it binds, and a file whose package could not be read may belong to the package.

#### Collisions and coverage

- Star imports exposing one name: Python's last wins; Java, Kotlin, and Rust prefer an explicit import; any other overlap is ambiguous (`goToDefinition` `not_found`, references `partial`).
- Java and Kotlin order: explicit import, same-package class, wildcard; inside a class, an inherited non-private method beats all three and same-file top-level functions.
- Java, Kotlin, and C# choose overloads across the whole class hierarchy; two survivors or an unknown-length spread are ambiguous.
- Private base methods are not inherited, and a static context has no target.
- A same-name use with several candidates or an unproven receiver makes coverage `partial`; an unbound name does not.
- A classified receiver (`new Widget()`, a type name, `this`) excludes a use only when its type and every supertype resolve.

### Calls and call compatibility

- A receiver call is never matched by bare member name against module locals or import aliases.
- An unproven receiver emits no edge: structural types, non-constructor assignments (`auto b = Box::make()`), generic type parameters, unbound globals (`Math.max()`).
- Several same-name members on one type are dropped unless argument count picks one; an ambiguous inheritance level emits nothing.
- Go-to-definition and the detailed graph agree on call sites, except module top-level calls and computed or parenthesized callees (`(a ?? b)()`, `(f)()`).
- A callback resolving to a parameter or local may have no edge; a literal-valued binding never gets one.
- A call the only candidate cannot accept by argument count still navigates to it; the graph records no edge.
- Call hierarchy follows only resolved `calls` edges between indexed callables; ambiguous or unproven bindings emit no edge.
- Not claimed: overload, virtual, trait, or interface dispatch, function pointers, macros, reflection, dynamic sends, name-only guesses; `includeHeuristic` adds no edges.
- Call-compatibility hints compare changed arity with resolved callsites (`callCompatibility`); they are not type checking, overload resolution, dispatch, macro expansion, or data-flow inference.
- Same-file overload sets are skipped; member callsites count only through proven receivers; unknown spread lengths give no hint.

### Imports and dependency edges

- Java, Kotlin, C#, PHP, and Python symbol indexes start at the nearest language manifest, so same-named sibling-workspace packages do not bind.
- A directory is a file edge only where the runtime treats it as a module (Python packages, PEP 420 namespace directories, Go packages).
- Opt-in dynamic import heuristics (`graph.dynamicImportHeuristics`, `--dynamic-import-heuristics`) fold only static paths (`path.join`, `importlib.import_module`, `require File.join(__dir__, ...)`, `__DIR__`-rooted PHP includes); computed names are not inferred.

### Type hierarchy, rename, and duplicates

- Type hierarchy covers TypeScript, JavaScript, Java, C#, Rust, Swift, C++, Python, Kotlin, PHP, Ruby, and Go (`extends`, `implements`, `impl Trait for Type`, embedding, traits, mixins).
- Only the direct base is a hierarchy edge: type arguments (`Base<Payload>`) and qualifiers (`Ns.Base`, `Ns::Base`) are never read as bases.
- Edges need both declarations indexed; external bases, structural typing, metaprogrammed mixins, protocol extensions, and name-only member matches are not inferred.
- `implementations` covers interface or trait members and declared abstract or virtual overrides with proven implementers; ambiguous overloads are rejected.
- Rename preview and refactor plans are not compiler-grade: `rename.safe` stays false for unsupported dispatch, unresolved external symbols, ambiguous scopes, stale evidence, conflicts, and omissions.
- TypeScript and JavaScript rename is unsafe when an explicit export alias (`export { x as x }`) is reachable from a namespace member use, including through `export *`, `export * as ns`, and named re-exports of a namespace.
- Duplicate detection compares same-language units and masks import declarations first.
- Dynamic Ruby load paths, other Zig builtins, HTML dependencies, SQL object references, and Rust inline module bodies are not masked.

### Identifiers and file extensions

- Extra extensions: `.pyw` (Python), `.rbw`/`.rake`/`.gemspec` (Ruby), `.ktm` (Kotlin), `.csx` (C#), `.phtml`/`.php4`/`.php8` (PHP), `.xhtml` (HTML), `.ddl`/`.pgsql`/`.mysql` (SQL).
- Identifier equality: Python NFKC, Rust NFC, Java and C# ignore formatting characters; Kotlin, Go, and JS/TS compare code points, so differently spelled forms stay distinct.
- Explicit links and includes resolve to aliases (`href="page.xhtml"`, `include 'partial.phtml'`); extensionless imports do not (`import util` is not `util.pyw`).
- Unsupported, with no grammar pinned: `.sass`, Objective-C, Stylus (`.styl`), Go templates (`.templ`), Zig manifests (`.zon`).

## TypeScript, TSX, and JavaScript

- Class fields, declaration-only overloads, and named `namespace`/`module` declarations are indexed; `declare module "ambient"` is a chunk, not a named export.
- `package.json#exports` follows Node; custom `--conditions`, `browser`, `types`, `deno`, `worker`, import attributes, and `#imports` are not modeled.
- `module.exports = { ...source }` expands static imports and local literals; unresolved spreads stay namespace-reexport markers; `obj.prop = localVar` is not an export.
- The AngularJS heuristic needs `angular.module(...)` registration; generic `controller` or `templateUrl` objects do not count.
- `refs` marks named re-exports `via.reexport: true` (non-executable); star and namespace re-exports have no source-symbol token.
- A call through a nested namespace chain (`A.B.f()`) resolves in neither go-to-definition nor the graph.

## Python

- A package import resolves to `__init__.py`/`__init__.pyi`, else a PEP 420 namespace directory with importable members; an empty directory stays unresolved.
- `if TYPE_CHECKING:` and `if typing.TYPE_CHECKING:` imports are type-only; `if not TYPE_CHECKING:`, its `else`, and other guards stay runtime.
- Conditional and function-suite imports are not module re-exports; an unresolved relative import keeps its written specifier (`.missing`).
- Qualified value patterns in `match` are not captures.
- `self`/`cls` members resolve, including `__init__` attributes and `svc = Service()` locals; factory-assigned and unannotated receivers stay unproven.
- A `self.x` or instance receiver reaches a property (`@property`, `property(...)`, or a replacing `@x.getter`/`@x.setter`) of its class or a base class before an instance attribute set by `self.x = value`. The last class-level binding of the name decides: `property(...)`, `@property`, and `@x.getter` each make a new property and are its target, `@x.setter` and `@x.deleter` keep the earlier one as the target, and any other binding, such as a later `x = 0`, replaces it. An annotation without a value (`x: int`) binds nothing, so it hides no base property; a plain class attribute found first does. With several bases the method resolution order is not rebuilt: the property is the one of the class that every other class binding `x` derives from, at whatever level it sits, and `self.x` stays unresolved when the nearest bindings disagree (a plain attribute in one base, a property in an unrelated one) or when unrelated bases each bind a property. References to a property accessor are `partial`.

## PHP

- Namespace names and ordinary variable uses are not symbols; a function declared inside another function is file-local.
- Class, function, and method names match ASCII-case-insensitively; variables, properties, enum cases, and constants are case-sensitive.
- Composer PSR-0, PSR-4, classmap, and `autoload.files` drive first-party resolution; autoload machinery is never a dependency edge.

## Go

- Blank range identifiers and type names such as `int` are not indexed.
- Cross-package access resolves only exported (capitalized) names, via `pkg.Name` or an imported-type receiver (`v := pkg.T{}; v.Method()`).
- A receiver from `GoBox{}`, `&GoBox{}`, or `var b GoBox` resolves; interface-typed and factory-assigned receivers emit no edge.

## Java

- `record` is a class-kind symbol with positional components as variable locals, not fields; renaming a constructor is a definition change.
- A package-private member called from another package (a compile error) is not rejected.
- A top-level type without `public` is visible only in its own package.
- Wildcard imports bind only top-level package types, never Kotlin functions, class methods, enum constants, or nested types.

## C

- C has no methods on types, so a struct function-pointer call emits no receiver edge. It is the one source language outside `receiverAwareLanguages`.
- Struct, union, and enum tags are a separate namespace from typedefs and ordinary names; a block-scope forward tag can hide an outer tag.
- A `.h` header parses as C unless it holds a C++ signal (see C++).

## C++

- Exports use qualified names (`tools::run`); namespace-level `using` and inline namespaces add aliases, function-local `using` does not.
- A bare name that is not visible gives no result, reference, or edge.
- Typedefs through pointer, array, and function declarators are indexed; pointer-to-member typedefs and macro-expanded typedef uses are not.
- Declarations inside include guards, namespaces, and templates are exported; `static` and function-body declarations are not.
- A `.h` file parses as C++ when its first 8000 characters hold a C++ signal, else as C.
- Signals: keyword `class`, `namespace`, `template`, `typename`, `constexpr`, `operator` (an identifier such as `int class;` does not count), `using namespace`, `using X = Y`, `concept`, `co_await`, `::`, `import`.
- `export module foo;` is a class-kind symbol; a first-party `import foo;` resolves like `#include`; `import std;` stays external; a module declared twice is unresolved.
- Module partitions are unsupported: `import :part;` and `import foo:part;` emit no import edge.
- Header units resolve like the matching `#include`; a module name ending in a source extension is read as a file path.
- A prototype and definition with one signature are one callable.
- Arity picks a candidate only when exactly one exact, default, or variadic candidate fits; overlapping candidates stay unresolved.
- Parameter matching treats arrays and function types as pointers and drops top-level `const`/`volatile`; pointee qualifiers and references stay significant; opaque named types and unmodeled declarators stay as written.
- Impact hints warn on arity mismatches that navigation omits; shadowed names and ambiguous overloads are excluded.
- Qualified bases (`ns::Base`) resolve by full path; a missing one never falls back to an unqualified class.

## C#

- Symbols: `struct`, `delegate`, fields, events, properties, `record` types (class kind); not constructors, destructors, operators, conversion operators, indexers.
- A C# 11 `file` type stays in its file.
- Extension methods resolve through their static class (`Ext.M(value)`); `value.M()` needs type inference and is unresolved.
- `using N;` imports types of `N` from every file of the importer's project, not nested namespaces.
- `N.Type` resolves from the use file's directory plus directories declaring `N`.
- `using N.T` binds the one file declaring `T`; ambiguous or unreadable sets stay unresolved.
- A dotted type name (`N.T`) never binds a path-like file (`N/T.cs`) once a project file declares namespace `N`: a type the lookup does not find, such as the generic `T<U>`, stays external.
- A bare `using Foo` binds a same-named project file before an npm workspace package.
- A `using` never binds another language's file (`using System;` beside `system.ts`).
- `using X = Y;` adds an edge to `Y`; `extern alias` adds none.
- An alias for a namespace split across files stays unresolved; one with no first-party declaration stays external.
- `X::Target` and `global::Ns.Target` resolve against same-directory declarations; `X.Type.Member` needs a single-file alias binding.
- `X::Type` and `X.Type` stay unresolved while a project C# file has no readable syntax tree.
- A `using static N.T;`, or a `using X = N.T;` whose namespace `N` a readable file declares, stays external while a project C# file cannot be read, even one that discovery ignores. The importer counts as degraded in `analysis`, and the next build that changes a file extracts it again. A plain `using N;` is not counted: it binds any readable file that declares `N`.
- An alias use `X.Type` is unresolved when a namespace nearer than the alias's own declares a namespace or non-generic type `X`: any enclosing namespace for an alias before every namespace, only namespaces below the alias's own for one inside a block namespace or after a file-scoped header.
- A `using N;`, `using T = N.Type;`, or `using X = N;` inside a namespace resolves nothing when a namespace enclosing the directive declares a namespace or non-generic type named like the first segment of its target (`A.N` for `namespace A { using N; }`). While a project C# file has no syntax tree the directive stays unresolved too, because that file could declare the nearer name. Its dependency edge and import node still follow the directive text, and a `using static` is not checked. A name that another `using` supplies stays unresolved when such a shadowed `using N;` may bring it in too, because the nearer namespace declares it or an unread file could, and a dotted name led by it (`B.Nested.Run()`, `B.Nested value;`) never falls back to a namespace `B`.
- An alias whose target is unresolved (external or generic) still hides a same-named type that `using N;` imports where the alias is in scope: its namespace block, or the file for an alias before every namespace. An alias in a sibling or reopened namespace block does not, and a `using N;` in a nested block that C# reaches first still leaves the use unresolved. Of several aliases of one name in scope, the one in the nearest namespace block binds, whether it names a type or a namespace, and an unresolved alias in scope never falls back to a namespace of its name (`B.Nested.Run()` beside a namespace `B`). Go-to-definition, references, and member-call graph edges follow this; the detailed graph reads its type-use edges from a table of the file's aliases, so it records none for a name that two aliases share or whose alias sits in another block.
- A name qualified through a generic type (`N.Outer<int>.Inner`) is unresolved.
- `using static N.T;` binds one file and imports accessible static members, constants, and nested types, not instance or extension members; a name two directives provide stays unresolved.
- `using static` does not bind a type split across files (`partial`), `global using static`, or nested types.
- A namespace alias declared under `#if`, `#elif`, or `#else` is not visible after `#endif`; preprocessor expansion is out of scope, so those uses stay `not_found` or `partial`.

## Kotlin

- The native grammar is a pinned fork of `tree-sitter-kotlin-ng` with upstream parser fixes, including multi-dollar strings (`$$"..."`, whose `$${name}` and `$$name` templates are references and whose shorter runs of dollars are text) and collection literals (`[]`). No Kotlin form that the corpus checks leave unparsed is known; a file that still ends in an `ERROR` declares only the names read before it, and its references stay `partial`.
- Package and import lookups read each file's top-level names from its syntax tree. A function is declared under its own name, an extension or generic one included, never under its receiver type, and a name that two files declare stays unresolved. A file with an `ERROR` at the top of its tree is incomplete (see Same-package peers). A declaration the grammar misreads without an `ERROR` (one after `context(...)` receivers, or after a combining mark inside an identifier) is not a package name, so an import of it does not resolve to its file. A backtick-quoted declaration (``class `Widget` ``) matches only an import that quotes the name the same way; `import p.Widget` stays unresolved.
- Custom `codegraph grep --query` patterns must use `tree-sitter-kotlin-ng` node names: `identifier`, not `simple_identifier` or `type_identifier`.
- `import pkg.*` considers top-level callables from every file in the package and picks an overload by argument count; a call two candidates accept stays unresolved.
- Wildcards import top-level package declarations, never class or companion members; same-named declarations in another package are not imported.
- Type-name receivers reach only companion-object and `object` members.

## Ruby

- `Constant = Struct.new(...)` is a class-kind symbol; runtime-computed class factories are not recognized.
- A nested `class Inner::Tool` in `module Outer` exports as `Outer::Inner::Tool` when the enclosing module declares `Inner`, else `Inner::Tool`; never a bare name.
- `require_relative "foo"` resolves from the requiring file's directory, never a root file; `require "foo"` binds a same-named project file before an npm workspace package.
- `load` and `autoload` are file dependencies like `require`.

## Rust

- `macro_rules!` definitions are function-kind symbols; macro invocations resolve to them.
- A trait method and its impl are separate same-name symbols, so a name-only lookup can be ambiguous.
- Visibility is per-file with no crate lattice, so a sibling can resolve a `pub(super)` item rustc would reject.
- `#[path]` targets must stay within `--root`; a missing target never falls back to a conventional sibling.
- `#[path]` owners come from the module tree reachable from Cargo crate roots; a `[workspace]`-only `Cargo.toml` adds none.
- `super` is suppressed when two reachable modules share a `#[path]` target but disagree on the parent; files with no reachable declarer or a truncated tree use directory scanning.
- Calls inside standard expression macros (`println!("{}", greet())`, `assert!`, `vec!`) are call edges; member or path calls in macro arguments are `not_found`.
- `macro_rules!` bodies and custom macro input are raw tokens, so `name(...)` there is not a call site.
- A comment between a name and its arguments inside macro arguments has no graph edge.

## Swift

- `init`, `deinit`, and `subscript` are chunks, not symbols; protocol `associatedtype`, `macro`, and `operator` are.
- `private` and `fileprivate` extension members stay out of owners in other files.
- A `where` extension shares members only with extensions of the same type whose constraint tokens match; logically equivalent constraints are not inferred.
- An unproven nominal receiver does not gain constrained extension members.

## Zig

- Only `pub` file-scope declarations are exports (`export` alone is C ABI visibility); `@import("api.zig")` resolves relative to the importing file.
- A sibling member is reached as `Self.helper()`, `@This().helper()`, or an instance; bare `helper()` has no edge and is `not_found`.
- `Self.helper(s)` (member called through its type with an explicit receiver) has no graph edge even when go-to-definition resolves it.

## HTML, Astro, and Handlebars

- HTML, Astro, and Handlebars walk embedded attributes, inline `<script>`, and inline `<style>`; other document formats opt out of specific forms.
- HTML extraction ignores comments and `<pre>`/`<code>` blocks; `<!--` or `>` inside quoted values or script strings never hides later edges.
- HTML edges come from `href` on `link` and `a`, `src` on `script` and `img`, and media-element sources.
- Astro: a scoped `<style>` block's `@import` and `url()` become edges.
- Handlebars adds `{{> partial}}` and `{{#> partial}}` references; interpolated paths such as `href="{{dynamicPath}}"` are ignored.

## Markdown, MDX, AsciiDoc, and reStructuredText

- These formats, Astro, and Handlebars are graph-first: links plus format-specific includes, with no semantic chunking, symbols, navigation, references, call hierarchy, or native-addon parity.
- Markdown, MDX, and AsciiDoc skip raw `img` and `source` srcset (their image syntax is deliberately not an edge); `<source src>` stays an edge.
- AsciiDoc reads `include::`, `xref`, `link`, and anchors, and skips `ifdef`/`ifndef`/`ifeval` regions without evaluating attributes (unterminated regions stay visible).
- reStructuredText reads `include`, `literalinclude`, `toctree`, and `:doc:`, runs no HTML pass, and skips wildcard `toctree` entries; `:ref:` and `:term:` are not extracted.
- `codegraph links` and `checkMarkdownLinks()` validate Markdown sources only; images, MDX, other formats, and custom anchors are not validated.

## CSS and Less

- CSS and Less have no symbols by design.
- Imports resolve against stylesheet extensions only, including Sass partials (a source specifier may bind a partial; a document `url()` may not).
- Graph-only CSS handles media-qualified imports, Less option-qualified imports, and CSS Modules `composes ... from` and `@value ... from`.

## SCSS

### Modules

- Symbols: `@mixin` and `@function` (function kind); `$variables`, placeholders, class and id selectors (variable kind). Navigation, references, and rename cover same-file names and Sass module members.
- `@use` namespaces (default, `as`, `as *`), `@forward` (`as prefix-*`, `show`, `hide`), and `@import` are modeled; `sass:` modules stay external.
- `-` and `_` are equal in variable, mixin, and function names; namespaces and placeholders compare as written; `-`/`_`-prefixed names are private under `@use` and `@forward`.
- `@import` shares the importer's scope with no privacy; import order is not modeled, and conflicting definitions stay unresolved.
- A directory loads `_index.scss` or `index.scss`; `@import` prefers import-only files, then ordinary files, then directories; `@use` never loads import-only files.
- Two siblings in one `@import` tier stay unresolved (`partial`); plain CSS imports are not loads.
- An `@import` inside a rule or at-rule block is `not_found` for its names and `partial` for the imported file.

### Scope

- Assignments that may reach an imported variable (several matching imports, an unresolved import, `@use ... as *` with a top-level or `!global` assignment) stay `partial`.
- A call before its mixin or function is plain CSS; a call in a body or default is deferred, `partial` if declared later.
- Two files declaring one placeholder leave the use unresolved (`partial`); a placeholder in a compound selector (`.a %ph .b`) cannot start navigation.
- A namespace click (`b` in `b.$brand`) and a covering scoped callable with no indexed symbol are `not_found`.

### Coverage and rename

- References are `partial` for an unreadable file, an unresolved `@use`/`@forward`/`@import` URL, a Vue or Svelte style block that may load the module, or a name declared twice.
- Interpolated placeholders and `@extend` names (`%btn#{$suffix}`) are not static references: `partial` coverage, unsafe rename.
- Dynamic lookups (`meta.load-css`, `get-function`, `call`, `function-exists`, `variable-exists`, bare or via `sass:meta`) make references `partial` and rename unsafe; an earlier user function of that name owns the call.
- `@use` inside an Astro `<style>` block has no graph edge, so that consumer is not read or reported.
- A block local whose name differs only in `-`/`_` spelling hides the member: go-to-definition is `not_found`, references are `partial` (`name_equivalence_unavailable`).
- Rename preview edits only the member name, not the namespace or forward prefix.
- It reports `name_collision`, `shadowing` (a local captures a bare same-kind use), and `invalid_identifier` (a new `-`/`_` prefix hides it).

## Vue and Svelte

- The native addon has no Vue or Svelte grammar (matrix: `Partial`); script, template, and style blocks use the JS/TS, HTML, and CSS-family grammars.
- A malformed document stops block parsing at the first unmatched opening tag.
- Svelte call hierarchy covers inline scripts only.

## SQL

### Navigation

- Not a full database analyzer: statement chunks and table, view, index, and routine symbols.
- A file is SQL when the language registry says so: `.sql`, `.ddl`, `.pgsql`, `.mysql`, or a suffix that `languages.extensions` maps to `sql`. Navigation, rename, review context, `explain`, artifacts, `graph`, and duplicate detection treat all of them alike.
- An exact object name wins; an unqualified basename resolves only when exactly one definition carries it; no schema is inferred.
- Schema-qualified names and `alias.column`/`table.column` resolve to table and view definitions; column definitions are `not_found`.
- A qualifier naming a routine in `FROM` belongs to that routine, never a same-named table.
- A routine and a relation sharing one alias give `not_found` and `partial` (`strategy_unavailable`).
- Impact is object-level: a changed `CREATE TABLE` reaches readers, a changed routine reaches callers, unmappable statements give `fileLevelChange`.
- Application-code strings link to SQL objects only through SQL-shaped literals in the review-context bridge.

### Routines

- Calls and `DROP`/`ALTER`/`COMMENT ON`/`GRANT` naming a routine are references; rename edits qualified names, bare ones are unsafe.
- Calls resolve only to indexed `CREATE FUNCTION`/`PROCEDURE`; built-ins resolve only if defined; missing explicit routine syntax is `not_found`.
- Not calls: columns, tables, strings, comments, quoted names, alias lists, T-SQL hints, `INSERT`/`COPY` targets, PL/pgSQL `EXECUTE`.
- `CAST(... AS type)` and `ON CONFLICT`/`OVER`/`FILTER` are not calls; T-SQL computed columns (`column AS routine(args)`) are.
- A routine name carried by two definitions is `not_found` and `partial`; overloads are not ranked.
- Not indexed: `CREATE OR ALTER`, `DEFINER`, temporary functions; dynamic SQL is scanned only for calls in the building expression.

### Scanning limits

- Lexing follows PostgreSQL and SQL Server, so MySQL backslash escapes, `[...]` list literals, and spaced subscripts (`arr [1]`) can be misread.
- A prepared-statement `EXECUTE name`, `INSERT` without `INTO`, and an unaliased `call`/`exec` column can also be misread.
- Routine ranges follow bare `BEGIN`/`CASE`; `END IF`/`LOOP`/`WHILE`/`REPEAT`/`FOR` close nothing; `GO` ends a batch.
- A nested procedural `CASE` with an `IF` inside a `BEGIN` truncates the routine range.
- A MySQL body without `BEGIN` is matched by nesting depth, so it can overrun and scans slowly.

## Terraform

- Every `.tf` file in a directory shares one module namespace; `.terraform/` directories are not discovered.
- A local module `source` (`./`, `../`, or absolute in the root) depends on every `.tf` file there; remote sources stay external.
- Rename: same-kind names in a module collide (`name_collision`); meta-argument names such as `source` give `invalid_identifier`; a `check` data-source name is `shadowing`.
- References are `partial` for a name declared twice, an unreadable file, a whole-module value (`value = module.net`), indexes that do not fit `count`/`for_each`, and addresses in `import`, `moved`, `removed`.
- Not references: `for`, template `for`, `dynamic` iterators; `count`, `each`, `self`, `path`, `terraform` values; a `check` block's data sources.
- Not supported: unquoted block labels, provider configurations and aliases, `ephemeral` resources, `terraform_remote_state` and remote module outputs, `.tf.json`, `.tfvars`, `.tftest.hcl`, `.tofu`.

## Project file discovery coverage

Name extraction: Yes = from metadata; Partial = project file detected, name falls back to the directory or filename; No = not detected. File discovery and monorepo boundaries are separate checks.

| Ecosystem       | Project files                                                                                                                                                                                                            | Name extraction                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Node.js         | `package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lockb`, `tsconfig.json`, `jsconfig.json`, `pnpm-workspace.yaml`, `lerna.json`, `nx.json`, `turbo.json`                                          | Yes for `package.json`, `lerna.json`, `nx.json`, and `turbo.json`; other configs fall back to the directory name |
| Python          | `pyproject.toml`, `requirements.txt`, `requirements.in`, `Pipfile`, `Pipfile.lock`, `poetry.lock`, `setup.py`, `setup.cfg`                                                                                               | Yes for `pyproject.toml`, `setup.cfg`, and `setup.py`                                                            |
| Go              | `go.mod`, `go.sum`, `go.work`                                                                                                                                                                                            | Yes for `go.mod`                                                                                                 |
| Rust            | `Cargo.toml`, `Cargo.lock`, `rust-toolchain`, `rust-toolchain.toml`                                                                                                                                                      | Yes for `Cargo.toml`                                                                                             |
| Java and Kotlin | `pom.xml`, `mvnw`, `build.gradle`, `build.gradle.kts`, `settings.gradle`, `settings.gradle.kts`, `gradle.properties`, `gradlew`                                                                                          | Yes for `pom.xml`, `settings.gradle`, `settings.gradle.kts`, and `gradle.properties`                             |
| .NET            | `*.csproj`, `*.fsproj`, `*.vbproj`, `*.sln`, `Directory.Build.props`, `Directory.Build.targets`, `global.json`                                                                                                           | Yes for `*.csproj`, `*.fsproj`, and `*.vbproj`; Partial for `*.sln` (filename) and the shared config files       |
| Ruby            | `Gemfile`, `Gemfile.lock`, `*.gemspec`                                                                                                                                                                                   | Yes for `*.gemspec`; Partial for `Gemfile`                                                                       |
| PHP             | `composer.json`, `composer.lock`                                                                                                                                                                                         | Yes for `composer.json`                                                                                          |
| Swift           | `Package.swift`, `Package.resolved`, `*.xcodeproj`, `*.xcworkspace`                                                                                                                                                      | Yes for `Package.swift`                                                                                          |
| C and C++       | `CMakeLists.txt`, `CMakePresets.json`, `CMakeUserPresets.json`, `Makefile`, `makefile`, `GNUmakefile`, `configure.ac`, `configure.in`, `meson.build`, `meson_options.txt`, `conanfile.txt`, `conanfile.py`, `vcpkg.json` | Yes for `vcpkg.json`; Partial for directory fallback cases                                                       |
| IDE             | `.idea`                                                                                                                                                                                                                  | Partial via directory fallback                                                                                   |

- Default discovery ignores common dependency and build trees (`node_modules/`, `.git/`, `dist/`, `build/`, `target/`, virtualenvs, `vendor/bundle/`, `.build/`, `Pods/`); bare `vendor/`, `env/`, `bin/`, and `obj/` stay discoverable. See [project config](./cli.md#project-config).

- Project file traversal stops at the nearest manifest boundary, so scoped scans do not inherit unrelated parent projects.
- `inspect` and `unresolved` use supported dependency manifests to suppress declared third-party packages.

## C/C++ resolution hints

Configure repo-local include roots with `graph.resolutionHints` (`codegraph.config.json`) or `--resolution-hint`; hints are root-confined and improve candidate-test linkage.

A quoted `#include` resolves against the including file's directory first, so `#include "lib.h"` binds to first-party siblings without configuration.
Angle includes (`#include <lib.h>`) stay external unless `graph.resolutionHints` reach a first-party file; C and C++ share this order for edges, navigation, and references.
