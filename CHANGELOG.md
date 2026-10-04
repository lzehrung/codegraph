# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases remain the certified publish record. This file summarizes product-facing changes so the repository itself has a readable history.

## [Unreleased]

### Fixed

- Python imports in a `TYPE_CHECKING` guard are type-only bindings and file dependencies, not runtime imports, in native and reduced mode. Without the native addon, `import a, b` now records every module in the list, not only the first. An import in a one-line compound suite, such as `if enabled: import feature`, is now recorded as a non-module-level binding, as native mode already did.
- TypeScript, Java, C#, and Kotlin resolve calls through chains of declared-typed fields (such as `this.repo.find()`), while unannotated fields remain unresolved and unrelated same-named methods are excluded. A qualified field type such as `B.Repo` in C# is never resolved to a same-named type of the current namespace.
- Members inherited through a type that declares none of its own now resolve in go-to-definition, references, and call graphs: `Derived d; d.run();` finds `Base.run` in C++, C#, Java, Kotlin, PHP, Swift, TypeScript, JavaScript, and Ruby. Rust finds a trait's default method through a type that implements the trait, and Go finds a promoted method through an embedded struct, including when the method, the type, and the call are in different files of the package.
- Go: a method declared in another file of the package resolves on a local of that type, and `d.Base.Run()` through an embedded field resolves.
- Fully qualified calls resolve without an import: `com.example.Util.add(1, 2)` in Java, `calc.add(1, 2)` in Kotlin, `calc::add(1, 2)` in Rust, and `\App\add()` in PHP, which before had no call-graph edge. In mixed Java and Kotlin code, a package-qualified name also reaches a type in the other language. Java sees Kotlin types but not Kotlin top-level functions, and a Java type without `public` stays in its package.
- C++: a namespace alias such as `namespace dm = a::b;` is followed, and `Base::run()` called from an override now has a call-graph edge.
- Kotlin and Java: an imported function or static method with several overloads goes to the overload that accepts the call's argument count. Before, none of the calls resolved. A count that two overloads accept stays unresolved.
- Swift: a call through a `typealias` of a type, such as `Fast.add()`, resolves.
- JavaScript and TypeScript: `new Derived().run()` goes to the inherited instance method when `Derived` declares only a `static run()`. In C++, Java, C#, PHP, and Python, a static member with that name still hides the inherited one, as in those languages.
- TypeScript, JavaScript, Python, and Rust: a parameter or local that shadows a module import alias (`import * as api`, then `function f(api) { api.run(); }`) is no longer a reference to, or a call of, the imported module's `run`. A local that holds the same module, such as `let api: typeof import("./api")` assigned `await import("./api")`, does not shadow it.
- TypeScript: a function declared inside a method body, such as a local `function helper() {}`, no longer joins the class member `helper` as one overload set. `this.helper()` keeps its edge to the class member in the call graph instead of moving to the local function.
- C++: a qualified call such as `dm::add()` resolves through the closest visible `dm`, including a namespace alias or nested namespace in the enclosing namespace, instead of an unrelated global `dm`.
- Kotlin: with `import calc.*`, a call goes to the overload that accepts its argument count even when the overloads are in different files of the package. Java and Kotlin package wildcards include types from both languages' files in the package; Kotlin also imports top-level Kotlin functions, while Java does not. Java `import p.*` does not import class methods, enum constants, or nested types, and Kotlin package wildcards exclude class and companion members. Disk and memory caches also pick up files added to or deleted from an imported package, in either language. A Java type without `public` is not imported from another package. When `p.C` is a class, `import p.C.*` imports its nested types, including enums, not its methods. A Java enum can also be the owner `C`. A named import such as Java `import p.KotlinType;` resolves a type declared in the other JVM language; Java still does not import Kotlin top-level functions. Java `import static p.Util.*` imports only the static members and nested types of `Util`, not its instance methods or other types in the same file. From another package, it also skips package-private and protected static members. A named `import static p.Util.hit;` binds only the static `hit` members of `Util`. A package-private Java method is not inherited by a subclass in another package, so `hit()` there does not resolve to it.
- C# and Java: when a derived method overrides a base method with the same parameters, a call that only the base method's defaults accept no longer goes to the hidden base method.
- Ruby: `require_relative "foo"` resolves next to the requiring file. Before, it was looked up from the project root, so in a subdirectory it stayed unresolved or picked a same-named file at the root. `require "foo"` keeps its rule.
- Java and Kotlin: `import p.C` binds class `C` even when a package `p.C` also exists, and `import p.C.*` names the package. Import bindings, file-graph edges, and go-to-definition now agree on the target.
- Java and C#: a call that only an inherited overload accepts, such as `this.hit(1)` with `Base.hit()` and `GrandBase.hit(int)`, now has a call-graph edge to `GrandBase.hit`, as go-to-definition already found. An override with the same parameters still hides the ancestor method.
- Ruby: `Calc.add` and `Counter.zero` calls through a module or class name have call-graph edges. `require_relative` no longer makes instance methods importable names, so references of a method no longer list same-named methods of unrelated classes.
- Zig: `const area = @import("shapes.zig").area;` goes to `area` in `shapes.zig`. Calls and construction through a type in another file (`box.Box{}`, `counter.Counter.zero()`) have call-graph edges, and struct literals record `instantiates` edges. A bare `@import("api.zig")` is now a file-graph dependency on `api.zig` instead of an external name.
- C# `using N.T` binds the file that declares type `T` when `N.T` is not a namespace. An ambiguous or unreadable match stays unresolved instead of a same-shaped path. A bare C# `using` or Ruby `require` prefers a same-named project file over an npm workspace package, and a C# import no longer binds a file of another language.
- A failed Python relative import such as `from .missing import x` is reported as `.missing`, including by `getUnresolvedImports`.
- An SCSS partial resolves for a source specifier. A `url()` document specifier still does not. A file with both `@use "icons"` and `url("icons")` keeps both dependencies; before, the second one was dropped.

### Changed

- Indexing is about 13% faster than 2.4.0, and detailed call graphs about 7% faster, on the codegraph `src/` tree with default threads. Comment and string masking no longer copies each file one character at a time, and a JavaScript or TypeScript file is masked once for export extraction instead of twice. Results are unchanged.
- Detailed call graphs build faster: callable facts (identity and accepted argument counts) are computed once when a file is indexed and stored in the cache, instead of being parsed again for each call.
- Existing caches are rebuilt on the first run after upgrading, so that run takes longer than usual.

### Security

- File discovery uses `tinyglobby` instead of `fast-glob`, so `braces` ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), no patched release) is no longer a production dependency, and the temporary audit exception is removed ([#394](https://github.com/lzehrung/codegraph/issues/394)). Discovered files are unchanged. When a directory link reaches a workspace package by more than one path (for example a link cycle), the package keeps its own directory instead of an alias through the link; 2.4.0 could record a path dozens of levels deep.
- `piscina` now requires 4.9.4 or later, which fixes a prototype-pollution issue in its pool options ([GHSA-67c8-pqhq-4rmx](https://github.com/advisories/GHSA-67c8-pqhq-4rmx)).

## [2.4.0] - 2026-09-30

### Added

- `apisurface --undocumented` and `getUndocumentedApiSurface` return checked, undocumented exports with source locations and explicit partial coverage for unsupported or reduced-mode files. A documented TypeScript overload signature now documents its collapsed export.

### Fixed

- CommonJS fallback function exports now preserve leading JSDoc when a parser tree is available. Malformed cached docstring-coverage markers trigger a rebuild rather than reporting unchecked declarations as undocumented.
  CommonJS JSDoc now follows the assignment target instead of an unrelated same-named local.
- Warm `buildProjectIndex` and `buildProjectIndexFromFiles` builds with a disk or memory cache no longer keep import targets from before a file was moved, deleted, or added. Before, a module that did not change kept its old binding (for example, to a moved `a.ts`). Go-to-definition, references, and call graphs then returned `not_found` until a cold build. These builds now apply the same invalidation as `buildProjectIndexIncremental` (#389).
  - Adding, changing, or deleting a file that declares a C++ module, C# namespace, or Java, Kotlin, or PHP package re-resolves the importers of that name, as a cold build does. This includes files under unrelated names and files with a configured language extension.
  - A relative Python import such as `from . import mod` re-resolves when `mod.py` is added.
  - A build without a manifest deletes stale cache rows before it extracts them again. It keeps the deletion evidence when the build covers only an explicit file list.
  - A `memory` cache that evicted a payload, or a changed file whose old cache row cannot be decoded, re-resolves the affected importers until a complete build restores the rows.
  - The cache epoch changed, so rows from earlier versions are discarded on upgrade.
- C#: types imported by `using N;` now resolve in go-to-definition, references, and call graphs when namespace `N` is declared in more than one file, which is the usual layout. Before, nothing imported through such a directive resolved. Namespace-qualified calls such as `N.Type.M()` now resolve too. A `using` directive no longer binds a file in another language whose path matches the name, such as a root `p.ts` for `using P;`.
- C#: a bare name imported by `using static N.T;` now goes to the static member, constant, or nested type of `T` in go-to-definition, references, and call graphs. Before, it was not found. Instance, extension, private, and protected members are not imported, and a name that two sources provide stays unresolved.
- Java and C#: go-to-definition on a type-qualified call such as `Util.Two(1, 2)` goes to the static overload that accepts the argument count, including one declared in another part of a C# partial type. Before, it went to the first overload, and find references listed the call under that overload. Go-to-definition on an overload's own declaration now opens that overload instead of the last one. A method group such as `Util.Two` names no argument count and stays unresolved.
- `hotspots` help now describes fan-in and fan-out connectivity, not code complexity.
- Java and Kotlin: a bare call inside a class to an inherited method now goes to that method, in go-to-definition, references, and call graphs. Before, a same-package function, a wildcard import, or a Java static import with the same name won. A private base method is not inherited, so it does not take precedence, and in a Java static method such a call has no target. Go-to-definition, references, and call graphs now share one name-lookup implementation, so they cannot disagree on which declaration a name refers to.
- Go-to-definition and call graphs give the same answer for every call site in the language samples and in a new per-call-form test set. The graph now records calls it missed: Java and Kotlin static and `object`/companion calls through an imported or wildcard-imported type, qualified construction such as `new Utils.Inner()` in Java and C#, C# `using static` calls, Swift module-qualified calls (a regression in the previous release) and construction without `new` (`Foo()`), TypeScript same-file namespace member calls (#383), calls inside TypeScript generator functions and `await f<T>(x)`, calls inside Rust macro arguments such as `println!("{}", greet())`, and C and C++ calls through transitively included headers.
- Call graphs no longer contain edges that go-to-definition rejects: calls to private, `internal`, or `pub(self)` declarations that the caller cannot see (Rust, Java, Kotlin), unqualified calls to a Zig struct member, and C++ calls that name no visible or arity-compatible declaration.
- Go-to-definition resolves more TypeScript member calls: optional calls such as `store?.close()`, receivers declared `Store | undefined` (including after later assignments), loop variables reassigned from their own members, and a binding annotated `typeof import("./m")`, whose member calls resolve to that module's exports in go-to-definition and call graphs alike. A method parameter named like a class member (`replace(metadata: number)`) no longer hides `this.metadata()`, and a type literal's method signature and an object literal's method are no longer merged into one overload set.
- Call graphs record calls made inside named JavaScript function expressions and `exports.x = function () {}` assignments (such as transpiled `{ key: "render", value: function render() {} }` classes). A function assigned to an object member (`this.handlers.move = function () {}`) is no longer attributed to an unrelated same-named method.
- Go-to-definition no longer answers with the enclosing declaration when the position is inside a body or initializer: `trim` in `const handle = value?.trim()`, `import` in `import("./x")`, and `test` in `/re/.test(x)` are not found instead of resolving to `handle` or the enclosing function. A position on the declaration header and JavaScript/TypeScript `this` (outside an ordinary nested function) still resolve.
- Go-to-definition picks Swift overloads by argument count, as call graphs do. A call whose argument count the only candidate cannot accept still navigates to that candidate, so callers of a changed signature stay visible in references and impact; call graphs record no edge for it. An instance member called through the type name (Swift `Box.instanceHelper()`), a C# instance call from a static local function, a Python call of a module binding, a C struct function-pointer field call, and a Rust member or path call inside macro arguments are not found.
- Calls to functions with default, optional, rest, `params`, or `vararg` parameters now appear in call graphs, callers and callees, and impact results for TypeScript, TSX, C#, Java, Kotlin, and Swift. Overloads are chosen by argument count, and ambiguous calls stay unresolved instead of picking a wrong target.
- Impact argument-count hints are more accurate. They handle Python static and class methods, Ruby block parameters, Rust trait methods, and C# extension methods, and they no longer guess when a call spreads an array into arguments.
- Go, Java, Kotlin, C#, and Swift files that use each other without an import, because they share a package, namespace, or module directory, now resolve in go-to-definition, find references, and call graphs. Members split across C# partial classes or Swift extensions are found from every part. Private and file-local declarations still stay in their own file.
- Member calls through `this`, `self`, and similar receivers now navigate in C++, C#, Java, Kotlin, Ruby, and Swift. Calls through `super`, `base`, and `parent` go to the base class instead of an override in the current class.
- TypeScript and JavaScript: find references on an enum includes uses in other files. Imports of dotted file names without an extension, such as `./orders.model`, now resolve. Call hierarchy works on functions assigned to variables, such as `const helper = () => 1`.
- C and C++: `#include "x.h"` resolves relative to the including file, and `#include <x.h>` checks the configured include directories, so dependencies, go-to-definition, and references work for ordinary project layouts. Find references now reports call sites, and `struct` and `enum` tags stay separate from typedefs with the same name.
- C++: a function's header declaration and its definition are one symbol, overloads resolve by argument count, go-to-definition on an overload's own declaration opens that overload, and namespaces and `using` declarations resolve correctly. A `using namespace` in a header applies only after the `#include` that brings it in. Impact reports calls whose argument count no longer matches a changed C++ signature.
- C#: navigation respects namespace boundaries and resolves `using` aliases (including `Alias::Type`), `global::`, qualified generic types, and extension methods called through their static class. C# 11 `file` types stay inside their own file. `using PT = N.Point` resolves when namespace `N` is declared in several files; an ambiguous match stays unresolved.
- PHP: class, function, and method names match without regard to letter case, as PHP does, so references include differently cased uses and code in the global namespace. Class, function, and constant imports with the same name stay separate, and `use App\X` resolves to the indexed declaration of that qualified name. `class Child extends Base` never resolves to a function named `Base`.
- C++: out-of-line definitions qualified by a namespace (`int a::C::run()`) or returning a pointer (`int* Box::make()`), and in-class declarations returning a pointer or reference, are symbols, so they fold into their own class member for go-to-definition, references, and call graphs instead of borrowing a same-named member of another class. Inside an out-of-line member definition such as `int Box::run()`, a member of `Box` or its bases hides a same-named file-scope function for go-to-definition, references, and call graphs; a bare call the owner does not declare is an ordinary call again, so it keeps its call-graph edge. In a static member function, an instance member with that name still hides the global, so the call has no target. Rust: call graphs record calls only inside standard expression macros such as `println!`, `assert!`, and `vec!` (unqualified or through `std`, `core`, or `alloc`), not inside `macro_rules!` bodies or custom macro input such as `my_dsl::println!`. Kotlin and Java: a local variable in another method, or a member of an unrelated class, no longer hides a same-package function, so the call no longer binds a wildcard-imported function with the same name. TypeScript: `new N.C()` on a namespace class records an `instantiates` edge, and `N.C()` without `new` records no call edge.
- Swift: members of a constrained extension, such as `extension Box where T == Int`, are no longer offered on every `Box`.
- Zig: functions imported through `@import` resolve, and only `pub` declarations are visible to other files.
- TypeScript and JavaScript: overloaded functions resolve from other files; overload signatures collapse into one callable only when exactly one implementation exists, so `declare` and interface overloads keep one entry per signature. `module.exports = Widget` exports the `Widget` visible at that assignment. Default-exported classes, `module.exports`, `const util = require("./util")`, and `await import("./lazy")` bindings resolve member calls such as `util.helper()`.
- References include a use of a name declared later in the same scope when the language makes that declaration visible there (functions and classes, Python function-local names, JavaScript `let`/`const`). Variables are visible only after their assignment or declaration: in PHP, Ruby, Python, C#, and Kotlin an earlier use of a later variable is not a reference. Functions, classes, and methods keep their language's hoisting (a Python function body can call a module function defined later; a top-level call before the `def` cannot). In C and C++, a name is visible only after its declaration (a prototype counts), except class members, which are visible throughout their class. PHP references list each `$variable` use once.
- Java, Kotlin, C#, Swift, and C++: member calls on a parameter or local with a declared type (`void use(Greeter g) { g.hello(); }`, `Box b; b.run();`) resolve. Kotlin companion-object factories and extension functions resolve, and an instance method called through the type name no longer does.
- Python: `from pkg import name` binds a name that `pkg/__init__.py` defines before falling back to the `pkg/name.py` submodule, as Python does. `import pkg.mod` then `pkg.mod.foo()` resolves, a class named like its own file is found through a package re-export, and `super().method()` reaches a known base class.
- Ruby and PHP: `Widget.new` on a class from another file, cross-file inheritance and mixins, `new self()`, PHP 8 promoted constructor properties, and same-namespace PHP classes without a `use` line now resolve. A class nested in a Ruby module is no longer mistaken for a top-level class of the same name, and `class Inner::Tool` inside `module Outer` is `Outer::Inner::Tool` when `Outer` declares `Inner`.
- Rust, Go, and C: `super::Type`, workspace and path dependencies (including `workspace = true`), glob imports, and `impl` methods resolve and appear in call graphs. A path dependency resolves only into a directory whose `Cargo.toml` names that package, as Cargo requires, and a `Cargo.toml` symlinked from outside the project is ignored. A package's own binaries name its library by `[lib] name` when set; this applies only to binary targets of a package that has a library, and resolves inside that library's module tree. Go no longer resolves unexported names or methods from another package, including `v.hidden()` on a value of an imported type, and a call such as `v.Visible()` on `v := pkg.T{}` now appears in call graphs. A C function's header declaration and its definition share one reference list.
- When two wildcard imports provide the same name, codegraph follows each language's rule (Python: the last import wins; Java, Kotlin, and Rust: an explicit import wins) and otherwise reports the name as ambiguous instead of picking one. An explicit import that cannot be resolved still wins over a wildcard, so the name is reported as not found rather than taken from the wildcard. In Python, a later import rebinds an earlier local definition of the same name, and the reverse. The rule also applies to a receiver such as `X` in `X.method()`, a Python base class, a module bound by `from pkg import *`, and call graph edges. A Python name imported twice (`from a import X` then `from b import X`) follows the later import. In Java and Kotlin, an explicit import also wins over a class of the same name in the file's own package.
- Go-to-definition, find references, and call graphs now give the same answer for the same use.
- TypeScript: an interface or `declare` overload set without an implementation keeps one entry per signature, so a call goes to the signature that matches its argument count in go-to-definition, references, and call graphs. Overloads in different namespaces stay separate, and overloads split across merged interface declarations are chosen by argument count. When an overload set has an implementation, a call must still match one of the declared signatures: a call with an argument count that only the implementation accepts is not found and has no call edge.
- CommonJS: `module.exports = function () {}` resolves through `require()` and default imports like `module.exports = Widget`, and references include those uses. A module with only named exports no longer gets a default-import edge.
- Python: `from pkg import sub`, where `sub` is a package, binds to `sub/__init__.py`. Package members match file names with exact letter case, as Python does, so `pkg.Widget` does not resolve to `pkg/widget.py`. A plain `import pkg` does not make `pkg.child` resolve to `pkg/child.py`: Python binds that attribute only after `pkg.child` is imported, so go-to-definition reports not found and references mark such a use as partial. A parameter, local, or import named `super` shadows the built-in, so `super().m()` through it no longer goes to the base class.
- Rust: a path or workspace dependency whose `Cargo.toml` sets `[lib].path` resolves from that file instead of `src/lib.rs`.
- Java, Kotlin, and C#: when a same-package file cannot be read, a sibling-package name is no longer resolved as if that file could not declare it. A Kotlin `package p` clause without a semicolon counts as the same package.
- Code review: deleting a C or C++ file that includes one header both as `<x.h>` and `"x.h"` reports both removed edges. Deleting the header itself also reports both edges. `codegraph affected` also finds tests that include a deleted header through `--resolution-hint` include directories.
- CommonJS and default exports: `module.exports = Widget` stays the class value when properties are also assigned on it, so `require()` member calls resolve. This also works for TypeScript and TSX files and without the native parser. When a file assigns `module.exports` more than once, codegraph does not guess which value `require()` returns. A module that re-exports names (`export { x } from`, `export *`) is a namespace value, not its default class. A default-exported function does not resolve members through a same-named nested class. References include uses through nested namespace re-exports such as `require("./widget").helpers.helper()`.
- C and C++: `#include <x.h>` and `#include "x.h"` in one file stay two dependency edges in the file graph, disk-cache rebuilds, graph deltas, and drift reports. C++ overload selection no longer mistakes a use in another file for a declaration at the same position.
- Scope rules follow each language more closely. Python methods, nested classes, and comprehension bodies do not see names bound in the class body. In Kotlin, a use before a later local refers to the outer property. In C#, a local declared later in a block hides the field for the whole block, so an earlier use no longer resolves to the field. Ruby `foo()` with parentheses or arguments calls the method, not a local named `foo`. Go references include uses that go-to-definition already resolved. PHP `$widget` never matches a class, function, or import named `widget`.
- PHP: class, function, and constant positions resolve only to declarations of that kind. `new Base()` with only a `use function` import of `Base` has no instantiation edge, and references of `function Face` exclude `implements Face`.
- A warm disk-cache build picks up a newly added file that an existing import can now resolve to, including dotted file names such as `./data.model`, `.d.ts` declaration files, Python absolute imports, a Python module or namespace directory added to a package that `from pkg import name` already imports, a module added to a Python namespace package (no `__init__.py`), Java and Kotlin dotted imports, Rust modules, C# `using` namespaces, Go package directories, quoted C and C++ includes, and every tsconfig path alias target. Editing a `Cargo.toml` also refreshes Rust imports that depend on it. A newly added file that an import prefers over its current target (an earlier tsconfig path fallback, `foo.ts` over `foo/index.ts`, or a quoted-include sibling over a hint directory) replaces that target.

### Changed

- SQLite artifacts use schema version 4: `file_edges` has a nullable `include_form` column, so `#include <x.h>` and `#include "x.h"` stay two rows. Version 3 and older artifacts migrate on open; rows written before the upgrade keep `include_form` empty.

- `referenceCoverage` reports `partial` instead of `complete` when codegraph could not check every possible use, with the new reasons `strategy_unavailable` and `name_equivalence_unavailable`. A use that could name more than one definition, such as a C++ call that fits two overloads, counts as unchecked. Rename previews and impact treat these results as incomplete.
- Agent sessions with `freshness: { policy: "manual" }` report `{ state: "unchecked" }` from `checkFreshness()` instead of claiming `fresh` without checking. Code that handles every freshness state must handle `unchecked`.
- Existing caches are rebuilt on the first run after upgrading, so that run takes longer than usual.

## [2.3.31] - 2026-09-21

### Changed

- Per-language member access, dynamic import folding, import binding, and call-compatibility behavior now lives in typed registries keyed by language id. Registry consistency tests reject missing or stale rows, with no change to indexing results.

## [2.3.30] - 2026-09-21

### Added

- JavaScript class inheritance is extracted. `class Child extends Base` now emits `extends` edges from the JavaScript grammar's `class_heritage` node, so supertypes, subtypes, implementations, and `super.m()` call edges work in `.js` files instead of returning empty results.
- Go interface embedding and struct embedding emit `implements` edges, so an embedded interface reports its implementers.
- Per-language declaration visibility filters module exports. Rust publishes only `pub`, `pub(crate)`, and `pub(super)` items; Java hides `private`; C# hides `private` everywhere and `internal` at namespace or file scope; Kotlin hides `private` and `internal`; Swift hides `private` and `fileprivate`; C and C++ hide a file-scope `static` storage class, while a `static` member inside a class or struct stays exported. A hidden declaration stays a file local with working same-file navigation, and it no longer binds through an import from another file. Python keeps `__all__` and underscore filtering, and a module-level `from a import *` is now an `exportStar` re-export, so `from b import name` resolves like an ECMAScript `export *`.
- C# method and constructor parameters are indexed as locals, matching Java and Kotlin, so they appear in symbol lists, navigation, rename, and impact. Java constructor declarations and `...` spread parameter names are recognized declaration names.
- Astro scoped `<style>` blocks contribute document edges: `@import "./theme.css"` and `url(./bg.png)` resolve like they do in HTML, Vue, and Svelte. Handlebars gains the same embedded-HTML coverage, and Markdown, MDX, and AsciiDoc walk the shared HTML forms instead of an `<a href>`-only subset.
- Ruby `require File.join(__dir__, "name")` and PHP computed `include`/`require` chains rooted at `__DIR__` or `dirname(__FILE__)` resolve under the opt-in dynamic-import heuristics, with non-foldable paths still ignored.
- AngularJS framework edges cover every JS-family file the registry resolves, so TypeScript, `.mjs`, `.cjs`, and `.jsx` projects get the same `templateUrl`, controller-name, and dependency-injection edges that `.js` projects had.
- JavaScript `import type` and `export type` statements produce type-only import bindings and type-only graph edges, matching TypeScript.

### Fixed

- First-party import resolution now realpath-confines targets while keeping the logical path, scopes Java, Kotlin, C#, PHP, and Python symbol indexes to the nearest language manifest file (a directory named `build.csproj/` is not a C# project) so a same-named package in a sibling workspace does not bind, and no longer treats a directory as a file edge unless the language runtime does (Python regular packages, PEP 420 namespace packages, and Go package directories). A leading U+FEFF is stripped from `tsconfig.json` and other resolution source text so BOM-prefixed path mappings still apply.
- Zig container members no longer leak into file scope. A `struct`, `union`, or `enum` member function is reachable through `Self.helper()`, `@This().helper()`, or an instance, and a bare `helper()` call inside the container now emits no edge and navigates to `not_found`.
- A file whose only line terminator is a lone carriage return reports real line numbers instead of placing every symbol on line 1.
- A source file over the native byte limit reports a structured `sourceTooLarge` fallback reason in the build report instead of only a warning log, so the downgrade is visible to callers.
- C++ modules declared in module-interface files (`.cppm`, `.ixx`, `.mxx`) now resolve. Neither the C++ language definition nor default discovery claimed those extensions, so the declaring file was never indexed, a first-party `import foo;` stayed external, and the declaration was invisible to incremental invalidation.
- Rust `pub(in path)` items are module exports, and `pub(self)` stays file-local, including spaced spellings such as `pub ( self )`.
- Extension-pattern manifest matches are deterministic. Two files matching `*.csproj` in one directory resolved by filesystem order, so the package root differed per machine and a cached index built on one disagreed with another. Selection now prefers a manifest whose name matches its directory, then falls back to name order, and Rust declaring-file candidates are sorted the same way.
- Media sources survive document extraction. Markdown, MDX, and AsciiDoc dropped every `<source>` element along with image syntax, so a `<video><source src="./clip.webm">` lost its edge; only `srcset` candidates are excluded now.
- The language-definition fingerprint recorded `membersAreImplicitlyInScope` with the wrong default, so a language flipping that field could reuse a stale cache.

### Changed

- Cross-language behavior that used to be copied per language now lives in shared tables, with no change to indexing results: one trivia lexer masks comments and strings for every language, scope node types and base-clause shapes are declared in tables rather than inlined branches, import queries share one compiler-enforced capture vocabulary (`@stmt` plus `@from`, with optional `@alias`, `@wild`, `@iname`, `@def`, `@ns`, and `@type_kw`), document formats run one embedded-HTML extractor driven by a per-format opt-out table, and dynamic-import heuristics share one constant-path fold.
- Unqualified member lookup inside a type body is now opt-in per language and enabled for Java, C#, Kotlin, Swift, Ruby, and C++, which is the set whose runtimes resolve a bare member name.
- The native addon no longer ships Vue and Svelte grammars. Single-file components already indexed through the embedded JavaScript, TypeScript, HTML, and CSS grammars, so the addon's supported-language set drops to 20 ids with no change to `.vue` or `.svelte` results.
- The package util surface exports `extractDynamicImportSpecifiers(languageId, source, fromFile, projectRoot)` in place of the undocumented `extractJsTsDynamicSpecifiers`.

## [2.3.29] - 2026-09-20

### Added

- Go receiver method calls resolve. A Go `method_declaration` now publishes a `member_of` edge to its receiver type, so `b.GoHelper()` produces a resolved `calls` edge for value, pointer, and `var`-declared receivers, and `callers`, `callees`, and impact report those call sites. A same-named package function is never attributed to a method, and interface-typed or factory-assigned receivers still emit nothing.
- Python receiver member navigation resolves `self` and `cls` members, attributes assigned in `__init__`, unique members inherited from declared bases, and locals assigned from a direct constructor call (`svc = Service()` or `svc: Service = Service()`). Python now appears in `diagnostics.memberResolutionCoverage.receiverAwareLanguages`; factory-assigned and unannotated-parameter receivers stay unresolved.
- C# namespace aliases resolve to first-party files. `using X = Project.Namespace;` contributes a dependency edge to every file declaring that namespace in block or file-scoped form, and a namespace declared in exactly one file also binds the alias, so member access through it navigates. A split namespace keeps the alias unresolved, and an external namespace such as `System.Collections.Generic` stays external.
- C# positional record components are indexed as variable locals, matching Java records, and `extern alias X;` is recognized as a local namespace alias with no dependency edge.
- SCSS go-to-definition and find references resolve same-file declarations and uses, including `$variable` reads, `@include` mixin names, and `@extend %placeholder`. Namespaced `@use` members and cross-file SCSS navigation stay unresolved.
- TypeScript and TSX named function expressions, including named generator function expressions, bind their own name inside the function body, matching JavaScript. The name is not exported and does not resolve from a sibling statement.
- C++20 module declarations are indexed: `export module foo;` publishes the module name, a first-party `import foo;` resolves to the declaring file like a `#include`, and `import std;` stays external. The C++ grammar is pinned to the upstream revision that exposes the module nodes.
- SQL impact mapping is object level. A changed SQL object becomes a changed symbol and impacts only files that read it, with a symbol-level reason; an unreferenced object in the same file no longer fans out to those readers, and unmapped statements still fall back to file-level impact.

### Fixed

- The generated fixture test matrix is current again. `npm run bench:fixtures:check` failed on the cross-language `tests/languages/query-hygiene.test.ts` stem instead of comparing counts, so `docs/benchmarks/fixture-snapshot.md` reported 256 tests while the suites ran 477. The check now runs in CI, and the generated snapshot JSON is excluded from Prettier so the format and freshness gates stop contradicting each other.

### Changed

- `docs/language-parity.md` now groups its capability notes by surface instead of one flat list, and corrects claims that no longer matched the code: `this.member` navigation resolves, reduced-mode regex import recovery is JavaScript/TypeScript only, `exports` publishes type members only for languages whose query captures them, and the Vue and Svelte native-addon cells state that single-file-component indexing uses the embedded JS/TS, HTML, and CSS grammars. Node.js, Java/Kotlin, and .NET project-name verdicts and the Gradle ignore default are fixed.

## [2.3.28] - 2026-09-20

### Fixed

- Cross-file reference searches now include resolved named and default import declaration tokens across supported languages. They preserve exact source-name and local-alias roles when both names have the same spelling, exclude names in comments and string literals, retain multi-line Python imports, ignore raw multiline-string contents and preserve qualified imports across nested comments in reduced-mode Kotlin, and avoid duplicate rename edits. Native and reduced CommonJS destructuring now ignore commas inside nested defaults. Rename previews treat partial reference coverage as unsafe.
- TypeScript and JavaScript receiver-member navigation now resolves enum members and valid static class fields without treating initializer reads, nested method locals, or type-only aliases as runtime class members. Declaration extraction also keeps Zig `extern const` variables, PHP constants with initializers, and Python destructuring targets accurate.
- Successful reference results now report complete or partial indexed-candidate coverage separately from target-definition confidence, including parser, unresolved-import, and exact truncation reasons.
- Detailed review summaries now apply callsite limits after excluding definition, import, and re-export declarations, report `callsiteCoverage` when the bounded usage scan is partial, and keep affected file paths project-relative.
- Cached parser, native, and fallback-import diagnostics now rebase file paths when a project cache moves with its project tree.

## [2.3.27] - 2026-09-15

### Fixed

- A `#[path]` module now resolves `super` against the module that actually declares it in the crate module tree, so an undeclared or generated `.rs` file no longer owns it when a Cargo crate root is reachable. The result no longer depends on directory-entry order in that case. When there is no Cargo root, no crate root, no reachable owner, or the tree is truncated, the prior directory scan still applies. The tree covers every Cargo target, including binaries, tests, examples, benches, and the build script. Default `src/lib.rs` is included when `[lib] path` is absent and either `[lib]` is explicit or `autolib` is not `false`; default `src/main.rs` and `src/bin` follow `autobins`. An explicit `[[bin]]`, `[[example]]`, `[[test]]`, or `[[bench]]` table without `path` still uses Cargo's default file for that name when auto-discovery is off. Crate-root files resolve child modules from their containing directory. Conventional module files that leave `--root`, including through a symlink, are not walked. Raw-identifier modules such as `mod r#type;` use the unescaped name. Explicit crate-root `path` values are kept even when they do not end in `.rs`. A virtual workspace manifest (`[workspace]` without `[package]`) contributes no package targets. Owner, reachable, and crate-root maps identify files with `fileIdentityKey`, so a `#[path]` spelling that differs only by case still matches the indexed file on a case-insensitive filesystem. Concurrent lookups after the revalidation interval share one freshness sweep instead of each repeating every crate-path `stat`. `cfg`-gated declarations of the same module name stay distinct.
- When two reachable modules declare the same `#[path]` target, `super` stays unresolved instead of picking one.
- Certified `release` and `standalone-release` workflows retry GitHub artifact upload and download after transient artifact-service errors such as DNS `ENOTFOUND`. Native matrix jobs keep `fail-fast: false` and a 30-minute timeout. Failure-report uploads still run after a failed command. The standalone workflow stores package candidates under a distinct artifact name so it does not replace certified `release-candidates`. After a failed run, use **Re-run failed jobs** on the same Actions run so successful native artifacts are reused.

## [2.3.26] - 2026-09-13

### Fixed

- Standalone installation on Windows survives a directory that a scanner or a departing process still holds open. `install.ps1` and the installer library now retry the staged version-root move for about nine seconds instead of under one, and removals retry as well.
- The standalone bundle smoke now runs against the published version root instead of the staged copy that is about to be renamed, so running `node.exe` no longer blocks the move that follows it. A staged copy that cannot be removed afterwards no longer fails an install that already completed.

## [2.3.25] - 2026-09-13

### Fixed

- Language queries now match the loaded grammars, preserve supported declaration forms, and exclude false CommonJS and function-local exports.
- Default discovery includes registered language aliases. HTML queries ignore tag and attribute case, Python `__all__` respects module scope and complete static lists, and TypeScript declaration exports resolve through imports.
- Import resolution now preserves commented Python imports, nested Rust uses and confined `#[path]` targets, stylesheet-relative paths, and per-specifier type-only bindings. C/C++ typedef names survive nested declarators. Rust text recovery ignores macro bodies, and a Python import behind a multi-line conditional is not a module re-export.
- Module exports drop names declared inside a function body, lambda, or closure while keeping members of nested top-level types. C/C++ exports again include include-guarded declarations, plus namespace, template, and prototype declarations, and an aliased Rust `pub use` keeps the original member as its source.
- Links to registered alias files resolve, so an `<a href="page.xhtml">` target inside the project is a file edge instead of an external reference.
- Duplicate masking includes Ruby `load`/`autoload` and Zig `@cImport`, with native and fallback handling. Ruby literal `load` and `autoload` calls remain masked with trailing comments. Kotlin duplicate queries use the loaded grammar's `import` node.
- Java method-, constructor-, and lambda-local classes no longer publish module exports. Ruby extension aliases retain standard-library import classification.
- Rust path attributes now follow the declaring module's scope and inline directory, preserve `]` in path strings, and exclude visible test-only imports.
- TypeScript inline-only type imports have type-only graph edges, and reduced-mode re-exports retain type flags. C/C++ capture-only extraction keeps typedef names without leaking function-local or static exports.
- Python imports after same-line top-level assignments and calls remain module re-exports.
- Document links now exclude comments, front matter, conditional AsciiDoc content, image alt text, and indented code after thematic breaks or inside blockquotes. Nested lists and continuation links inside blockquotes retain their source coordinates. Two blank lines end list indentation, and unclosed HTML comments mask the remaining document.
- Native query caches are bounded and release per-language capacity on eviction. Fallback diagnostics distinguish unavailable parsers from empty queries, name each fallback extraction path, and warn when a source language has no native grammar. `codegraph doctor` lists supported graph-only languages.
- Go-to-definition and references now resolve C# local functions from sibling statements and Go generic type parameters within their own declaration. C++ nested namespaces and unions are type symbols, and C++ concepts and preprocessor macros bind in the same file.
- Standard-library imports are classified from every registered extension of a language, so `.csx`, `.ktm`, and `.pyi` files no longer report their standard library as unresolved.
- Rust file graphs resolve `#[path]` modules declared inside inline modules, omit `#[cfg(test)]` modules when another attribute follows, and resolve `super` from a path-attributed module relative to its declaring module.
- A C include macro no longer creates a dependency, `#include HEADER` resolves again, a Ruby `load`/`autoload` argument must be a complete literal to be masked from duplicate scans, and a qualified Python `case module.CONST:` value no longer creates locals.
- Python module-level import detection agrees between native and reduced extraction, including an import after a multi-line parenthesized statement. `.h` classification treats `class`, `template`, and similar words used as plain C identifiers as C.
- Import-binding extraction reports the same fallback reason as graph extraction, so `native: "off"` no longer reports reduced mode for a language without regex recovery.
- Rust graph extraction keeps conditional `#[path]` modules with the same module name distinct. TypeScript type-only imports tolerate comments and compact `type{...}` clauses, and C header classification recognizes function calls that use C++ keywords as C identifiers.

## [2.3.24] - 2026-09-10

### Fixed

- `codegraph duplicates` now reuses a fresh project index when its duplicate scan glob filters change.

## [2.3.23] - 2026-09-09

### Fixed

- `codegraph duplicates` now removes import declarations and directives from every supported import syntax before matching duplicate units.

## [2.3.22] - 2026-09-09

### Added

- Exported `orientCodegraphWithSession` and `getCodegraphPacketWithSession` from the public agent entrypoint (`@lzehrung/codegraph-core/agent` and `@lzehrung/codegraph/agent`) for shared-session orientation and packet retrieval.

### Changed

- Shortened the bundled Codegraph skill around agent tool choice, task order, and safety checks. Detailed command and server contracts remain in the CLI and MCP references.
- MCP `get_symbol` now resolves its target without computing discarded explanation context or re-reading SQL sources. Target matching and ambiguity handling are unchanged.

### Fixed

- Detailed call hierarchy edges now resolve direct identifiers through lexical scope at the callsite. Nested declarations and local bindings no longer incorrectly target same-named module locals or imports.
- The `release` action now moves `[Unreleased]` notes into the new version automatically and includes them in its release commit. A separate changelog preparation commit is no longer required.
- Indexed text search now ranks complete-term candidates before bounded partial candidates, so a later exact match is not hidden by path-ordered SQL retrieval. Search responses separately disclose bounded indexed-text candidate omissions and lower-bound counts.
- Long indexed-text queries no longer exceed SQLite parameter or expression-depth limits. Retrieval keeps all terms and prioritizes complete matches before capped partial matches.
- Changing or reordering resolution hints, TypeScript `baseUrl`/`paths` (including `extends`), or workspace package exports now keeps cached import targets and graph edges consistent. This also applies when `resolveNodeModules` is disabled. Existing affected caches rebuild before reuse.
- Type hierarchy now excludes generic arguments and enclosing-type qualifiers from inheritance edges. Generic and qualified Java superclasses now retain their `extends` edge.
- Long-lived agent sessions now detect configuration-only changes before reusing a snapshot. Resolution, language, discovery, and ignore-rule changes now report stale state or refresh automatically according to the session freshness policy. Failed configuration checks report stale state without repeated automatic rebuilds or raw filesystem paths in the reason. Freshness respects `useConfig: false` without ignoring language config or ignore files.
- Path-only search and session file discovery now track lightweight file signatures before full project loading, allowing file additions, deletions, and renames to refresh automatically without forcing semantic indexing. Freshness checks also detect deletions during initial signature capture.

### Security

- Updated transitive Hono to 4.13.7 to clear three production security advisories.

## [2.3.21] - 2026-09-05

### Fixed

- Whole-project `codegraph index` now reuses Git-aware incremental discovery instead of resolving and discarding a separate CLI file list.
- Git candidate discovery now remains enabled when the project root is also the gitignore root, avoiding a full filesystem walk for ordinary whole-project indexes.
- Published builds now start the configured native worker pool. The bundled CLI previously left `--workers` ineffective because Piscina could not locate its worker from esbuild's ESM output.
- `codegraph init` and `codegraph sync` name post-index work in progress output instead of appearing to hang after the build completes.

### Changed

- `--report` names incremental preamble and manifest substeps so cold-index time is attributable to file identity, config hashing, Git, cache, and manifest work.
- `codegraph init` and `codegraph sync` reuse the config hash that their index build persisted, avoiding a redundant hash within the same command.
- Index builds share config, source, and metadata discovery within one operation. Git-backed config hashing reads root manifests and applicable ignore files without a recursive config scan.

## [2.3.19] - 2026-09-04

### Fixed

- `callers` now reports method invocations on a proven receiver (`this.m()`, `$this->m()`, `self::m()`, `const l = new Lib(); l.target()`), including inherited members. `this`/`$this`/`self` walk `extends`, `implements`, `trait`, and `mixin`; `super`/`base`/`parent` follow class `extends` ancestors only. Those sites previously resolved through `goto` but stored no `calls` edge. An unproven receiver still emits no edge. Ruby `super` is a same-name keyword, not a receiver. Go receiver methods remain a documented gap because Go declares methods outside the receiver type ([#341](https://github.com/lzehrung/codegraph/pull/341)).

## [2.3.18] - 2026-09-04

### Changed

- Thin snapshot hydrate now expands star-kind imports after loading SQLite module bodies, then freezes the in-memory index. Disk cache rows are stored before that expansion, so skipping it made incremental updates throw when they tried to mutate frozen imports.
- Index manifests are now compact JSON. Pretty-print (`JSON.stringify(..., null, 2)`) made the on-disk index `manifest.json` larger without changing load, which uses `JSON.parse`. Pretty files from earlier versions continue to work.

## [2.3.17] - 2026-09-04

### Changed

- Incremental index updates now record `snapshot-write` in `--report` timings, matching the full-build persistence steps. A one-file refresh previously rewrote the whole project snapshot without naming or timing that cost.
- Project snapshots no longer embed every parsed module. Unchanged module bodies hydrate from the SQLite disk cache; JSON stubs and other non-cache rows stay in the thin snapshot. A one-file refresh no longer re-serializes the full module corpus. Version 10 snapshots that still embed module bodies continue to load.

## [2.3.16] - 2026-09-03

### Added

- `codegraph orient` now supports `--report` and `--report-file`, matching other agent commands.

### Changed

- `codegraph mcp serve` (and `codegraph server start`, which spawns it) now warms the base session cache at startup by default, matching the old `--warmup` behavior. Previously startup was lazy by default, so an agent's first MCP tool call paid for cold discovery and building; on a large project that could exceed a client's tool-call timeout before the server ever produced a result. Pass `--no-warmup` for the old lazy startup, or `--warmup-symbols` to also warm the detailed symbol graph. Programmatic callers that supply their own `session` to `serveCodegraphMcp`/`startCodegraphMcpHttpServer` keep the previous lazy default unless they pass `warmup` explicitly.
- The default MCP per-tool execution deadline (`mcpToolTimeoutMs`) dropped from 30 minutes to 5 minutes. A stuck tool call previously held its concurrency slot for up to 30 minutes; 5 minutes is generous for any real Codegraph query while surfacing a hang far sooner. This is independent of `httpBodyTimeoutMs` (still 30 seconds), which only bounds receiving the HTTP request body.
- Index builds now name each post-parse persistence phase (`Writing disk cache`, `Resolving workspace manifests`, `Writing index manifest`, `Finalizing project graph`, `Writing project snapshot`) instead of leaving progress frozen at the last file count once parsing finishes. `--report` timings now include a `steps` array covering `persist-cache`, `workspace-manifests`, `index-manifest`, `finalize`, and `snapshot-write` durations.
- Progress lines that carry a file count now show elapsed time for the current phase, for example `[Progress] Resolving workspace manifests: 41/41 files. (5s)`. Applies to both the interactive spinner and redirected log output.

### Fixed

- The `Writing disk cache` post-parse phase no longer reports or times a persistence step when the cache mode is not `disk`. Every cacheable file still produces a pending cache-write entry regardless of mode, so this phase previously fired (and misleadingly named itself "disk") even with `--cache off` or `--cache memory`.
- Reused `--report` objects no longer accumulate stale post-parse persistence steps (`persist-cache`, `workspace-manifests`, `index-manifest`, `finalize`, `snapshot-write`) from a prior build. A caller that reuses one `BuildReport` object across builds - for example an MCP session's `buildOptions.report` across `refresh_index` calls - previously saw these steps pile up in `timings.steps`.
- Redirected log progress no longer prints a duplicate line when a phase change and a milestone count land on the same update, for example printing only `[Progress] Writing disk cache: 41/41 files. (0ms)` instead of that line preceded by a separate `[Progress] Writing disk cache.` line.

## [2.3.15] - 2026-09-03

### Changed

- Cold index progress now names file-cache checks after discovery. The spinner used to stay on `Checking project metadata files` while Git signatures, SQLite cache probes, and worker startup ran, so a cold init looked stuck on metadata after file listing had already finished. `--report` timings now include `cacheProbeMs` and a `cache-probe` step.

### Fixed

- Project metadata discovery no longer realpaths every ancestor directory of Git-listed data files. Only directories whose names can be project metadata (`.idea`, `App.xcodeproj`) are probed.
- Reused `--report` objects no longer keep leftover `cacheProbeMs` after a later build skips cache probes.
- Windows CLI processes no longer abort after a successful warm `explore` on Node 24. The second query printed a valid result, then libuv asserted `UV_HANDLE_CLOSING` while sqlite, native, or worker handles were still closing and the process exited `3221226505`. The CLI now lets those handles finish closing before the process exits.

## [2.3.14] - 2026-09-03

### Fixed

- A persisted detailed symbol graph is no longer treated as corrupt because it contains extra edges beyond the basic graph. The second `explore` in the Windows package funnel rebuilt that sidecar, printed a valid result, then aborted during process teardown (`UV_HANDLE_CLOSING`).
- Git ignore-file listing no longer walks gitignored trees looking for nested `.gitignore` files. After Git lists tracked and untracked candidates, discovery stats `.gitignore` only on those files' ancestor directories. A Python repo with a large gitignored data tree timed out on `Listing Git ignore files` even though file listing had already finished, because `git ls-files --others --ignored` descended into that tree.

## [2.3.13] - 2026-09-02

### Added

- `--report` index timings now include optional `gitListMs`, `filesystemScanMs`, and a `steps` list of named discovery durations so a slow cold init can be diagnosed without guessing which listing hung. Reusing the same report object replaces `sourceDiscoveryMs`, `metadataDiscoveryMs`, and those listing fields for the current build instead of keeping leftover values from a step that did not run.

### Changed

- Cold discovery progress now names Git listing, ignore-file listing, and filesystem scan fallback. A long sit used to stay on `Discovering source files` until Git returned; the spinner now says which listing is running. A timeout during file or ignore listing warns before the filesystem scan and records that unfinished listing in `--report` `steps`. Timeouts from earlier Git probes do not record a `git-list` step.

## [2.3.12] - 2026-09-02

### Fixed

- Source discovery no longer stats every Git-listed file when looking for directory symlinks. A Python repo with thousands of JSON or CSV files paid one `lstat` per data file during the symlink probe; those files are skipped, while Git mode 120000 still screens extension-bearing directory links.

## [2.3.11] - 2026-09-02

### Fixed

- Disk cache no longer retries an unsupported `node:sqlite` runtime. Node builds below 22.16 load the module but omit statement APIs Codegraph needs, so a default-on disk cache previously reopened the database and printed a stack on every cache access. The run now disables disk cache after one in-memory probe and prints one warning.
- Package funnel install no longer hangs on Windows GitHub runners. Isolated npm used to install drive-qualified tarballs from a different volume through an empty cache, so Git tar treated the drive letter as a remote host and npm fetched every native platform packument until the 300s budget killed the job. The funnel now copies candidates onto the isolation volume, prefers the local cache, and restricts optional natives to the host OS and CPU.

## [2.3.10] - 2026-09-01

### Fixed

- Source and metadata discovery no longer resolve a physical path for Git candidates the project excludes. A project holding a large untracked or ignored tree, such as a Python virtualenv, paid one filesystem syscall per excluded file: a 20,000-file virtualenv spent 1.68s in discovery to return 7 source files, and now spends 0.48s.
- `orient`, `explore`, `search`, and other agent-session commands now report counted discovery work. Cold discovery previously printed one `Discovering source files` line and no further output until it finished, which was indistinguishable from a hang.
- `Built project index: N files in X` now measures the whole index operation, including discovery. It previously started timing at the first parsed file, so a build that spent minutes discovering files and seconds parsing them reported only the seconds.

## [2.3.9] - 2026-09-01

### Added

- `--dynamic-import-heuristics` now uses shared language adapters for top-level and embedded code, and Python dependency graphs can add heuristic edges for static-string `importlib.import_module(...)` and `__import__(...)` calls.

### Changed

- Header language classification no longer samples `.h` bytes when C and C++ would produce the same result, so native-worker eligibility and SQL corpus filters skip those reads.
- Query indexing, duplicate analysis, lazy symbols, and package-resolution paths classify from source text they already hold. Go, Java, and Kotlin package names reuse retained parsed source.

## [2.3.8] - 2026-08-31

### Changed

- Cold discovery progress starts before agent-session file planning, so `Discovering source files` appears before symlink and source-path checks. Warm full-cache checks stay quiet.

## [2.3.7] - 2026-08-31

### Changed

- Cold discovery lists `.gitignore` sources through Git instead of statting every candidate ancestor, and reports source and metadata discovery time when a caller supplies a build report.

## [2.3.6] - 2026-08-31

### Changed

- `orient` now lists each focus path once and gives one `codegraph packet get <path>` example.
- `explore` no longer repeats its first follow-up as `Recommended next:`.
- Top-level CLI help and agent guidance start with `orient`, then direct search and navigation commands.

## [2.3.5] - 2026-08-31

### Changed

- Clarified `explore` as one hybrid search plus context from top results, not a planner or runtime proof.
- Agent, CLI, MCP, and library guidance now prefer `orient`, search, references, and call hierarchy before `explore`.

## [2.3.4] - 2026-08-30

### Changed

- Cold index progress now identifies source and metadata discovery, with completed path-check counts when available.

### Fixed

- Release-candidate package funnels now skip lifecycle scripts while installing certified tarballs, avoiding Windows install timeouts.

## [2.3.3] - 2026-08-30

### Changed

- Release package smoke now inspects certified tarballs directly, reuses extracted file records,
  prefers the npm cache, and leaves temporary installs for ephemeral runner cleanup.
- Disk cache writes copy only module fields whose paths change; cache reads transform their
  private parsed payload in place instead of deep-cloning every module.
- Worker-eligible cold builds now construct reference bloom filters in native extraction workers,
  parallelizing identifier hashing instead of doing it on the main thread. Automatic native worker
  sizing now caps at eight threads and preserves system capacity by default.
- Native language extraction now attempts one parsed-tree traversal for imports, exports, locals,
  and import bindings. It keeps independent traversals when the combined query cannot safely run.
- Project metadata discovery now reuses the Git file listing that source discovery already
  produced and omits Git-ignored manifests. An explicitly requested Git-ignored root keeps the
  filesystem fallback and can return ignored metadata.
- Query index preparation now runs in-process for small batches and only starts a worker pool
  once a batch is large enough to amortize thread startup, so incremental updates and small
  projects no longer pay for spawning and tearing down worker threads. Hosts that resolve to a
  single worker always prepare in-process, since one worker pays the startup cost without
  parallelizing anything.

### Fixed

- Duplicate fingerprints no longer depend on the host Node build's Unicode version. The
  TypeScript tokenizer read Unicode property escapes while the native tokenizer is pinned to
  Unicode 16, so on Node builds carrying newer Unicode data the two disagreed on characters such
  as U+088F and the same file fingerprinted differently with and without the native addon. The
  TypeScript grammar now comes from generated ranges pinned to the native tokenizer's version,
  and the duplicate-unit cache revision moves with it so units tokenized by the previous grammar
  are recomputed rather than reused.
- `packages/codegraph-native/Cargo.lock` is committed instead of ignored, so the published native
  binaries build from a reproducible dependency graph.
- Windows package smoke forces drive-qualified tarball paths to be local archives, preventing
  Git for Windows tar from treating the drive letter as a remote archive host.

## [2.3.2] - 2026-08-28

### Changed

- Clean disk-cache builds now skip module lookups when the cache database does not exist, while
  preserving per-file miss accounting ([#302](https://github.com/lzehrung/codegraph/pull/302)).

## [2.3.1] - 2026-08-28

### Changed

- Release candidate assembly now runs only source-quality checks and one package build, leaving
  tests, security, fixture, and package certification to their dedicated release jobs
  ([#301](https://github.com/lzehrung/codegraph/pull/301)).

### Fixed

- The certified release workflow now generates and validates its final committed lock under Node
  22/npm 10, matching the minimum supported CI runtime
  ([#300](https://github.com/lzehrung/codegraph/pull/300)).

## [2.3.0] - 2026-08-28

### Changed

- MCP tool responses now use compact JSON, `explore` omits source by default, and follow-ups are
  deduplicated and limited to callable MCP tools
  ([#286](https://github.com/lzehrung/codegraph/pull/286)).
- CLI help and validation are grouped more clearly, dependency traversal is bounded by default,
  graph JSON is deterministic, and long index checks emit a delayed progress heartbeat
  ([#287](https://github.com/lzehrung/codegraph/pull/287)).
- Detailed graph cache comparison now avoids temporary edge maps and repeated string allocation
  ([#290](https://github.com/lzehrung/codegraph/pull/290)).

### Fixed

- Pinned standalone release-script lock generation and validation to npm 10.9.2.

### Removed

- Removed four unused low-level facade exports and added a deterministic snapshot guard for future
  public API changes ([#288](https://github.com/lzehrung/codegraph/pull/288)).

## [2.2.3] - 2026-08-28

### Changed

- Cold discovery now uses Git-aware file enumeration, cached repository facts, grouped ignore
  matching, and bounded symlink screening. On the measured Unreal project, discovery fell from
  26.1 seconds to 1.0-1.4 seconds with the same 3,841 files
  ([#293](https://github.com/lzehrung/codegraph/pull/293),
  [#297](https://github.com/lzehrung/codegraph/pull/297)).
- Project-local state now lives under one `.codegraph/` directory, with disk caches in
  `.codegraph/cache/index-v1/`. Existing project and repository caches migrate automatically
  ([#296](https://github.com/lzehrung/codegraph/pull/296)).

### Fixed

- Release commits now normalize and verify the exact lockfile immediately before staging it,
  preventing later manifest or publication steps from committing a host-pruned dependency graph
  ([#294](https://github.com/lzehrung/codegraph/pull/294)).

## [2.2.2] - 2026-08-27

### Changed

- Stabilized cache implementation fingerprints, reused hydrated snapshots without cloning, and
  reported cache invalidation causes more clearly
  ([#283](https://github.com/lzehrung/codegraph/pull/283)).
- Reduced index and navigation work while preserving nested tsconfig aliases and resolved re-export
  targets ([#292](https://github.com/lzehrung/codegraph/pull/292)).

### Fixed

- Restored optional emnapi lockfile entries required by clean installs and added a pre-publication
  `npm ci` lockfile gate
  ([#289](https://github.com/lzehrung/codegraph/pull/289),
  [#291](https://github.com/lzehrung/codegraph/pull/291)).

## [2.2.1] - 2026-08-27

### Fixed

- Corrected Markdown link checks for aliased project roots and kept cached symlink hints confined to
  the requested root.

## [2.2.0] - 2026-08-26

### Added

- Added `codegraph server start|status|stop` for one project-local, loopback-only MCP HTTP server,
  with health checks, per-user credentials, startup diagnostics, and explicit restart behavior
  ([#281](https://github.com/lzehrung/codegraph/pull/281)).

### Changed

- Added columnar native syntax-tree encoding and removed a redundant parse
  ([#276](https://github.com/lzehrung/codegraph/pull/276)).
- Reduced native addon loading, hashing, and worker startup on warm and incremental runs, and removed
  cached addon versions unused for one month
  ([#278](https://github.com/lzehrung/codegraph/pull/278)).
- Enforced `@typescript-eslint/no-unused-vars` as an error with `^_` ignore patterns.

### Removed

- Removed the inert non-native parser seam, unread extraction parameters, and leftover declarations
  that no code used. Existing caches rebuild once after the fingerprint change
  ([#277](https://github.com/lzehrung/codegraph/pull/277)).

### Fixed

- Removed an unreachable `parseAgentSqlHandle` branch that could have skipped decoding.
- Retried transient Windows filesystem failures during standalone installation and restored a
  clean-installable npm lockfile.

## [2.1.2] - 2026-08-19

### Fixed

- Repaired CLI and artifact contracts: SQLite artifacts tolerate unsigned nodes, validation errors consistently use exit code `2`, documented MCP idle timeout parsing works, and graph output/cache options are applied consistently ([#269](https://github.com/lzehrung/codegraph/pull/269)).
- Restored TSX, Python package, JVM, inherited-tsconfig, Unicode search, and rename-preview semantic behavior; agent outputs now preserve freshness and bounded-result metadata ([#270](https://github.com/lzehrung/codegraph/pull/270)).
- Made MCP malformed input, unknown tools, cancellation, HTTP concurrency, artifact serialization, and SQLite authorization report correct, safe protocol behavior ([#271](https://github.com/lzehrung/codegraph/pull/271)).
- Corrected impact/review severity, omissions, truncation, fan-out, and Git-diff handling; hardened portable cache, sidecar, worker, and query-index behavior ([#272](https://github.com/lzehrung/codegraph/pull/272), [#273](https://github.com/lzehrung/codegraph/pull/273)).
- Hardened resumable release publication, installer rollback and TOML ownership, native staging, and CI contract coverage ([#274](https://github.com/lzehrung/codegraph/pull/274)).
- Allowed recursive read-only SQLite queries without permitting writes.

## [2.1.1] - 2026-08-19

### Fixed

- Made cache identities root- and implementation-aware, prevented stale cross-project reuse, and kept resolver, native, and query-index caches valid across updates ([#261](https://github.com/lzehrung/codegraph/pull/261), [#268](https://github.com/lzehrung/codegraph/pull/268)).
- Stabilized CLI output and public API documentation, restored parsed-cache insertion, and improved impact/review result accuracy ([#253](https://github.com/lzehrung/codegraph/pull/253)).
- Preserved Unicode identifier behavior in duplicate fingerprints and navigation, and bounded MCP body/session/query resources.

## [2.1.0] - 2026-08-14

### Changed

- Published certified packages through npm trusted publishing and made public npm installation the primary documented workflow ([#249](https://github.com/lzehrung/codegraph/pull/249)).

## [2.0.6] - 2026-08-11

### Fixed

- Corrected cache identity and project confinement, cross-language semantic resolution, impact ranking, capped-result metadata, and native CI coverage across the full-system review ([#246](https://github.com/lzehrung/codegraph/pull/246)).

## [2.0.5] - 2026-08-11

### Changed

- Discounted medium-confidence member references in impact/review risk ranking and reported limited member-resolution coverage ([#245](https://github.com/lzehrung/codegraph/pull/245)).

## [2.0.4] - 2026-08-10

### Added

- Added navigation, graph, and type-hierarchy coverage for class fields, Java/C# records, PHP/Ruby inheritance, Python match bindings, Rust grouped imports, Go embedding, and several SQL, RST, AngularJS, Swift, and C# constructs ([#237](https://github.com/lzehrung/codegraph/pull/237), [#238](https://github.com/lzehrung/codegraph/pull/238), [#239](https://github.com/lzehrung/codegraph/pull/239), [#240](https://github.com/lzehrung/codegraph/pull/240), [#241](https://github.com/lzehrung/codegraph/pull/241), [#242](https://github.com/lzehrung/codegraph/pull/242), [#243](https://github.com/lzehrung/codegraph/pull/243), [#244](https://github.com/lzehrung/codegraph/pull/244)).

## [2.0.3] - 2026-08-09

### Added

- Accepted qualified symbol paths in navigation commands ([#236](https://github.com/lzehrung/codegraph/pull/236)).

## [2.0.2] - 2026-08-09

### Fixed

- Included the core package in standalone releases and documented core-library workflows.

## [2.0.1] - 2026-08-09

### Fixed

- Certified planned release package versions before publication.

## [2.0.0] - 2026-08-09

### Added

- Published `@lzehrung/codegraph-core` as the slim library install (graphs/indexer/impact/agent helpers) without MCP SDK, installer-only deps, or viewer/skill assets.

### Breaking Changes

- Narrowed the root `@lzehrung/codegraph` export to core library primitives (indexing, graphs, impact, `CodeReviewSession`, SQLite/SQL, chunking, duplicates, drift, review, config, languages, native checks, and indexer `query*` aliases).
- Moved agent-shaped APIs (`createAgentSession`, explore/orient/search/explain/packet/file-view helpers, semantic hierarchy/rename/refactor helpers, and `tool_*` wrappers) to `@lzehrung/codegraph/agent`.
- Moved MCP handlers/server (`createCodegraphMcpHandlers`, `listCodegraphMcpTools`, `serveCodegraphMcp`) to `@lzehrung/codegraph/mcp`.
- Stopped exporting `formatAgentFollowUpAsCli` / `formatAgentFollowUpsAsCli` from public package entry points.
- Relocated package identity helpers from `src/cli/package-info.ts` to `src/util/package-info.ts` (internal path only).

### Migration

- Library-only consumers should install `@lzehrung/codegraph-core` (and its `./agent` subpath) instead of the full CLI/MCP package.
- Replace root imports of agent APIs with `@lzehrung/codegraph/agent` or `@lzehrung/codegraph-core/agent`.
- Replace root imports of MCP APIs with `@lzehrung/codegraph/mcp`.
- Import `toolFollowUp` / `AgentFollowUp` from the agent entrypoint when needed; do not depend on CLI follow-up string formatters.

## [1.8.111] - 2026-08-05

### Added

- `codegraph viewer` can load a current project graph automatically through the validated disk cache, without requiring an exported JSON file first ([#209](https://github.com/lzehrung/codegraph/pull/209)).

## [1.8.110] - 2026-08-04

### Changed

- Migrated the MCP server runtime to the Model Context Protocol TypeScript SDK v2 ([#208](https://github.com/lzehrung/codegraph/pull/208)).

## [1.8.109] - 2026-08-04

### Changed

- Improved graph viewer selection usability ([#206](https://github.com/lzehrung/codegraph/pull/206)).

## Earlier releases

See the [GitHub Releases](https://github.com/lzehrung/codegraph/releases) page for certified package versions, native package counterparts, checksums, and standalone preview assets.

[Unreleased]: https://github.com/lzehrung/codegraph/compare/v2.4.0...HEAD
[2.4.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.4.0
[2.3.31]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.31
[2.3.30]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.30
[2.3.29]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.29
[2.3.28]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.28
[2.3.27]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.27
[2.3.26]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.26
[2.3.25]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.25
[2.3.24]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.24
[2.3.23]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.23
[2.3.22]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.22
[2.3.21]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.21
[2.3.19]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.19
[2.3.18]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.18
[2.3.17]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.17
[2.3.16]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.16
[2.3.15]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.15
[2.3.14]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.14
[2.3.13]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.13
[2.3.12]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.12
[2.3.11]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.11
[2.3.10]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.10
[2.3.9]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.9
[2.3.8]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.8
[2.3.7]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.7
[2.3.6]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.6
[2.3.5]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.5
[2.3.4]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.4
[2.3.3]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.3
[2.3.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.2
[2.3.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.1
[2.3.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.3.0
[2.2.3]: https://github.com/lzehrung/codegraph/releases/tag/v2.2.3
[2.2.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.2.2
[2.2.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.2.1
[2.2.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.2.0
[2.1.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.2
[2.1.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.1
[2.1.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.1.0
[2.0.6]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.6
[2.0.5]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.5
[2.0.4]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.4
[2.0.3]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.3
[2.0.2]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.2
[2.0.1]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.1
[2.0.0]: https://github.com/lzehrung/codegraph/releases/tag/v2.0.0
[1.8.111]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.111
[1.8.110]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.110
[1.8.109]: https://github.com/lzehrung/codegraph/releases/tag/v1.8.109
