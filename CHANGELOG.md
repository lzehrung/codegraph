# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

GitHub Releases remain the certified publish record. This file summarizes product-facing changes so the repository itself has a readable history.

## [Unreleased]

### Fixed

- Swift go-to-definition, references, call edges, and impact again resolve a call on a concrete type to the witness or override when its parameter type spells an associated type, `Self`, or a generic parameter differently from the requirement or base member (`put(_ i: Int)` for `put(_ i: Item)`, `same(as other: V)` for `Self`, `add(_ x: Int)` for `Base<T>`, including an override in a further subclass). A same-name overload whose parameter type is a different concrete type still competes. A keyword in a declaration header, such as `func` next to `var count` and `func count(of:)`, names that declaration instead of a same-named property.
- Swift member lookup reuses shared-owner paths and extension constraints within an index instead of rebuilding them at every call site, without changing navigation, references, or detailed graph edges.
- Swift protocol witness rename previews now remain unsafe when the complete requirement or default linkage is unproven, and unrelated Swift calls no longer degrade other languages' reference coverage.
- Swift navigation, references, and detailed graphs now distinguish argument labels, resolve nested type constructions and protocol defaults, and honor private member visibility. Contextual enum cases and leading-dot static members (`OptionSet` constants, static functions and variables) resolve from declared types, `self`/`Self`, call parameters, returns, assignments, switch subjects, and comparisons when the context is proven. Calls with defaults before required parameters, trailing closures (also after `await`), or variadics keep their targets, a parameter list with a parse error never rejects its callable, a subscript is no longer a call edge, and a receiver spelled like its member (`lock.lock()`) adds no call edge to the receiver variable.
- Swift calls keep a lone same-name function or member as the target when its argument count or labels do not fit, through `self`, `super` (labels only), an implicit receiver, a typed value, or a type, whether it is declared on the receiver's type or inherited from a base class, so impact analysis still reports a changed signature or label rename. A wrong label rejects a candidate only when overloads at the nearest declaring level compete; when the labels fit none of them, the overload whose argument count fits is chosen, and the call stays unresolved when the count does not single one out. A leading-dot call (`.make(1)`) resolves to a static function or a function-valued variable, never to a variable that holds a value; a call edge to a property is recorded only when its declaration is a function type or closure; and a pattern, condition, or closure binding that a bare read may name no longer resolves to a same-named property or method.
- Swift conformances, inheritance clauses, and type annotations that name a type with extensions now resolve to the type's declaration, including a `private` or `fileprivate` type in its own file, instead of staying unresolved or naming an extension header. An extension header is no longer a member of its type, so the extended type's name inside its own extension no longer resolves to that header when the project does not declare the type.
- Ruby: `attr_reader`, `attr_writer`, and `attr_accessor` in a class or module body declare the methods `name` and `name=` at their symbol or string argument, so `goToDefinition`, `findReferences`, and detailed call edges reach them as they reach a `def`. A bare name or a `self.name` reaches a generated method only inside an instance method of its own class or module (including `def` inside ordinary blocks such as `class_eval` or `.each`), so a sibling class, a singleton method, a `class << self` body, a class body, a nested class, a reopened `class` body, and `Struct.new` / `Class.new` / `Module.new` / `Data.define` / `instance_eval` / foreign-receiver `class_eval` blocks in the same file never bind it, and a constant receiver (`Acc.name`, `Acc.name = value`) reaches none of them: a singleton `def self.name` of the same name does, through the constant and through `self` in a singleton method. A name that the method binds before the use is a local and hides the method: the name of a parameter of the method, a block, or a lambda; a pattern binding (`case ... in`, `value => pattern`, `value in pattern`); a named regexp capture; and the target of any assignment, `for`, or `rescue => name`. What a block or a lambda binds ends with it, so a use after it reaches the reader again. The later of a `def` and an `attr_*` of one name wins, as in Ruby: a `def` after the call replaces the generated method, and one before it is replaced by it for bare uses, `self.`, receiver calls, and call edges. `findReferences` on a generated method lists only proven receiver sites and reports the coverage a `def` of the same shape reports.
- Ruby: `self.name = value` and `object.name = value` call the writer `name=`, not the reader `name`, in navigation, references, and detailed call edges. A compound assignment (`+=`, `||=`) still names the reader.
- Ruby: `findReferences` finds the uses of methods named with `?` or `!` (`ready?`, `save!`). Before, the reference prefilter probed the whole spelling, which no file holds as one token, and skipped every file. `ready` and `ready?` stay distinct methods, and a caller that never requires the declaring file keeps `partial` coverage for them.
- `codegraph init` and `codegraph sync --init` in a Git subdirectory warm the same cache that later commands reuse, without leaving an unused cache namespace at the repository root.
- TypeScript, TSX, and JavaScript private class names now resolve lexically in navigation, references, and detailed call edges, including nested classes, overloads, and brand checks. Rename previews require the `#` prefix and report private-name collisions and capture.
- C# global namespace, alias, and static usings now apply across their nearest project in navigation, references, and detailed graphs, including literal project and Directory.Build.props `Using` items with XML preambles or child metadata. Using-only edits retain source modules, with shared compilation lookup indexes and stat-validated metadata snapshots. C# and Java record-body members stay out of namespace/package exports.
- The MCP HTTP server now requires `@hono/node-server` 2.1.6 or later, which fixes a process crash on a reset socket during a WebSocket upgrade (GHSA-qv5m-9pm6-hqp3) and backslash path parsing that could bypass path-based access control at a reverse proxy (GHSA-jpvv-r467-5p4w).
- The MCP HTTP server now requires `hono` 4.13.16 or later, which fixes middleware bypasses through `mount()` and the RegExp router (GHSA-4m76-xfj5-7975, GHSA-h7mg-cq63-vhpq), a `csrf()` gap for hyperlink-auditing requests (GHSA-46wx-v44x-9hh2), skipped `multipart/form-data` validation (GHSA-4h7h-rv7c-7m2v), and unescaped closing tags in the `css` helper (GHSA-3gg2-335m-rxc6).
- TypeScript and TSX now parse adjacent generic call signatures without semicolons, so a later type alias resolves in go-to-definition and references instead of disappearing under a parse error. Split generic methods, including optional/modified signatures and decorated or static class methods, keep their callable identity and argument counts instead of selecting an inherited namesake or becoming a field; construct signatures and invalid class-method modifiers are not recovered as methods. Cross-file navigation, references, detailed calls, and rename edits retain the own declaration; interface rename previews remain safe, while class recovery keeps references partial and rename unsafe because of a missing-name parse error. Ordinary property signatures are unchanged, and both cached indexes and search-sidecar chunks rebuild with the pinned grammar.
- Parse-recovery declarations with missing names no longer produce empty-named symbols.
- PHP function and method calls ignore declaration letter case, namespaced class uses choose the right class, `parent::` calls reach ancestor methods, and using classes resolve ordinary trait methods and uniquely composed promoted properties. Full-project `use` declarations retain their imported targets. Abstract trait requirements defer to concrete class or parent methods; adapted trait calls cannot fall through to a same-named inherited method. Multiply used trait properties stay conservative.
- PHP adapted trait uses retain their hierarchy and unaffected methods, including in subclasses and `parent::` calls. Unproven adaptations keep inherited-decoy renames unsafe, and trait-body calls to abstract methods retain matching navigation, reference, and call-graph targets.

## [3.2.1] - 2026-11-11

### Added

- `codegraph uninit --purge` also removes the disk cache and server log. It refuses while a shared server is registered (run `codegraph server stop` first) or when run from inside `.codegraph/`, and lists paths it cannot remove. JSON `uninit` results add `removedEntries`.
- Purge only removes `<root>/.codegraph/`, leaving caches configured with `--cache-dir`, `CODEGRAPH_CACHE_DIR`, or the user cache location. Other projects' cache namespaces under this `.codegraph/cache/` are removed and rebuild on next use.

### Changed

- `codegraph init`, `status`, `sync`, and `uninit` without a path or `--root` use the nearest initialized parent directory, or the project that owns the `.codegraph/` directory or cache they run in. The search stops at a Git repository, home, or filesystem-root boundary. An inaccessible current directory reports an error and asks you to `cd` to the project directory.

## [3.2.0] - 2026-11-10

### Changed

- Cold C#, Java, and Kotlin builds reuse native worker extraction trees for namespace and package scans instead of parsing indexed files again on the main thread. Unindexed scan candidates use facts-only worker tasks.
- Kotlin detailed-graph builds reuse extension scope and receiver proofs and record trailing-lambda call shapes during collection, avoiding repeated candidate scans without changing resolved edges.
- The certified `release` workflow starts one empty job on every runner label it and `standalone-release` use before planning the release. A label GitHub has retired stops the run within minutes with an error naming the files to update, instead of failing one build while the other jobs run on. darwin-arm64 builds, smoke checks and funnels run on `macos-15`, since GitHub retired `macos-14`.

### Fixed

- Kotlin implicit receiver calls no longer fall back to a same-named global function when an extension applies. Single upper bounds and exact-type external receiver extensions retain their calls, and trailing lambdas exclude overloads with incompatible final parameters across navigation, references, and detailed graphs.
- Python annotated parameters retain calls to methods of a class in the same file, while shadowed imports and generic type parameters remain excluded.
- Native syntax lookups now select the node starting at a shared boundary instead of the preceding node that ends there, restoring go-to-definition, references, and detailed call edges for later members of minified JavaScript and TypeScript class expressions.
- Kotlin extension accessors no longer call a same-named non-invokable property or an extension on the wrong receiver type. Calls respect argument counts, and receiver type positions prefer a type declaration over a same-named factory, keeping navigation, references, and detailed call edges consistent.
- `findReferences` stays `partial` when a Kotlin class names its base through a qualified type (`class Q : Outer.Nested`) and calls `super` or an inherited member that `goToDefinition` cannot resolve. The omission proof no longer binds the qualifier `Outer` as the base, so the open call is not dropped from a `complete` result beside a resolved call in another class.
- A Kotlin function-type supertype (`class H : (Event) -> Unit`, `class S : suspend () -> Unit`) records no hierarchy edge. Its parameter and return types were read as supertypes, so `buildSymbolGraphDetailed` recorded `H -implements-> Event` and `implementations` of `Event` listed `H`; go-to-definition and the heritage proofs skip them too. A class that combines a function type with a real base class keeps its `extends` edge and `super` resolution; cached graphs rebuild.
- A Kotlin class that declares only secondary constructors (`class V : Base { constructor() : super(1) }`, common in Android views) records `extends` for its base class instead of `implements`, so `supertypes` reports the base as `extends` and `implementations` of a concrete base returns `unsupported_target` instead of listing the subclass. Such a bare entry is decided by the declaration it resolves to (a class `extends`, an interface `implements`); a typealias, a qualified name, or an unresolved base records no edge. `super.run()` in such a class now resolves in `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed` alike, and Kotlin `super` finds the base class wherever the base list names it (`class Y : Marker, Base()`), where references used to report complete coverage without that call.
- Ruby qualified namespace reopenings resolve their root before looking up nested bases. Python dotted imports respect the receiver's binding at each use, and imports in other functions no longer hide package-attribute references.
- A qualified base class resolves through its qualifier, never by its last name or by the qualifier itself. `class W(other.Base)` (Python), `class W < Other::Base` (Ruby), `class W: Other.Base` (Swift), `class W : Outer.Base()` (Kotlin), an embedded `other.Base` (Go), and `class W extends ns.Base` (JavaScript) no longer add an edge to a same-named class beside them, to the module's first export, or to the enclosing enum or class, so `supertypes`, `findImplementations`, `goToDefinition` on `self.shared()`, `findReferences`, and call edges follow the real target. A qualifier no project file declares (`django.db.models.Model`, `ActiveRecord::Base`, `UIKit.UIView`) records no edge, and `goToDefinition` on the last name of a Ruby constant under an undeclared qualifier, or of a Swift type no nested declaration proves, reports `not_found` instead of binding a bare namesake. Python module attributes, Ruby constant paths, and Java and Kotlin bases reached through a package or an enclosing type (`extends other.Base`, `class W : Outer.Base()`) now count as known bases for member navigation, so `goToDefinition` on an inherited call and `findReferences` follow them instead of reporting complete coverage after dropping the call. A Ruby constant path is searched through the modules around the class, as Ruby does (`Inner::Base` inside `module Outer` finds `Outer::Inner::Base`, `::Base` is always the top-level class, and `self::Base` belongs to the enclosing module), and a Ruby superclass chosen by a ternary records no edge instead of binding one branch. A Swift base nested in an extension or a generic owner stays unproven in member navigation; older caches rebuild.
- A Python `import pkg.mod` binds the package `pkg`, so `pkg.helper()`, `pkg.Thing()`, and `class W(pkg.Base)` resolve in `pkg/__init__.py` and `pkg.mod.helper()` in the submodule. Every spelling read the leaf module `pkg/mod.py` before, so a name only the submodule declares (`pkg.mod_only()`) resolved and a name the package declares (`pkg.helper()`) bound the submodule's namesake. `goToDefinition`, `findReferences`, call edges, and base lists now agree; `pkg.mod_only()` is `not_found`, `pkg.sub.helper()` after `import pkg.sub.mod` reads `pkg/sub/__init__.py`, `pkg.mod` is the submodule even when `pkg/__init__.py` declares a `mod` of its own (the import rebinds that attribute), and a package without an `__init__.py` names only its submodules; older caches rebuild.
- A base-list entry that calls something (Python `class A(make_base())` or `Manager(BaseManager.from_queryset(QuerySet))`, Ruby `class A < Other.const_get(:Base)`, `Struct.new(...)`, or `Class.new(Base)`) records no edge from its callee chain or its arguments, and the heritage stays unproven (`partial` reference coverage), instead of binding the receiver or an argument as a base class.
- C# bare and dotted names follow enclosing-type and namespace lookup order, including nested types from other partial parts, project base classes, and `using static` directives. At each namespace level, its own members (the global namespace's types included) precede its usings, and a bare name never binds a generic type of that name. Ambiguous type roots stay unresolved with partial reference coverage and no false namespace reference or call edge, but an unprovable partial-part scan or an unreadable project file no longer unbinds ordinary type names. Aliases and `global::` qualification retain their targets.
- C# receiver types such as `Prompt<T>` and `Prompt<int>` bind the declaration with the matching generic arity. `goToDefinition` and `findReferences` retain their method and property uses consistently with detailed call edges; a bare name without type arguments still does not bind a generic-only type. A generic parameter list split from its declaration by preprocessor directives stays unresolved when the native grammar cannot read its arity.
- Kotlin callable references no longer pick a method when a same-named property could be referenced; `goToDefinition` reports `not_found` and `findReferences` reports partial coverage. Calls to a function-valued property beside a same-named method select the property when its declared function type or initializer proves the call, including in `buildSymbolGraphDetailed`; Java method references still select methods.

- `super`, `this`, and bare member calls inside a Java or PHP anonymous class, a Kotlin object expression, or a JavaScript or TypeScript class expression resolve through that body's own members and base type instead of the enclosing type's, so `super.read(...)` in `object : ForwardingSource(source) { ... }` reaches `ForwardingSource.read` in `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed`. The enclosing type's `super` still names its own base, and a name the body lacks continues to the enclosing type. Members declared in such a body no longer count as members of the enclosing type, so `registry.handle(...)` no longer binds to the `handle` of an anonymous object inside `Registry`. A JavaScript or TypeScript base named by a parameter (`(Base) => class extends Base { ... }`) is unproven instead of resolving to a same-named class, and class expressions gain the `calls` edges that goto already followed. When a Java, Kotlin, or C# type declares both a field or property and a method of one name, a call (`delegate().read(in)`) binds the method and a plain read (`delegate != null`, `this.size`) binds the field or property. Java method references (`this::size`) bind the method; Kotlin callable references remain ambiguous when both exist. Older caches rebuild.
- AngularJS `templateUrl`, controller, and dependency-injection graph edges now agree between cold builds, disk/memory incremental updates, and full `collectGraph` calls. Registration changes, deletions, and additions update unchanged references instead of leaving stale or external targets. Typed, optional, defaulted, and rest DI parameters use syntax names rather than annotation text; destructuring adds no injected name. Sources over the native 8 MiB parse limit retain string-based AngularJS edges even under workers but omit function-parameter injection names.

- `buildProjectIndexIncremental` and agent sessions now see the changes Git's diff omits: edits to, deletions of and reversions of tracked files flagged `assume-unchanged` or `skip-worktree`, including a flagged file that was absent from the index and later reappears, and a revert after the flag is cleared (`git sparse-checkout add` clears it, which now indexes the files it brings back); edits, deletions, additions and restorations of files inside a submodule, which a diff reports as one gitlink; and a case-only rename (`Foo.ts` to `foo.ts`, a directory, there and back, also inside a submodule, and a spelling that only the index changes after a branch switch or `git reset --hard`) on a case-insensitive file system, which no longer keeps the old spelling or both spellings in the cached index. Manifests record the flagged files from the update's own listing. Each Git signature now carries the file's raw size, so an eol-only rewrite that `core.autocrlf` or `text`/`eol` attributes make Git report clean no longer reuses a module or graph entry extracted from other bytes whenever an update compares signatures (memory caches always do); an eol-only rewrite of an otherwise unchanged file is still noticed only when that file changes again or on a cold build. A file that is not valid UTF-8 gets the same Git signature from `buildProjectIndexFromFiles` and the incremental builders, so they share cached modules. An update spawns no Git child beyond the one listing that already named the untracked files, and a dirty submodule adds up to three. Flags set in a submodule's own index are still not seen; `cache: "off"` and `cacheStrict` rebuild without these limits (see `docs/how-it-works.md`). Older caches rebuild.
- Kotlin extension-function bodies and parameter defaults, and extension-property accessors, resolve bare and `this` calls (`this@name` included) through their extension receiver before enclosing and file-level decoys. Receiver lookup also finds accessible extensions declared in other files, including imports and same-package peers, and keeps references and detailed call edges consistent. A plain property of the receiver that no call can invoke (`val size: Int`) passes the call to an extension of that name in scope on the receiver.
- A Kotlin bare call inside a lambda with an implicit receiver (`build { emit() }`, `x.apply { }`, `with(x) { }`, a `Builder.() -> Unit` parameter, also through a `typealias`) binds to a member of that receiver before a member of the enclosing type in `goToDefinition`, `findReferences`, and the detailed graph. `let`, `also`, `forEach`, a bare `run { }`, and `(T) -> R` parameters keep the enclosing member. When the receiver's members are unknown (the trailing lambda of an unresolved callee, an external receiver type, a supertype outside the project), a call that would bind to a type member has no target and its references are `partial`, which removes self-recursive edges from forwarding wrappers such as `delegate?.forward { flush() }`. An explicit `this.m()` inside such a lambda binds to the lambda's receiver, and `this@Owner.m()`, `this@build.m()`, and `this@label.m()` bind to the labeled type or lambda, instead of the enclosing type or `not_found`.
- Kotlin lambda receivers bind only what the call can reach and what the callee proves. A `private` member of another class, a `protected` member the calling class cannot reach, an extension that is not imported or in the package, a plain property a call cannot invoke (`val size: Int`), and any member of a nullable receiver (`Builder?.() -> Unit`) no longer bind ahead of the enclosing type's member. The trailing lambdas of `launch`, `async`, `runBlocking`, `withContext`, `flow`, `buildList`, `buildString`, `sequence`, `Runnable { }` and the other kotlinx.coroutines, standard library, and JDK SAM callees leave a name their receiver does not declare to the enclosing type, while a name it declares stays unproven. `execute { }` and `submit { }` take a plain lambda only on a proven JDK executor, a callee that `goToDefinition` cannot choose among (overloads, an extension on an implicit receiver) is decided by its same-named project declarations when they agree on the lambda's receiver, and `this@extensionFunction` names the extension's receiver type.
- A stray `$` before a keyword-prefixed name that continues with non-ASCII decimal digits (such as `$as` followed by Arabic-Indic digits) no longer stalls Kotlin indexing. Tree-sitter error recovery ran for 15 to 100 seconds on a 225-byte file and built a tree too large to project, so the file was not indexed; it now parses in milliseconds with one `ERROR`. Error recovery no longer reads the rest of a file as one token, so the declarations after a Kotlin syntax error are usually read and found by imports, navigation, and references: an error inside a function, class, or lambda body recovers there and leaves the file complete, only an `ERROR` at the top of the tree marks it incomplete, and any parse error keeps the references that scan it `partial`. An unterminated string still takes the rest of the file, and rare broken shapes, such as a deleted `)` or `}`, can recover fewer declarations than before while most recover more; cached index data of Kotlin files rebuilds once.
- A C#, Kotlin, Java, TypeScript, or Go interface that extends or embeds another interface records `extends`, never `implements`, so `implementations` of the parent returns the concrete types that implement the child and not the child interface, and `supertypes` lists the parent. Java and TypeScript interface `extends` lists, which recorded no edge, now record one, and receiver navigation, references, and call edges follow them, so `c.run()` on a child-interface receiver reaches the parent member instead of reporting complete references without it. A C# class, struct, or record names an interface declared in another file with `implements` (it read `extends`), and Kotlin interfaces are interface-kind graph symbols, so an interface nobody implements returns an empty `implementations` result instead of `unsupported_target`. A type's base clause is read from its own declaration, so an enclosing type no longer inherits a nested type's or an anonymous body's base clause or a call's arguments (a `super` call inside an anonymous object or class therefore stays unresolved), and a TypeScript namespace-qualified heritage type (`implements ns.Contract`) adds no edge instead of binding a same-named local; cached graphs rebuild.
- C# member lookup follows an interface's base interfaces again: `c.Run()` on an `IChild` receiver, or `this.Run()` in its default method, resolves to the `Run` that `IParent` declares instead of `not_found` while the detailed graph already recorded the call. A class still exposes only its base class chain, an overload that two base interfaces both declare stays ambiguous, and an interface's inherited member still cannot hide a `using` alias.
- Kotlin, C#, Go, Java, TypeScript, TSX, Rust, Swift, Python, and C++ no longer let a generic type parameter stand for a same-named class. `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed` resolve `val t = T(); t.hello()` to the imported class even when a function declares `<T>`, and a receiver typed by the type parameter gives no member target or call edge. Go receiver parameters and shared constraints (`func (b Box[T])`, `[K, V I]`) follow the same rule.
- C++ template parameters no longer hide a same-named class or value outside their `template_declaration`. Bare-name navigation and references bind type, constrained, defaulted, variadic, and non-type parameters inside the template and the enclosing name elsewhere, including C++ headers; an unnamed non-type parameter does not invent a declaration for its type, and an inner template-template parameter does not reach its containing class body. Template functions and types remain visible by their own names.
- `buildProjectIndexIncremental` detects tracked files restored to committed content and indexed edits reverted to `HEAD`, including alongside other edits or after a new commit. Git-backed updates reconcile manifest signatures with index blob ids without hashing unchanged files; restored import bindings and graph edges match cold builds on disk and memory caches.
- `buildProjectIndexIncremental` detects tracked files restored to committed content and indexed edits reverted to `HEAD`, including alongside other edits or after a new commit. Manifests retain previously dirty tracked paths so clean warm updates skip blob listings, while changed files reuse Git index blob ids without hashing unchanged files. Restored import bindings and graph edges match cold builds on disk and memory caches; older caches rebuild.
- `buildProjectIndexIncremental` detects ordinary tracked-file restorations and edits reverted to `HEAD`, including plan reuse, unborn repositories and explicit Git ranges. Direct disk/memory builds and whole-project agent sessions refresh restored modules and importers consistently with cold builds, even when every retained file changed. Manifests record discovery-matching dirty paths after file reads, against a commit or the empty tree; clean warm updates skip blob listings, unchanged staging avoids reparsing, and older caches rebuild. Remaining Git fast-path limits are documented in `docs/how-it-works.md`.
- `listChangedFiles` confines Git change paths to the requested project root, including nested roots and directory aliases. `buildGraphDelta` and CLI `graph-delta` include restored tracked files and newly untracked source files in their changed-file and own-edge results.
- PHP `use` imports no longer bind a plain, PSR-0, or PSR-4 path whose fully parsed file lacks the qualified declaration of the requested kind. Renaming a declaration away and back updates cold, disk, and memory indexes consistently; namespace-prefix aliases and fallback paths for unreadable, unparsed, or syntactically incomplete files remain supported across cache reloads. Declaration proof reuses each indexed file's native extraction or cached own-file facts and collects namespace regions in one tree pass instead of rescanning the root per declaration.
- Incremental indexing restores Java, Kotlin, C#, PHP, and C++ import bindings when an existing file declares their target again. Rechecks use newly declared names only, so body edits do not revisit unrelated external imports; navigation, references, and detailed graphs match cold builds.
- Kotlin and Java resolve qualified types and Kotlin qualified constructors to their proven declarations instead of same-named imports; value bindings no longer hide package-qualified types or Java constructor types. Kotlin detailed graphs retain imported extension-function alias uses on value receivers. C# qualified type uses no longer create a bare-import edge.
- Disk-cache `buildProjectIndexIncremental` and `buildGraphDelta` bind Java, Kotlin, C#, and C++ imports that a deleted or renamed duplicate declaration left ambiguous, and make them ambiguous again when the duplicate returns; PHP imports follow the first declaring file as a cold build does, including after a namespace-only move or a syntax-error change. Rechecks name only the declarations a build removed or added, so body edits still visit no importers; `goToDefinition`, `findReferences`, and `buildSymbolGraphDetailed` match cold and memory-cache builds, and caches rebuild.
- Incremental indexing rechecks Java and Kotlin imports when a file of their package gains or loses a top-level syntax error without changing any name, and re-resolves every unresolved import of a language group when a deleted declaration file has no cached module. The memory cache groups Java and Kotlin, so deleting a Java duplicate rebinds Kotlin importers. Known gaps are listed in `docs/language-parity.md`.
- Kotlin named imports resolve declarations in the default package and stay conservative beside unread files; Java cannot import from that package.
- C# member navigation and references resolve qualified declared and constructed receiver types, including `global::` and namespace aliases, consistently with detailed call edges; unrelated namespaces stay excluded. Nearer type roots never fall back to a global namespace namesake, and verbatim or keyword namespace roots follow C# identifier equality.
- C# detailed call graphs include static calls through lowercase and keyword-verbatim type aliases, while same-named parameters and locals keep their own receiver targets. Class and method type parameters also hide aliases; unproven constrained calls stay unresolved with partial reference coverage.
- C# type aliases treat `B` and `@B` as the same identifier in go-to-definition, references, and detailed graphs. Source spelling and ranges stay unchanged; unresolved aliases still block same-named imported types. Declared and constructed receiver proofs use the same identifier equality, preventing a verbatim value name from becoming a false static receiver.
- Kotlin quoted and plain identifiers resolve to the same declaration across package imports, navigation, references, and graph edges, including Java imports of Kotlin classes and declared or constructed receiver bindings. Value bindings do not hide type-position graph uses; shadowed aliases and inherited members do not create false import uses. Source spelling and binding ranges stay unchanged; caches rebuild.
- Swift extension headers resolve in the type namespace only: a header opens the indexed type and counts as one of its references, a same-named function or variable never binds it, and an unindexed type such as Foundation `URL` stays unresolved. Dotted owners such as `extension Outer.Inner` resolve their leading segment, while the unproven nested suffix leaves the nested type's references partial. Extension headers are no longer symbols: `workspace_symbols`, `search`, `explain`, `packet`, symbol and file listings, and handle lookups name the nominal type, a handle to a header is rejected as stale, and `rename-preview` never edits a header alone. Their members stay owned by the nominal type, and protocol-extension defaults remain callable through conforming types.
- Swift base clauses and extension conformances follow a typealias to the one class or protocol it provably names, so inheriting through an alias gives the aliased class its subtype, member navigation, `super` calls, and call edges, while an unproven alias (a generic specialization, nested type, or unindexed type) adds no edge. A concrete type adopting a protocol has an `implements` edge, and a protocol inheriting a protocol keeps `extends` in one file or across files; `implementations` of the inherited protocol return its conforming types, never the refining protocol. PHP interfaces that extend an interface get the same traversal.
- Swift references include same-spelled backtick-quoted receiver members instead of incorrectly reporting complete coverage without their uses.
- Swift constrained extensions share proven peers across quoted and plain identifier tokens in `where` clauses; navigation, references, and detailed call edges agree without combining different constraints. Detailed graph receiver scans avoid repeated language lookups when no Swift callable names are indexed.
- Swift backticks no longer change identifier identity: quoted and plain functions, types, imports, and members resolve across go-to-definition, complete references, and detailed call graphs without changing source spelling or ranges.
- C# `goToDefinition`, `findReferences`, `buildSymbolGraphDetailed`, `callers`, and `callees` exclude alias targets hidden by value bindings, including properties, lambda parameters, loop variables, and `out` declarations. Declaration names are not alias uses; type-only alias uses, scope exit, explicit namespace qualifiers, and proven typed receivers remain supported. Cached graphs rebuild.
- C# catch and `for` variables stop hiding aliases after their statement. Deconstructed `foreach` variables hide aliases only in the loop body, while lambda defaults and constant patterns retain their enclosing constant references.
- Kotlin type annotations and generic type arguments resolve imported types beside same-named parameters or locals without adding false value references. Kotlin type parameters now report symbol kind `type` (as C# and Go) and are visible only inside their own class, function, or type alias declaration, so they win over a same-named imported alias there and never hide same-named types elsewhere in the file.
- Kotlin type annotations and generic type arguments resolve imported types beside same-named parameters or locals without adding false value references. Class and function type parameters stay type bindings, so they still win over a same-named imported alias.
- C# `goToDefinition`, `findReferences`, `buildSymbolGraphDetailed`, `callers`, and `callees` bind enclosing project members before same-named `using` aliases, including partial parts and namespace-qualified bases. Bare calls select inherited overloads by argument count; type positions ignore value members but bind accessible inherited nested types. External bases preserve alias binding because their members are not indexed; unreadable project bases and incomplete partial types remain unresolved with partial coverage. Cached graphs rebuild.
- Python go-to-definition and references resolve a module-level use to the explicit import that a later same-named `def` replaces; star imports after the use do not change its target. An intervening star with unchecked forwarding of the requested name stays unresolved with partial reference coverage unless a later explicit import or proven star binding overrides it; unrelated imports in the star target do not hide the earlier binding. The later declaration still owns deferred function-body uses.
- Python default-argument calls resolve in their enclosing scope instead of becoming fictitious parameter declarations; same-named parameters keep only their body references. A redefined function's own default sees the earlier binding in its enclosing scope, while its body sees the new function.
- Python references exclude calls rebound by a later module import from the original local declaration. Reference lookup uses the same source-order and function-runtime binding decisions as go-to-definition.
- JVM package wildcard imports keep known file dependencies but no longer prove Kotlin calls or callable references while unread package declarations may add an overload or factory. Go-to-definition, references, detailed symbol edges, and rename previews agree; class type navigation and fully read packages remain supported.
- Incremental indexing and `buildGraphDelta` apply project discovery filters, including Git ignore rules, to changed and untracked Git files. Editing an ignored tracked file no longer adds it to the index or manifest; older contaminated caches rebuild. Graph deltas retain removed files and edges when a rename destination is ignored.
- C# alias and static-using type lookups stay partial beside oversized scan candidates with workers on or off, including ignored files and files outside an explicit index list. Cached results rebuild with the consistent source-size policy.
- Query-time syntax and scope caches are bounded; evicted views reuse retained native columns. Re-reading a previously queried file that changed or disappeared now reports that the project index needs rebuilding.
- Java and Kotlin imports stay external when a known JVM package does not declare the imported name, instead of guessing a same-named file by path. Java no longer creates a dependency on `Hidden.kt` for a Kotlin function named `Hidden` or a different declared type; declared types and nested-type imports still resolve.
- `buildSymbolGraphDetailed`, `callers`, and `callees` keep receiver proofs separate at each call site. A block, closure, or parameter that shadows a receiver no longer reuses another binding's type or adds a wrong call edge; cached graphs rebuild.
- Reference coverage reports affected files in deterministic path order.
- `goto`, `refs`, and `rename-preview` retain consumer sites through `export *` cycles regardless of module or lookup order. Named exports keep precedence, ambiguous re-exports cannot become unique through a sibling barrel, Python star re-exports keep the last import statement without reviving locals excluded by `__all__`, and C includes retain compatible function declarations. Cached graph artifacts rebuild.
- Python `goToDefinition` preserves import provenance instead of labeling cross-file import targets as exact local definitions.

## [3.1.3] - 2026-11-04

### Added

- MCP workspace routing: `codegraph mcp serve --root /path/to/workspace --workspace workspace.json` selects independent repositories without building a parent index. Search results keep project-qualified handles, deterministic project order, freshness, omissions and failures; dependency relationships require explicit configuration.

### Changed

- CLI stdio MCP clients reuse one compatible project owner, index, worker pool and watcher through the existing verified server lifecycle. Automatic owners use an available loopback port and exit after 30 inactive minutes; client disconnects and cancellations do not close another client's analysis state. Incompatible configuration, security policy or runtime code requires an explicit owner stop and reconnect.
- MCP checks non-Git parent roots before configuration loading or indexing. Multiple independent repositories require project selection or an explicit workspace; discovery-budget exhaustion reports unknown scope. Intentional broad-root indexing uses `--allow-parent-root`.

### Fixed

- MCP watching retires descendant handles after a parent directory disappears; queued edits still invalidate freshness, but retired handles cannot close or disable replacement watches. An older failed rebuild no longer consumes a newer edit burst's retry attempts.
- MCP bridges reject retargeted project aliases and revalidate captured owner endpoints after connection setup, before sending tool calls. Workspace routing retains and checks secondary alias paths after physical-project deduplication, rejects owners with a changed root, and preserves nested packet coverage and logical-root metadata.
- HTTP MCP shutdown closes keep-alive connections after their active responses finish, so health polling cannot hold `codegraph server stop` open.
- MCP root preflight recognizes Git checkouts directly inside pruned directory names such as `vendor`, without scanning their contents. Workspace errors retain owner compatibility reasons and recovery instructions while redacting filesystem paths.

## [3.1.2] - 2026-11-02

### Changed

- A cold index of a JavaScript or TypeScript project builds each file's module in the native worker that parsed it: imports (resolved later), locals and exports, parse error ranges, and edge specifiers come back as one compact record, and the main thread only resolves the distinct imports and finishes the module and its edges. The build keeps twice as many files in flight as there are workers unless `threads` is set, and `--report` counts worker-built files in `workerPool.moduleRecords`; files that need the main thread (such as a CommonJS `module.exports = { ...required }` spread) and incremental updates are indexed as before. On a 16,700-file project a cold build took 46 s instead of 111 s (main-thread CPU 36 s instead of 108 s; peak RSS 3.4 GB instead of 2.9 GB), and on an 11,700-file monorepo 8.4 s instead of 14.2 s. Modules, edges, module-cache rows, and manifest entries are unchanged.
- Incremental updates (`codegraph index`, `buildProjectIndexIncremental`, agent sessions) extract the importers of a changed file again only when its public surface changed: its exported names and kinds, its re-export sources, and, for a file with no exports, the names that a star import binds. A body or signature edit extracts only the edited file; before, every transitive importer extracted again (in a 16,700-file TypeScript project one body edit extracted 5,470 files and took 179 s; in this repository a single body edit extracted up to 447 files). An export change extracts the direct importers and the importers along a chain of re-exports, while the transitive importers of a changed C#, Java, Kotlin, PHP, C++, or Rust file, or a Python `__init__.py`, still extract again. `manifest.json` records each file's surface, and a manifest from an earlier version counts the first change to each file as a surface change. The index is the same as before.
- Update and warm-open runs no longer run `git hash-object` over every tracked file, which took 3 to 6 s in a 10,000 to 20,000-file project. Blob ids come from one `git ls-files` listing for the files that Git reports as unchanged, and only changed files are hashed; `--cache-strict` and `--cache-verify` still hash every file. A file that a Git clean filter rewrites (Git LFS, or a mixed line-ending file under `text=auto`) now carries its committed blob id, so it is extracted once more after upgrading.
- `findReferences`, `codegraph refs`, MCP `refs`, `previewRename`, and `codegraph rename-preview` choose the files they verify from the importers of each file, which every index build records, and from two tables that the first lookup of an index builds once: the modules that re-export each file, and the module list sorted once. Each lookup used to test every indexed module several times, so a definition that nothing imports cost a pass over the whole project. On a project of 16,700 files its first lookup took 1.0 s at the median before and 33 ms after, on 11,700 files 52 ms before and 0.9 ms after, and a session of 240 lookups on the larger project took 422 s before and 185 s after. A member lookup also no longer sorts and lists every file for its coverage. Results, coverage, and `maxReferences` truncation are unchanged, and an incremental update returns a new index that rebuilds the indexes.
- `search` in `symbol`, `path`, `hybrid`, and `graph` modes no longer rescans the project for every query. Names, paths, and docstrings are normalized once per snapshot, and only the best-ranked candidates of each source are built into results. On a project with 100,000 symbols a `symbol` search drops from about 1.1 s to under 10 ms and a `path` search from 7 ms to under 1 ms; on 11,700 files a `symbol` search drops from 2.6 s to under 10 ms. Rankings, scores, handles, and omission counts are unchanged.
- Text and hybrid `search` no longer scan chunk text for a term that spans word boundaries, and no longer repeat each match once per batch of 500 eligible files. Such a term is answered from a second trigram index over each chunk's text without spaces, and the terms of a pass are one lookup in it that runs once for the pass, not once per batch. Each batch is read with one statement that orders its chunks by file path and position, asks for no more than the candidate cap still leaves plus one row, and is not run again once the cap is decided, so a broad query reads about the cap and not every match; the candidate cap and omission counts are unchanged. A search that matches fewer than a third of the stored files reads only the rows of those files from the file table, not the whole table, which saves up to 4 ms on 11,700 files. The query-index sidecar (`search-v1.sqlite`) is now schema version 4: it is about 46% larger (43 MB more for 92,000 chunks) and takes about 20% more CPU time to build, and a version 3 sidecar is upgraded in place on first use from its stored text, without reading source files (3 s for 92,000 chunks, 30 s for 195,000). On a project with 11,700 files a `text` search drops from about 1.5 s to 0.6 s and a `hybrid` search from 3.4 s to 0.4 s; on 1,200 files, from 0.48 s to 0.18 s and from 1.7 s to 0.3 s.
- Resolving a portable symbol handle (`calls`, `callers`, `callees`, `goto` and `refs` by handle, `type_hierarchy`, `rename_preview`, `refactor_plan`) reads the definitions of the handle's file instead of every definition in the project, and the lookup is dropped with the snapshot after an edit. Handle resolution drops from about 1 ms (1,200 files) or 13 ms (11,700 files) to under 0.1 ms per call.
- MCP `refs` by a portable symbol handle no longer loads the detailed symbol graph or the duplicate analysis. It runs the reference search the full explanation ran and returns the same `references`, `limit`, `totalSeen`, `truncated`, `omitted`, and `referenceCoverage`; a stale handle, a SQL object, a file, or a bare name still takes the full explanation. The first call drops from about 10 s to 2.5 s on a project with 1,200 files and from 99 s to 2.5 s on one with 11,700; later calls drop from 90 ms to 11 ms and from 1.2 s to 5 ms.
- Repeated `findReferencesById`, `buildReviewReport`, and import-inclusive `workspaceSymbols` lookups reuse syntax-only parsed files across an index, including disk-cached indexes, without rerunning native extraction. `buildSymbolGraphDetailed`, `goToDefinition`, and `previewRename` share the same syntax tree even when the detailed graph or symbol search runs first. Re-export declarations are scanned once per parsed tree, scope occurrences are filtered once, and path normalization and identity memoization is bounded. Reference results are unchanged.
- `buildReviewReport`, `codegraph review`, MCP `review`, and `codegraph impact` find the callsites of a changed callable that has no known callers in one pass over the files, not one pass for each callable. A file whose identifier filter cannot hold the callee name is no longer parsed, every other file is parsed and walked once for all the callables that look at it, and the walk no longer creates a promise for each syntax node. Reports are unchanged.
- The duplicate-unit disk cache keeps a row limit that follows the project (at least 5,000 rows, two per indexed file, at most 100,000). A project with more than 5,000 files now gets a cache hit for every file on its next `review` or `duplicates` run, where a fixed 5,000-row limit evicted most of them each time, and a cached file's persisted paths are checked once per path, not once per unit. Targeted duplicate contexts (the duplicate tasks of `review`, `findDuplicateContext()`, and `findDuplicateContexts()`) check each unit against the targets once. On a project of 11,700 files, `review` took 56 s before and 9 s after for 5 modified files, and 144 s before and 33 s after for 20 added files, with identical reports; the first run after upgrading still recomputes the files the old cache had dropped.
- A cold `codegraph index` spends far less time on import resolution. A build now lists a directory once it probes it for more than a few names and answers file, directory, and real-path questions from the listing, as `stat` and `realpath` would on that volume (case rules and symbolic links included). It keeps one resolution for a repeated specifier instead of one per importing file, and takes the real paths of its confinement checks from the same cache. A cold index of an 11,700-file TypeScript monorepo took 19 s instead of 55 s, and one of a 16,700-file project 139 s instead of 301 s; blocking `statSync` calls fell from 836,299 to none and `realpath` calls from 686,823 to 22,572 on the larger project. Resolved targets are unchanged apart from the fix below.
- `codegraph artifact build` writes `graph.json` once and in pieces. `files`, `fileEdges`, `symbols`, and `symbolEdges` are at the top level only (`schemaVersion: 3`; version 2 repeated them under `graph`), which halves the file. `drift --base-artifact` reads versions 2 and 3 and, from version 3, only `files` and `fileEdges`, in pieces, so a baseline that one string or the heap cannot hold still loads; a previous `graph.json` is recognized by its `format` alone for `--force`. `graph.json`, `questions.json`, and `manifest.json` are each written to a temporary file and renamed over their path when complete (the SQLite database and the report are not), and a symbolic link at that path is replaced, not followed, as it is for the disk cache files. A failed build removes what it wrote, and the output directory when it created it, and reports `Failed to write <artifact>: ...` with the Node.js string limit when a string passed it; a file it cannot remove is listed in that error as `Not removed: <name> (<code>)` instead of being reported as removed. `graph --json` also writes in pieces: to `--output` through a temporary file that replaces a previous file only when the write is complete and keeps that file's permission bits on Linux and macOS, and to stdout one piece at a time, waiting for a consumer that reads slowly. A symbolic link at the output path stays, and the file it points to is replaced (a link with nothing at its end creates that file). A path that a rename cannot replace, or must not, is written in place: `/dev/null`, a FIFO, `\\.\NUL`, a Windows named pipe, and a descriptor path (`/dev/stdout`, `/dev/stderr`, `/dev/fd/N`, `/proc/self/fd/N`, also at the end of a link), so `--output /dev/stdout > graph.json` fills `graph.json` and `>>` adds to it.
- `callers` and `callees` (MCP `calls`; library `findCallers` and `findCallees`) accept `--depth` up to 15; the cap was 5. A result at depth 5 or less is unchanged. A deep request visits each symbol once, nearest level first, and `--limit` still bounds the output: the symbols beyond it are counted as omitted symbols (`omittedCounts.symbols` in JSON).
- The detailed symbol graph that `callers`, `callees`, `supertypes`, `subtypes`, `explain`, `packet get`, `rename-preview`, `refactor-plan`, and `artifact build` load is persisted as `detailed-symbol-graph.bin`, a compressed binary file of typed columns, in place of `detailed-symbol-graph.json`. Each file is stored once as a project-relative path and checked once on load, where the text file rebased and checked every symbol and edge, so a warm load takes 0.07 s on a project of 100,000 symbols (was 2.3 s) and 0.3 s on one of 220,000 (was 6.3 s), with about a quarter of the heap. A load no longer derives the base symbol graph again to compare it with the persisted graph; a checksum of the whole file, the project snapshot identity, the implementation fingerprint, and the check of every file still reject a damaged, stale, or foreign file, and a byte changed anywhere in the file, header included, is damage. The first run after an upgrade rebuilds the graph once and removes the old `.json` file.
- Native extraction compiles each language's Tree-sitter queries once per process and shares them across worker threads, where every worker compiled them itself and compiled each language's four extraction queries a second time as a merged query. The first C++ file no longer costs each of eight workers about 1.2 s of CPU (the process pays about 0.5 s once), and the TypeScript, JavaScript, and Python warm-up falls from about 0.1 s on every worker to about 0.03 s once. A cold index of a C++-heavy repository of about 1,800 files used 42% less CPU (46 s to 27 s) and finished about 10% sooner, while a TypeScript monorepo of about 11,700 files, bound by module resolution on the main thread, was unchanged; results are identical. Extraction calls pass the id of a query set registered once per language (`registerQuerySet` in `@lzehrung/codegraph-native`) instead of 5 to 22 KB of query text, and a native binary from before this change is reported unavailable with a reinstall hint.
- A cold `codegraph index` of a TypeScript or JavaScript project spends less main-thread time on each file. Import extraction scanned a file from its start to turn the UTF-8 byte offset of every import into a string index, a cost that grew with the file's length times its imports, and now converts through one table per source that a small cache of recent sources keeps. The CommonJS export recovery and the TypeScript `require()` supplement skip their text scans for a file that has no `exports` outside comments and strings, or no `require` at all. A cold index of a 16,700-file TypeScript project took 98 s instead of 134 s, and one of an 11,700-file monorepo of small files 18.3 s instead of 19.3 s (medians of three runs); cache entries, manifests, and edges are identical.

### Fixed

- Impact analysis now applies custom `severityWeights` to direct impacts as well as transitive ones. Direct references were always scored with the default weights.
- An `@use`, `@forward`, or `@import` in a Vue `<style lang="scss">` block that goes through a tsconfig `paths` alias (`@use "@scope/design-system/css/mixins"`) now has its file edge. The import resolution cache ignored the path aliases, so the same file and specifier resolved earlier without them, when the module's imports were read, decided the answer for the graph edge, and it stayed `external`. The cache now keeps the two apart; on a 27,000-file Vue and TypeScript monorepo 67 of 157,260 edges changed from external to the existing file. Caches built before this change are discarded.
- Go-to-definition, find-references, and the symbol graphs no longer grow without bound on a large project. `resolveExport` stored one cache entry for every module and name it was asked about, 99% of them "not exported here", so a dense monorepo build held 12.5 million entries (5 GB), a larger one ended with `Map maximum size exceeded`, and a long `refs` session added about 13,000 entries per query. A module with nothing under a name and no `export *` now answers without an entry, cache keys carry a short module id instead of the path, and a cache that reaches 524,288 entries is emptied between lookups. `refs` also skips its namespace-link pass when no module has `export * as name from`. Results are unchanged.
- `buildSymbolGraphDetailed` no longer ends with `Maximum call stack size exceeded` on a project with more than about 124,000 edges and a TypeScript overload group or a C or C++ prototype with its definition. The same call-argument spread is gone from the other lists that follow project or file size: syntax-node children, references, workspace-symbol candidates, document links, import and export lists, and `affected --stdin` file lists.
- `callers`, `callees`, `artifact build`, and agent sessions no longer exit with `Invalid string length` when the detailed symbol graph is large, and a persisted graph that cannot be written leaves no cache instead of failing the command.
- The detailed symbol graph of a very large project is persisted. At about 1.4 million symbols and 1.2 million edges its JSON text passed V8's string limit (about 536 million characters), the write failed without a message, and every `callers`, `callees`, and `explain` process rebuilt the graph, in about five minutes and 9 GB of heap. The binary file needs no such string: that graph persists in 19 MB, and a later process loads it in under 3 seconds.
- `findReferences`, `codegraph refs`, and the callsite hints of `buildReviewReport`, `codegraph review`, MCP `review`, and `codegraph impact` now find a call with a Unicode space or line separator between the callee and its arguments, such as `Api.helper` followed by U+00A0, U+2028, or U+3000 and then `("x")`, in a JavaScript, TypeScript, TSX, C#, or Swift file. The identifier filter that narrows the files to search stored the callee and the separator as one token, so a search for `helper` skipped the file. A filter now also holds the pieces of each token split at those separators, and filters cached by an earlier version are rebuilt on the next run.

## [3.1.1] - 2026-10-30

### Fixed

- Duplicates: `codegraph duplicates` no longer ends with `Map maximum size exceeded` or runs out of memory on a large monorepo whose files share many fingerprints. Fingerprint matching now counts the buckets each pair of units shares with one counter per unit, where it kept a table of every pair that shared a fingerprint, and candidate pairs are bounded by `--max-candidate-pairs` (default 2000000; `maxCandidatePairs` in `findDuplicates()`, `findDuplicateContext()`, and `findDuplicateContexts()`). Pairs are kept strongest evidence first, pairs that can never be scored (two units of one file in a cross-file run, or two that overlap) take no slot, and skipped ones are counted in `omittedCounts.candidatePairs` and `stats.candidatePairBudget`, with a partial-results note in pretty output. Cluster summaries are built once per clone family instead of once per group, which took minutes on a family of near-identical files, and the command now reports unit, candidate pair, scoring, and grouping progress on stderr and ends with its total elapsed time, where it reported only the index refresh.
- codegraph no longer opens console windows on Windows for its child processes: the git commands used by drift, impact, and review, and the browser launch of `codegraph viewer`, now run hidden.

## [3.1.0] - 2026-10-29

### Added

- SCSS Sass module navigation. `@use` (default namespace, `as`, and `as *`), `@forward` (`as prefix-*`, `show`, and `hide`), and legacy `@import` resolve `$variables`, mixins, functions, and `@extend` placeholders across files. `show` and `hide` list the exposed (prefixed) names, `@import` has no privacy. Variable, mixin, and function names treat `-` and `_` as one character; placeholder names and namespaces compare as written. A partial that an `@import` loads reads the scope of its importer, so its uses of the importer's variables, mixins, functions, and namespaces resolve. Parameters, loop variables, `using` parameters, and keyword-argument names are local (a parameter hides a member only after its own default value), and a variable that one file assigns again stays one variable. A custom property value is literal CSS, and the media query and `url(...)` interpolation of a CSS `@import` are read. `sass:` modules stay external. Reference coverage is `partial` for unreadable files, unresolved module URLs, Vue and Svelte style blocks that may load the module (also through a module that forwards it), ambiguous members (including a partial whose importers define the name differently, and a file of the same `@import` scope that declares the name again, and a file that assigns a variable that its `@use ... as *` module also declares), `@import`s nested in a rule (Sass declares their members in that block only), and `meta.load-css` / `meta.get-function` / `meta.get-mixin` / `meta.module-variables` / `meta.module-functions` / `meta.module-mixins` (also with `_` in the name). A placeholder resolves wherever its rule sits (a media query, another rule, a mixin body), and a file that declares one name more than once has one placeholder. Rename preview edits only the member name. It reports `name_collision` when a scope that sees the member already uses the new name (under every forward prefix, for a placeholder in every file that can extend it, for a block variable with `-` and `_` as one character, and for a private name that takes a public name, in the scopes that then see it), `shadowing` when a local variable would capture a bare use, and `invalid_identifier` when a new name that starts with `-` or `_` would hide the member from a use through `@use` or `@forward`, or when a `@forward` `hide` list names the new name.
- MCP file watcher. `codegraph mcp serve` and `codegraph server start` now watch the project root. A file event outside the directories that default discovery ignores (`node_modules`, `.git`, `.codegraph`, `dist`, `build`, and similar) and outside a cache directory that `--cache-dir` or `CODEGRAPH_CACHE_DIR` moved into the project clears the session's cached freshness result at once, so a query no longer reuses a `fresh` answer that is up to 5 seconds old. 500 ms after the last event, and at least 5 seconds after the previous background refresh ended, the server rebuilds the index in the background, including after a change burst above the automatic refresh limits (such as a branch switch) that used to stay `stale` until `refresh_index`. The watcher pauses after 30 minutes without a tool call and resumes on the next one, and the freshness check of each tool call stays the authority. Pass `--no-watch` to turn it off, or use the library options `watch`, `watchDebounceMs`, `watchMinRefreshIntervalMs`, and `watchIdleMs` on `serveCodegraphMcp`.
- MCP cold-start budget. `search`, `explore`, `orient`, `get_file` with `includeGraphContext`, `review`, `packet_get`, `workspace_symbols`, and `impact` that would wait longer than `--index-wait-ms` (library option `mcpIndexWaitMs`; default 15000, `0` waits without limit; `codegraph server start` forwards it) for an index build that is running now return the normal result `{ "status": "index_building", tool, message, retryAfterMs, waitedMs, progress }` instead of blocking until the client's request times out. The build continues, concurrent calls share it, and the same call succeeds once it ends; a cancelled call stops waiting at once. Every other tool waits for the index without a limit, as before. A `review` of a range without a changed file is answered from git and never waits. See "Cold start and `index_building`" in `docs/mcp.md`.

### Changed

- GitHub release descriptions now include the changelog section for the released version.
- For non-SCSS definitions, any candidate or scanned file with an outermost Tree-sitter `ERROR` or `MISSING` range makes find-references coverage `partial` with `parse_error` and marks that file affected, regardless of the range contents. SCSS remains exempt because its grammar reports `ERROR` on supported module syntax. Files without a usable native syntax-tree projection are also marked `parser_degraded`, including on warm-cache rebuilds.
- The native addon now runs on the Tree-sitter 0.27.1 runtime (was 0.25.10); no grammar crate changed. Building it from source needs Rust 1.90 or newer; published installs are unaffected. Parse trees are unchanged for files a grammar parses cleanly; inside an `ERROR` region the runtime recovers in a different shape, so a file with syntax its grammar does not support can get different `ERROR` ranges, chunk boundaries, and recovered symbols, most visibly in CSS, Less, and SCSS. Cached index data is rebuilt once.
- `codegraph grep --query` now rejects a Tree-sitter query predicate that does not end in `?` or `!` (`#eq` in place of `#eq?`) instead of ignoring it, so such a query returns no matches, as other invalid queries do. Built-in queries are unaffected.
- `codegraph mcp serve` and `codegraph server start` now answer `initialize` and `tools/list` before the index is built: the warmup runs in the background, and the HTTP server listens before it ends. Before, the stdio server read no request and the HTTP server accepted none until the base index was built, so on a large project the first request timed out. The default warmup also builds the search index (`search-v1.sqlite`) after the base index, so the first hybrid or text `search` and `explore` no longer build it; `--warmup-symbols` builds the detailed symbol graph in the background, and `--no-warmup` builds on the first tool call that needs the index. `get_file` without `includeGraphContext` never waits for the index, and `--startup-timeout-ms` now covers only the start of the process.

### Fixed

- Kotlin indexing no longer hangs on a file that ends in the middle of an annotation (`@Ann`, `@get`, `@set:Foo`, or a lone `@` at the end of the text). One-line class bodies (`class A { val x = 1 }`), annotated top-level declarations, `[]` collection literals, multi-dollar strings (`$$"..."`, with a `$${name}` or `$$name` template read as a reference and a shorter run of dollars read as text; a short template name may start with any letter the grammar reads as an identifier or be backtick-quoted, in single- and multi-dollar strings, on every platform), `dynamic`, `final` and `by` used as identifiers, and a nested class followed by `private constructor(` now parse without errors. A long run of dollars before a template in a multi-dollar string, or of quotes before the end of a triple-quoted one, no longer stalls the parse (200,000 dollars took about a minute). The native addon builds Kotlin from a pinned fork of `tree-sitter-kotlin-ng` that carries these upstream fixes; cached index data is rebuilt once.
- Kotlin: identifiers, labels (`name@`), and template names written with CJK ideographs, Hangul syllables, or any other Unicode letter are read as names. The pinned grammar was generated by a tree-sitter-cli whose Unicode tables kept only the end points of the CJK and Hangul ranges and stopped at U+10915, so `val <name> = 1` ended in an `ERROR`, the file declared only the names before it, and its references stayed `partial`. The grammar is regenerated with a CLI that reads the whole letter class (Unicode 16.0). A label now reads the same letters as an identifier (before, a label with a letter above ASCII, such as a Katakana loop label, was read as a call followed by an annotation), and a name that starts with a keyword and continues with a letter or a decimal digit above ASCII (`in` and a CJK letter, `in` and an Arabic-Indic digit) is a name on every platform: at the start of a line it is a call, not the keyword that continues the statement above (on Linux it was read as the keyword `in`), and in a `when` condition or a class member it is no longer a parse error. Cached Kotlin index data is rebuilt once.
- Native-extraction, query-index, and raw SQLite query worker pools no longer abort the process on Node 22.16 when a pool is destroyed while one of its worker threads is still starting (`FATAL ERROR: v8::Module::IsGraphAsync must be used on an instantiated module`). Piscina loaded each worker module with `require()` first, which on Node 22 runs through `require(esm)`, and terminating a worker in the middle of that load aborts the process. Workers now start with `--no-experimental-require-module`, so Piscina falls back to `import()` at once.
- C#: plain, static, global, and alias `using` directives and block/file-scoped namespaces are now indexed from native Tree-sitter nodes. Commented namespace aliases and `X::Type<T>` references now resolve for navigation and references. Mapped extensions preserve C# namespace scope during compilation-unit lookup; native parse or projection failures retain their cause and report parser degradation instead of appearing as empty namespace facts. Split-namespace aliases are included in cross-directory reference candidates, so references agree with go-to-definition. Conditional namespace and type declarations under `#if`, `#elif`, and `#else` retain their enclosing namespace.
- C#: Unsupported aliases keep their local binding, so imported decoys stay shadowed. A dotted use of a compilation-unit namespace alias (`X.Type`), including an alias under `#if`, `#elif`, or `#else`, is unresolved for navigation, references, and graph edges inside a namespace whose enclosing chain declares `X` in an indexed file of the importer's project (its nearest `.csproj` directory) as a namespace or a type without type parameters (a generic `X<T>` does not bind the bare name `X`); a `file` type counts only in its own file, and a sibling project's declaration does not count. The check reads the current index instead of a cached importer, so a warm cache agrees with a cold build after another file adds, changes, or deletes that declaration. Type arguments of an unresolved generic alias target remain ordinary references, and namespace discovery and namespace-fact caches honor language-extension mappings.
- C#: A name qualified through a generic type (`N.Outer<int>.Inner`), in a `using` alias target, a field type, or a `new` expression, is no longer read as the type `Inner` in a same-named namespace `N.Outer`. Navigation, references, and graph edges leave it unresolved, so a namespace decoy gains no false reference or `instantiates` edge; type arguments inside the name remain ordinary references.
- C#: A use led by a namespace alias (`X::Type` or `X.Type` after `using X = N;`) stays unresolved for navigation, references, and graph edges while a C# file of the importer's project has no readable syntax tree, because that file may declare the same type; the alias keeps its dependency edges. The check reads the current index instead of a cached importer, so a warm cache agrees with a cold build once the file recovers. `using T = N.Type;` binds the one file that declares `T` without type parameters, including `partial` parts in files with a mapped C# extension. Each C# file's namespace regions and declared types are read from its syntax tree once, when the file is indexed, and stored with its module, so go-to-definition and references parse no C# file for them. A cold build parses each C# file once more on the main thread for the first namespace scan. A C# file whose tree cannot be parsed is attempted once during dependency-edge collection and reported as one parser degradation.
- C#: An explicit alias whose target is unresolved (`using B = Missing.Box;`, or a generic `using B = N.Box<int>;`) now keeps `B.Nested.Run()` unresolved for navigation, references, and graph edges, instead of reaching a same-named type that `using Other;` imports or a namespace named `B` that the project declares. An alias binds only where it is in scope (its namespace block, or the file for an alias before every namespace), so an alias in a sibling or reopened namespace block no longer hides that type, and of several aliases of one name in scope the one in the nearest namespace block binds, whether it names a type or a namespace. The detailed graph follows the same alias for member calls and records no type-use edge from an alias that two aliases share or that sits in another block, where it used to record edges to the last alias of the file.
- C#: A dotted use of a namespace alias declared inside a block namespace or after a file-scoped header (`X.Type`) is now unresolved when a namespace nested below the alias's own namespace declares a namespace or non-generic type `X`, because C# finds that nearer declaration first. The check reads the current index, so a warm cache agrees with a cold build.
- C#: A `using` directive inside a namespace (`using N;`, `using T = N.Type;`, or `using X = N;`) now resolves nothing when a namespace enclosing the directive declares a namespace or non-generic type named like the first segment of its target (`A.N` for `namespace A { using N; }`), or may declare it in a project file with no syntax tree, instead of binding the global `N`. A name that another `using` supplies stays unresolved when such a shadowed `using N;` may bring it in too (`A.N` declares it, or an unread file could), instead of resolving to the other `using`, and a dotted name led by it (`B.Nested.Run()`, `B.Nested value;`) no longer falls back to a project namespace `B`. The decision reads the current index when the lookup runs, so warm and cold builds agree. The directive's dependency edge and import node still follow its text, and `using static` is not checked.
- C#: `using B = N.Solo;` no longer binds the generic-only type `Solo<T>` through the path `N/Solo.cs` once a project file declares namespace `N`. The alias stays external with no dependency edge, as it already did when `Solo.cs` sat at the project root.
- Java and Kotlin: package clauses, imports, and top-level declarations are now read from native Tree-sitter nodes instead of source text. A dotted package or import name with whitespace or a comment between its segments now resolves for navigation, references, and graph edges. A Kotlin `fun interface` and a backtick-quoted top-level name are now package declarations, so an import that spells the name the same way resolves to its file; before, `fun interface Handler` was read as a declaration named `interface`.
- Kotlin: an extension or generic top-level function is declared under its own name, so `import p.shout` and `import p.gen` resolve to their file. A receiver type is no longer read as a declared name: `import p.String` no longer resolves to the file that declares `fun String.shout()`.
- Java and Kotlin: a package file that was not read in full, because it is over the native size limit or a syntax error reaches the top of its tree, keeps its package and the names read before the error. A named import from that package stays unresolved while the file may declare the name; a file that cannot be parsed at all, not even its head, or whose package clause was not read (a syntax error before it, or comments past the head of a file that is too large to parse), may declare the name in any package. A Kotlin import is not proven by a class alone, because a function or typealias can share its name; a Java import of a proven type still binds. A Java file can declare a package-private type under any name, so an importer of the same package keeps it as a possible declarer, while another package can import only the public type its file name spells. A package wildcard (`import p.*`) names every file of its package, so it also marks its importer while a file of the package was not read in full or a file whose package could not be read may belong to it; it still lists the files it can place. The importer is counted as parser-degraded, is extracted again by the next full build once the file reads, and no longer falls back to a file named after the type.
- Java: the dependency edge of `import static p.Util.run;` now names the file of the type that owns the member (`p.Util`), as its binding already did, so the two agree, including while a file that was not read in full may declare the owner. Before, the edge followed the path `p/Util/run` and its shorter prefixes, which names a file only when the project's directories repeat the package, so a Maven layout had no edge to the owner. The edge is still named as the import is written. A static or type wildcard whose owner such a file may declare now marks its importer for a retry, as a named import does.
- Generic alias targets are not resolved through their type arguments: C# `using X = N.Box<int>`, C++ `using X = Y<int>`, Kotlin/Swift `typealias X = Y<Int>`, and TypeScript `type X = Y<string>` do not enable member navigation through the generic target. Member navigation returned `not_found` in probes for all five languages; navigating on the alias name returned `not_found` in C# and found the alias declaration in C++, Kotlin, Swift, and TypeScript.
- TypeScript and JavaScript rename preview leaves namespace-export names and namespace-member imports unchanged when renaming a member, avoiding spurious import edits and shadowing conflicts. A namespace-member rename is marked unsafe when any reachable export path preserves an explicit alias, including aliases forwarded through export \*; unaliased namespace-member uses remain renameable.
- TypeScript and JavaScript rename preview now also marks a namespace-member rename unsafe when the explicit export alias (`export { x as x }`) is reachable through `export *`, `export * as ns`, or a named re-export of a namespace. Before, such a rename was reported safe and changed `group.value()` while the public export kept its name.
- TypeScript and JavaScript: find references now includes member uses through a namespace re-export (`export * as nested from "./source"`), whether the consumer imports `nested` by name or the barrel with `import * as ns` (`ns.nested.value`). Before, goto found the definition but references missed these sites while reporting complete coverage.
- Python: Inside a class, `self.<name>` resolves to a value-bearing assignment to `self.<name>` in that class, preferring `__init__`; annotation-only declarations do not shadow same-named class attributes. References from instance writes and definition- or handle-based requests resolve to the preferred assignment and separate instance uses from same-named class attributes; mapped Python extensions use the same rule. A `@property` getter or setter, or a `property(get)` or `property(get, set)` descriptor, keeps `self.<name>` writes on the descriptor instead of treating them as instance attributes. Without a descriptor or instance assignment, `self.<name>` continues to resolve to the class attribute; the detailed graph reuses parsed owner and member facts across repeated receiver calls.
- Python: Find-references on a property getter, setter, deleter, or a setter-bearing `property(...)` assignment reports partial coverage with `strategy_unavailable`, so rename preview is unsafe. Getter-local variables retain complete references and safe rename previews. Rename preview started from a later `self.<name>` write uses the preferred `__init__` assignment.
- Python: `self.<name>` and instance receivers now resolve to a property declared in a base class (`@property` or `property(...)`) before an instance attribute that a subclass writes with `self.<name> = value`. The last class-level binding decides: `property(...)`, `@property`, and a replacing `@<name>.getter` each make a new property and are its target, `@<name>.setter` and `@<name>.deleter` keep the earlier one as the target, and a later plain binding such as `<name> = 0` replaces it. An annotation without a value (`<name>: int`) binds nothing and hides no base property, while a plain class attribute found first still does. With several bases, the property is the one of the class that every other class binding the name derives from, at whatever level it sits, so a base listed again beside a subclass of it does not take it. `self.<name>` stays unresolved when the nearest bindings disagree (a plain attribute in one base, a property in an unrelated one) or when unrelated bases each bind a property, because the method resolution order is not rebuilt. Find-references on a `@<name>.getter` definition reports partial coverage, like the other property accessors.
- SQL: statement blocks open only on bare `BEGIN` and bare `CASE`. `END IF`, `END LOOP`, `END WHILE`, `END REPEAT`, and `END FOR`, with an optional label and then `;`, close nothing, so a loop stays inside the routine. `END CASE` closes the innermost `CASE`. Any other `END`, including T-SQL `END IF @x` with no semicolon after `IF`, closes the innermost frame. A `GO` on its own line ends the batch even when a frame is still open. A `CASE` inside a `WHILE` condition, columns named `while` and `loop`, `WHILE repeat < 10 LOOP`, and MySQL `DO CASE ... END` no longer swallow the next statement or its table read. Qualified names, labeled loops, `CASE .5`, and a `--` inside a string are unchanged.
- SQL: a call to a routine is now a reference to it. Find-references and go-to-definition follow `name(` and `schema.name(` in queries and expressions, `CALL name`, T-SQL `EXEC name`, `EXECUTE FUNCTION name()` in `CREATE TRIGGER`, and calls inside `$$` and `BEGIN`/`END` bodies; `DROP`, `ALTER`, `COMMENT ON`, and `GRANT ... ON` statements that name a routine count too. Before, only the definition was found, and coverage said `complete`. Impact now reaches the files that call a changed routine, and rename preview lists the call sites.
- SQL: a routine name that two definitions carry, such as overloads or a repeated `CREATE OR REPLACE`, now gives `not_found` from a call and `partial` reference coverage. A column or table that shares a routine's name no longer resolves to the routine, and a trigger and the function it runs can share a name.
- SQL: impact analysis now finds the references of a changed SQL object, as it does for other languages. A read or call inside the changed file is found, and the changed file is listed with a `directRef` reason. A reference lookup for a SQL definition that is not in the index now gives `not_found` instead of an empty `complete` result.
- SQL: rename preview now edits the name in a schema-qualified reference such as `public.users` or `public.f()` and keeps the qualifier. Before, such a reference was left out as an unsafe site, and several references to one name in a file collapsed into one edit.
- SQL: go-to-definition and `refs` on a routine named by `DROP FUNCTION`, `ALTER FUNCTION`, `CALL`, or `EXEC` no longer resolve to a table of the same name when the project defines no routine; they give `not_found`, as they already did when another routine was indexed. A `DROP FUNCTION f, g` or `GRANT ... ON FUNCTION f, g` target list now names every routine in it, and a MySQL `INSERT IGNORE` or T-SQL `INSERT TOP (n)` table or a column named `call` is no longer read as a call.
- SQL: a column qualified with the name or alias of a routine called in a `FROM` list, as in `SELECT get_users.id FROM get_users()`, no longer resolves to a table of the same name; go-to-definition gives `not_found` and `refs` leaves it out. A comment between `SELECT`, a comma, or `(` and a column named `call` no longer makes the column a call. Statement splitting now follows PostgreSQL and SQL Server nested block comments, so a statement or call inside `/* a /* b */ c */` is no longer read as code; text whose comments do not balance as nested is still read as MySQL and SQLite read it.
- SQL: routine-source aliases now follow their query scope, keeping outer table references visible beside an inner routine source and returning `not_found` with `partial` reference coverage for an alias shared by both sources in one query. PostgreSQL `E'...'` strings with backslash-escaped quotes no longer split at an internal semicolon or invent a routine call or relation read; a following real call is still found. Nested relation sources, including non-CTE `JOIN` and `EXISTS`, now produce read/graph facts while expression-level `FROM` does not invent a relation; exact `FROM schema.table` sources also identify an implicit table qualifier even if another schema defines the same basename.
- SQL: a source clause inside a `BEGIN`/`END` body now ends at the statement's semicolon and at the next query, so `SELECT u.id FROM users u; SELECT g.id FROM get_users() g` keeps the `users` binding. The statements inside that body are split and read on their own, so `FROM users` is a table reference and coverage stays `complete`. `IS [NOT] DISTINCT FROM` is recognized across comments and whitespace of any length. A comma-separated source after a join predicate, as in `FROM a JOIN b ON a.id = b.id, generate_series(1, 3) norm(i)`, keeps `norm(i)` an alias column list; a call in the `ON` predicate or in a source's arguments is still a call.
- SQL: a `JOIN` takes the first source of its own query, so in `SELECT * FROM users JOIN orgs ON orgs.id = users.org_id WHERE EXISTS (SELECT 1 FROM accounts a JOIN roles r ON r.id = a.role_id)` `roles` joins `accounts`, not `users`. A `CASE` expression's `END`, and `END IF` or `END LOOP`, no longer ends a `BEGIN`/`END` routine body, so `SELECT CASE WHEN id = 1 THEN 1 ELSE 0 END AS flag FROM users` inside a procedure still reads `users`. Finding references scans a statement's object names once instead of once per qualified name.
- SQL: a T-SQL `END` before another `IF` is not `END IF`, so consecutive `IF ... BEGIN ... END` blocks still let a following `GO` separate procedures and each procedure is indexed. `END IF`, `END LOOP`, `END WHILE`, and `END REPEAT` close a block only after the matching opener (`IF ... THEN`, `LOOP`, `WHILE ... DO`, or `REPEAT`). A variable or qualified name such as `@case`, `:case`, `$case`, `t.case`, `"case"`, or `[case]` is not a `CASE` block. A `JOIN` inside a `WITH` body is recorded once. An aggregate `FILTER (WHERE ...)` clause is not a call of a routine named `filter`; `filter(x)` still is.
- SQL: an `UPDATE ... FROM` or `DELETE ... USING` keeps its own alias, so in `SELECT u.id FROM users u; UPDATE accounts SET id = u.id FROM accounts u` the first `u` is `users` and the second is `accounts`. A subquery of that statement still sees the alias. A PostgreSQL routine body written as `AS 'SELECT normalize_email(e)'` is scanned like a `$` body when the language is SQL, PL/pgSQL, or omitted; a doubled quote stays in place, so the call's offset does not move. An ordinary string, a parameter default, and a body in another language stay masked. References of that call are `complete`, and rename edits it.
- SQL: keyword-shaped variables and qualified names no longer break query aliases; T-SQL computed columns link routine calls, while CAST types and `ON CONFLICT`, `OVER`, `FILTER`, and `WITHIN GROUP` clauses no longer invent routine references or rename edits.
- SQL: a file is read as SQL by the language registry, not by the literal `.sql` suffix, in every SQL feature. Go-to-definition, find-references, rename preview, `refactor-plan`, `review` SQL context, `explain` related SQL objects, artifact `graph.json` `sql:` ids, `graph --sql-artifacts`, and duplicate SQL handles now cover `.ddl`, `.pgsql`, `.mysql`, and any suffix that `languages.extensions` maps to `sql`. Before, an object in such a file was indexed but `goto` gave `not_found`, `refs` returned only its declaration, rename preview made no edits, and the other outputs left the file out.
- CLI: `goto`, `refs`, `dumpmod`, `graph`, and `review` now apply `languages.extensions` from `codegraph.config.json`, as `index`, `inspect`, and the other commands already did. Before, a file with a mapped suffix was not indexed for them: `dumpmod` answered `Module not indexed`, `goto` and `refs` answered `not_found`, `graph` built no edges, symbols, or SQLite rows for it, and `review` reported no SQL context for it.
- Duplicates: a file whose suffix `languages.extensions` maps to a language, such as `.psql` mapped to `sql`, is now compared by `codegraph duplicates`, `inspect --duplicates`, `review`, and `findDuplicates()` as that language, with its chunks and syntax tree. Before, detection skipped every suffix that is not built in, so such a file never produced units. Cached duplicate units are keyed by the mapping, so a changed mapping recomputes them, and units that an earlier version cached are recomputed once.
- Duplicates: cached duplicate units are now keyed by the core algorithm epoch, the language behavior epoch, and the native runtime, so an upgrade that changes parsing or indexing recomputes them. Before, their chunk boundaries, symbol units, and AST-shape hashes survived such an upgrade for up to 30 days. Units that an earlier version cached are recomputed once.
- SCSS: a directory resolves to its `_index.scss` partial, so `@use "lib"` reaches `lib/_index.scss` as it already reached `lib/index.scss`.
- SCSS: avoid incorrect local shadowing targets and interpolated placeholder references; resolve project modules named `meta` and forward members named `show`/`hide`, while inherited `sass:meta` lookups keep conservative reference coverage.
- SCSS: rename preview now reports scoped mixin and function captures (including inverse local renames and forwarded names); interpolation in loud comments no longer hides following declarations or changes argument context.
- SCSS: find references on a mixin or function declared inside a block includes the bare calls and includes in that scope (`-` and `_` are the same character) and does not include a later use outside the block. Rename edits those local calls and is safe when the new name captures nothing.
- SCSS: a dynamic lookup in the block where a scoped function or mixin is visible (`function-exists`, `get-function`, or `call` for a function; `mixin-exists` or `get-mixin` for a mixin; proved `sass:meta` or a legacy built-in; `-` and `_` equivalent) now makes reference coverage `partial` and rename unsafe. Proved calls and includes are still edited, and the lookup string is left unchanged. A lookup outside that block does not.
- SCSS: a namespaced `@include ns.mixin;` or `ns.fn()` call no longer defines a same-file symbol named after the mixin or function, and a declaration after one is indexed. Find-references from the use site now lists the definition and the other uses; before, it returned only the use site with `complete` coverage, and a `$variable` declared after the include was missing from the index. A `sass:meta` member such as `meta.load-css(...)` gives `not_found` instead of resolving to a same-named local. The Tree-sitter 0.27 runtime recovers these forms, which the SCSS grammar does not parse, without the spurious class-selector nodes.
- Disk cache writes of the project snapshot, the bloom filter sidecar, and the detailed symbol graph sidecar now retry a rename that fails with `EBUSY`, `EPERM`, or `ENOTEMPTY` and sync the cache directory afterwards, as index manifest writes already did. Before, one transient file lock during the rename (an antivirus scanner or indexer on Windows) silently dropped the write, so the next run rebuilt that cache instead of reusing it.
- Type hierarchy (supertypes, subtypes, implementations, and the MCP tools and refactor plan built on them) and review candidate tests now sort by code unit, like call hierarchy, so order, `--limit` survivors, and diamond results no longer depend on the host locale or differ for mixed-case, underscore, or non-ASCII names.
- A path under a regular file (ENOTDIR) is treated as a missing path by the confined-file nearest-existing-ancestor check and by the `files` and `additionalFiles` normalization, matching Windows on Linux and macOS instead of throwing a raw `ENOTDIR` error.
- `docs/cli.md` no longer says `index --full` forces a full rebuild; it prints per-module counts as text and reuses the cache, and `--json` prints the details.
- `analysis` and each search result's `provenance.backend` (search, explain, rename preview, `index --json`, and `graph --json`) now describe every indexed file instead of only the files the current build parsed. Before, a build served from the module cache, or one that re-parsed only a docs file, reported `backend: "unknown"`, and an incremental rebuild dropped files that native skipped (oversized or failed) from the skipped-file count that gates rename safety. Each module now records whether native parsed or skipped it, and whether part of it could not be indexed (its syntax tree could not be built, or the imports of its source or of an embedded Vue or Svelte block could not be extracted), so a cold build, a warm session, and a rebuild after any edit report the same backend and skipped files, counting each skipped or degraded file once, including a file whose syntax tree could not be rebuilt and a component whose style block failed to extract. `unknown` remains for a project that indexes no native-supported file.
- A file that grew past the native size limit, or began to fail processing, after the disk cache held its parsed module is now stored in the project snapshot as skipped or parser-degraded, without its old symbols. Before, a later rebuild restored the file's old cached module, so it lost its skipped-file count and its old symbols came back. A file whose processing fails now counts in the skipped-file count of `analysis`.
- C#: a `using X = N.Type;` or `using static N.Type;` whose type lookup cannot read a C# file of the project, such as a file that discovery ignores, now marks its importer parser-degraded, so `analysis` keeps counting it after a docs-only rebuild and in a new session, and the next build that changes a file extracts the importer again. Before, only the build that read the file counted the failure: a later rebuild reused the importer with its alias still unresolved and reported `analysis` complete, and the alias stayed unresolved after the file read again.
- MCP `get_file` with `file: null`, or a missing or non-string `file`, now fails with `Invalid parameters for get_file: file: expected a project-relative file path string, received null`.
- An MCP server that kept running through an in-place package upgrade now answers a tool call that needs a module the upgrade removed with an error that says the codegraph package changed on disk and the MCP server must be restarted, in place of Node's `Cannot find module` text.

### Security

- Update `zod` to 4.6.6 or later to fix GHSA-mrhx-c7xc-m3w5, where validating oversized constrained collections could exhaust memory. Codegraph validates MCP tool arguments with zod.
- Update `@hono/node-server` (used by the MCP HTTP transport) to 2.1.3 or later to fix GHSA-rmxm-3fg6-px4f, where `serveStatic` decoded request paths twice and could bypass middleware on static paths. Codegraph does not call `serveStatic`.
- Update the MCP SDK to `@modelcontextprotocol/server` 2.3.1 and `@modelcontextprotocol/node` 2.1.1 to fix GHSA-jm63-cq47-j5jp (shared HTTP transports could deliver one client's messages to another), GHSA-46jr-4wx8-v453 (one request could exhaust server memory during validation), and GHSA-rvq5-wwqv-78pq (bearer tokens for another service were accepted). With this SDK, a stdio server closes when stdin ends, so a request still unanswered at that moment gets no reply; clients that keep stdin open are unaffected.

## [3.0.1] - 2026-10-17

### Added

- Terraform (`.tf`) support. Each module directory is indexed as one namespace: `variable`, `output`, `locals`, `module`, `resource`, and `data` declarations become symbols, and the new `resource`, `data`, `module`, and `output` symbol kinds are accepted by `codegraph symbols --kind` and MCP `workspace_symbols`. A module with a local `source` depends on every `.tf` file in that directory; registry and Git sources stay external. Go-to-definition, references, rename preview, and impact mapping follow `var.`, `local.`, `module.`, data source, and resource references, module outputs, and module call arguments. `.terraform/` directories are no longer discovered.

### Security

- Update `smol-toml` to 1.9.1 to fix GHSA-r4xh-jqrq-34v2, quadratic-time parsing of crafted TOML. Codegraph parses TOML for Cargo manifests and Codex installer configuration.

## [3.0.0] - 2026-10-05

### Breaking

- Remove the `native` build option and `--native` CLI flag. The native addon is required; a missing addon is an error. Use `codegraph doctor` to diagnose installation problems.
- Remove reduced mode and regex fallback when native parsing or queries fail. Files over the native size limit are skipped with a `sourceTooLarge` report; native query failures are reported as `queryFailure`.
- Make `@lzehrung/codegraph-native` a required dependency. Remove the `fallbackImportExtraction` report field and the `reduced` and `mixed` analysis modes. Graph-only document and stylesheet extraction remains supported.
- Remove `--fast-graph`, `graph.fast`, and `--incremental-strict`. Every file uses the native import query.

### Fixed

- Python imports in a `TYPE_CHECKING` guard are type-only bindings and file dependencies, not runtime imports. Native extraction records every module in `import a, b` and records an import in a one-line compound suite, such as `if enabled: import feature` or `if enabled: from models import User`, as a non-module-level binding.
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

[Unreleased]: https://github.com/lzehrung/codegraph/compare/v3.2.1...HEAD
[3.2.1]: https://github.com/lzehrung/codegraph/releases/tag/v3.2.1
[3.2.0]: https://github.com/lzehrung/codegraph/releases/tag/v3.2.0
[3.1.3]: https://github.com/lzehrung/codegraph/releases/tag/v3.1.3
[3.1.2]: https://github.com/lzehrung/codegraph/releases/tag/v3.1.2
[3.1.1]: https://github.com/lzehrung/codegraph/releases/tag/v3.1.1
[3.1.0]: https://github.com/lzehrung/codegraph/releases/tag/v3.1.0
[3.0.1]: https://github.com/lzehrung/codegraph/releases/tag/v3.0.1
[3.0.0]: https://github.com/lzehrung/codegraph/releases/tag/v3.0.0
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
