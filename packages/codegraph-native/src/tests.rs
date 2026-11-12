use super::{
    extract_language_parts, parse_syntax_tree_columns, register_query_set,
    run_imports_query_compact, run_language_queries, run_query, supported_language_ids,
};
use crate::languages::language_for_id;
use crate::parser_pool::{parse_invocations_for_tests, reset_parse_invocations_for_tests};
use crate::projection::ProjectedColumns;
use crate::query::{compile_query, execute_query, AdHocQueryCache};
use crate::query_set::{registered_query_set, LanguageQueryTexts, QuerySet, QuerySetRegistry};
use crate::types::{NativeMatch, NativeQueryResults};
use std::collections::HashSet;
use std::sync::Arc;
use tree_sitter::Parser;

/// Column-by-column equality between two projections of the same source.
fn assert_columns_match(left: &ProjectedColumns, right: &ProjectedColumns, context: &str) {
    assert_eq!(left.root_id, right.root_id, "{context}: root id");
    assert_eq!(left.node_count(), right.node_count(), "{context}: node count");
    assert_eq!(left.kinds, right.kinds, "{context}: kind table");
    assert_eq!(left.field_names, right.field_names, "{context}: field name table");
    assert_eq!(left.kind_ids, right.kind_ids, "{context}: kind ids");
    assert_eq!(left.parent_ids, right.parent_ids, "{context}: parent ids");
    assert_eq!(left.named, right.named, "{context}: named flags");
    assert_eq!(left.start_row, right.start_row, "{context}: start rows");
    assert_eq!(left.start_column, right.start_column, "{context}: start columns");
    assert_eq!(left.start_index, right.start_index, "{context}: start indexes");
    assert_eq!(left.end_row, right.end_row, "{context}: end rows");
    assert_eq!(left.end_column, right.end_column, "{context}: end columns");
    assert_eq!(left.end_index, right.end_index, "{context}: end indexes");
    assert_eq!(left.child_offsets, right.child_offsets, "{context}: child offsets");
    assert_eq!(left.child_ids, right.child_ids, "{context}: child ids");
    assert_eq!(
        left.child_field_name_ids, right.child_field_name_ids,
        "{context}: child field name ids"
    );
    assert_eq!(
        left.named_child_offsets, right.named_child_offsets,
        "{context}: named child offsets"
    );
    assert_eq!(left.named_child_ids, right.named_child_ids, "{context}: named child ids");
}


    fn parse_root(source: &str, language_id: &str) -> tree_sitter::Tree {
        let language = language_for_id(language_id).expect("language should exist");
        let mut parser = Parser::new();
        parser
            .set_language(&language)
            .expect("parser language should be set");
        parser
            .parse(source, None)
            .expect("source should parse into a tree")
    }

    fn first_capture_texts(matches: &[NativeMatch]) -> Vec<String> {
        matches
            .iter()
            .flat_map(|query_match| query_match.captures.iter().map(|capture| capture.text.clone()))
            .collect()
    }

    fn smoke_case(language_id: &str) -> (&'static str, &'static str) {
        match language_id {
            "c" => (
                "typedef struct Utility { int value; } Utility;",
                "(type_definition declarator: (type_identifier) @name)",
            ),
            "cpp" => (
                "struct UtilityClass { int value; };",
                "(struct_specifier name: (type_identifier) @name)",
            ),
            "css" => (
                "@import \"base.css\";",
                "(import_statement (string_value) @mod) @stmt",
            ),
            "csharp" => (
                "class Program { void Helper() {} }",
                "(method_declaration name: (identifier) @name)",
            ),
            "go" => (
                "package main\nfunc Helper() {}",
                "(function_declaration name: (identifier) @name)",
            ),
            "html" => (
                "<script src=\"./app.js\"></script>",
                "(script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr \"src\") (quoted_attribute_value (attribute_value) @mod)))) @stmt",
            ),
            "java" => (
                "class Main { void helper() {} }",
                "(method_declaration name: (identifier) @name)",
            ),
            "js" => (
                "function helper() {}",
                "(function_declaration name: (identifier) @name)",
            ),
            "kotlin" => (
                "fun helper() {}",
                "(function_declaration (identifier) @name)",
            ),
            "less" => (
                "@import \"base.css\";",
                "(import_statement (string_value) @mod) @stmt",
            ),
            "php" => (
                "<?php function helper() {}",
                "(function_definition name: (name) @name)",
            ),
            "python" => (
                "def helper():\n    pass\n",
                "(function_definition name: (identifier) @name)",
            ),
            "ruby" => (
                "def helper; end",
                "(method name: (identifier) @name)",
            ),
            "rust" => (
                "fn helper() {}",
                "(function_item name: (identifier) @name)",
            ),
            "scss" => (
                "@import \"base.css\";",
                "(import_statement (string_value) @mod) @stmt",
            ),
            "sql" => (
                "CREATE TABLE users (id integer);",
                "(statement) @stmt",
            ),
            "swift" => (
                "func helper() {}",
                "(function_declaration name: (simple_identifier) @name)",
            ),
            "terraform" => (
                "variable \"region\" {}",
                "(block (identifier) (string_lit (template_literal) @name))",
            ),
            "zig" => (
                "pub fn helper() void {}",
                "(function_declaration name: (identifier) @name)",
            ),
            "ts" => (
                "export const value = 1;",
                "(lexical_declaration (variable_declarator name: (identifier) @name))",
            ),
            "tsx" => (
                "export function Button() { return <div />; }",
                "(function_declaration name: (identifier) @name)",
            ),
            other => panic!("missing smoke case for language id {other}"),
        }
    }

    fn smoke_case_language_ids() -> HashSet<&'static str> {
        [
            "c",
            "cpp",
            "css",
            "csharp",
            "go",
            "html",
            "java",
            "js",
            "kotlin",
            "less",
            "php",
            "python",
            "ruby",
            "rust",
            "scss",
            "sql",
            "swift",
            "terraform",
            "ts",
            "tsx",
            "zig",
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn supported_language_ids_contains_expected_languages() {
        let supported = supported_language_ids();
        for language_id in ["ts", "tsx", "js", "python", "php", "go", "rust", "zig"] {
            assert!(
                supported.iter().any(|entry| entry == language_id),
                "expected supported languages to include {language_id}",
            );
        }
    }

    #[test]
    fn execute_query_returns_empty_for_blank_queries() {
        let source = "export const value = 1;";
        let language = language_for_id("ts").expect("typescript language should exist");
        let tree = parse_root(source, "ts");
        let matches = execute_query(source, tree.root_node(), language, "   ")
            .expect("blank query should not fail");
        assert!(matches.is_empty(), "blank queries should return no matches");
    }

    #[test]
    fn execute_query_collects_named_captures_for_typescript() {
        let source = "export const value = 1;";
        let language = language_for_id("ts").expect("typescript language should exist");
        let tree = parse_root(source, "ts");
        let matches = execute_query(
            source,
            tree.root_node(),
            language,
            "(lexical_declaration (variable_declarator name: (identifier) @name))",
        )
        .expect("query should execute");

        assert_eq!(first_capture_texts(&matches), vec!["value".to_string()]);
    }

/// Register `texts` for `language_id` and return the set's id.
fn register(
    language_id: &str,
    imports: &str,
    exports: &str,
    locals: &str,
    import_bindings: &str,
) -> u32 {
    register_query_set(
        language_id.to_string(),
        imports.to_string(),
        exports.to_string(),
        locals.to_string(),
        import_bindings.to_string(),
    )
    .expect("query set should register")
}

fn register_locals(language_id: &str, locals: &str) -> u32 {
    register(language_id, "", "", locals, "")
}

/// A set outside the process-wide registry, so a test can count what it compiles.
fn private_set(
    language_id: &str,
    imports: &str,
    exports: &str,
    locals: &str,
    import_bindings: &str,
) -> QuerySet {
    QuerySet::new(
        language_id,
        LanguageQueryTexts {
            imports,
            exports,
            locals,
            import_bindings,
        },
    )
    .expect("query set should build")
}

const TS_SOURCE: &str =
    "import { helper } from './dep';\nexport const value = helper();\nexport function greet() {}";
const TS_IMPORTS: &str = "(import_statement (string) @mod) @stmt";
const TS_EXPORTS: &str = "(export_statement) @export";
const TS_LOCALS: &str = "(variable_declarator name: (identifier) @name)";
const TS_BINDINGS: &str = "(import_specifier name: (identifier) @iname)";

#[test]
fn run_language_queries_returns_imports_and_locals_for_javascript() {
    let id = register(
        "js",
        "(import_statement (string) @mod) @stmt",
        "",
        "(variable_declarator name: (identifier) @name)",
        "(import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from) @stmt",
    );
    let results = run_language_queries(
        "import { helper } from \"./dep.js\";\nconst value = helper();".to_string(),
        id,
    )
    .expect("native query execution should succeed");

    assert_eq!(results.imports.len(), 1);
    assert_eq!(results.import_bindings.len(), 1);
    assert_eq!(
        first_capture_texts(&results.locals),
        vec!["value".to_string()]
    );
}

#[test]
fn merged_language_queries_match_separate_queries_for_every_supported_language() {
    for language_id in supported_language_ids() {
        let (source, query) = smoke_case(language_id.as_str());
        let tree = parse_root(source, language_id.as_str());
        let two_patterns = format!("{query}\n{query}");
        let set = private_set(
            language_id.as_str(),
            query,
            two_patterns.as_str(),
            "",
            query,
        );
        let separate = set
            .execute_separately(source, tree.root_node())
            .unwrap_or_else(|error| {
                panic!("separate query execution failed for {language_id}: {error}")
            });
        let merged = set
            .execute_merged(source, tree.root_node(), None)
            .unwrap_or_else(|error| {
                panic!("merged query execution failed for {language_id}: {error}")
            })
            .unwrap_or_else(|| {
                panic!("merged query should compile for {language_id}");
            });

        assert_eq!(
            merged, separate,
            "merged query results should preserve every capture and pattern index for {language_id}"
        );
    }
}

#[test]
fn merged_language_queries_keep_each_kinds_patterns_when_texts_start_with_comments() {
    // Kinds that open with comments, hold several patterns, trail a comment with no newline, or
    // hold nothing but a comment must still route every pattern to the kind that wrote it.
    let imports = "; imports\n; two comment lines\n(import_statement (string) @mod) @stmt";
    let exports = "(export_statement) @export\n; between patterns\n(export_statement declaration: (lexical_declaration)) @lexical\n(export_statement declaration: (function_declaration)) @function ; trailing";
    let locals = "; nothing here but a comment";
    let bindings = "\n\n  (import_specifier name: (identifier) @iname) @binding";
    let set = private_set("ts", imports, exports, locals, bindings);
    let tree = parse_root(TS_SOURCE, "ts");

    let merged = set
        .execute_merged(TS_SOURCE, tree.root_node(), None)
        .expect("merged execution should succeed")
        .expect("texts that split into whole patterns per kind must run merged");
    let separate = set
        .execute_separately(TS_SOURCE, tree.root_node())
        .expect("separate execution should succeed");

    assert_eq!(merged, separate);
    assert_eq!(merged.imports.len(), 1);
    assert_eq!(merged.exports.len(), 4, "{:?}", merged.exports);
    assert!(merged.locals.is_empty());
    assert_eq!(merged.import_bindings.len(), 1);
    let mut pattern_indexes: Vec<u32> = merged
        .exports
        .iter()
        .map(|query_match| query_match.pattern_index)
        .collect();
    pattern_indexes.sort_unstable();
    assert_eq!(
        pattern_indexes,
        vec![0, 0, 1, 2],
        "pattern indexes count from the start of the kind, not of the merged query"
    );
    assert_eq!(
        set.compile_count(),
        5,
        "the merged query, then the four kinds the separate run compiled on their own"
    );
}

#[test]
fn a_merged_set_compiles_once_however_often_it_runs() {
    let set = private_set("ts", TS_IMPORTS, TS_EXPORTS, TS_LOCALS, TS_BINDINGS);
    let tree = parse_root(TS_SOURCE, "ts");

    let first = set
        .execute(TS_SOURCE, tree.root_node())
        .expect("first run should succeed");
    for _ in 0..4 {
        let again = set
            .execute(TS_SOURCE, tree.root_node())
            .expect("later runs should succeed");
        assert_eq!(again, first);
    }

    assert_eq!(
        set.compile_count(),
        1,
        "the merged query is the only compile: the four kinds are not compiled on their own"
    );
}

#[test]
fn threads_share_one_compile_of_a_registered_set() {
    // Distinct capture names keep this set from being shared with any other test.
    let id = register(
        "ts",
        "(import_statement (string) @shared_compile_mod) @shared_compile_stmt",
        "(export_statement) @shared_compile_export",
        "(variable_declarator name: (identifier) @shared_compile_name)",
        "(import_specifier name: (identifier) @shared_compile_iname)",
    );
    let thread_count = 8;
    let barrier = std::sync::Barrier::new(thread_count);

    let results: Vec<NativeQueryResults> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..thread_count)
            .map(|_| {
                scope.spawn(|| {
                    // Every thread asks for the set at the same moment, before any has compiled it.
                    barrier.wait();
                    run_language_queries(TS_SOURCE.to_string(), id)
                        .expect("every thread should run the set")
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("thread should finish"))
            .collect()
    });

    assert!(
        results.iter().all(|result| result == &results[0]),
        "every thread must see the same matches"
    );
    assert_eq!(results[0].imports.len(), 1);
    assert_eq!(results[0].exports.len(), 2);
    let set = registered_query_set(id).expect("registered set should be found");
    assert_eq!(
        set.compile_count(),
        1,
        "{thread_count} threads must share one compile, not repeat it"
    );
}

#[test]
fn registering_the_same_texts_returns_the_same_id() {
    let mut registry = QuerySetRegistry::with_capacity(8);
    let texts = LanguageQueryTexts {
        imports: TS_IMPORTS,
        exports: "",
        locals: TS_LOCALS,
        import_bindings: "",
    };

    let id = registry.register("ts", texts).expect("set should register");
    assert_eq!(id, 1, "ids start at 1 so 0 is never a valid id");
    assert_eq!(
        registry.register("ts", texts).expect("set should register"),
        id
    );
    assert_eq!(registry.len(), 1, "equal texts must not add a set");

    let other_locals = LanguageQueryTexts {
        locals: "(identifier) @name",
        ..texts
    };
    let other_text = registry
        .register("ts", other_locals)
        .expect("set should register");
    let other_language = registry
        .register("tsx", texts)
        .expect("set should register");
    assert_ne!(other_text, id, "different text is a different set");
    assert_ne!(
        other_language, id,
        "a different language is a different set"
    );
    assert_ne!(other_language, other_text);

    assert!(registry.get(0).is_none());
    assert!(registry.get(other_language + 1).is_none());
    assert_eq!(
        registry.get(id).expect("set should be found").language_id(),
        "ts"
    );
}

#[test]
fn the_registry_refuses_sets_past_its_capacity_but_not_repeats() {
    let mut registry = QuerySetRegistry::with_capacity(2);
    let make = |locals: &'static str| LanguageQueryTexts {
        imports: "",
        exports: "",
        locals,
        import_bindings: "",
    };

    registry
        .register("ts", make("(identifier) @one"))
        .expect("first set should register");
    registry
        .register("ts", make("(identifier) @two"))
        .expect("second set should register");
    let error = registry
        .register("ts", make("(identifier) @three"))
        .expect_err("a set past capacity should be refused");

    assert!(
        error.to_string().contains("Too many query sets"),
        "unexpected error: {error}"
    );
    assert_eq!(registry.len(), 2);
    assert_eq!(
        registry
            .register("ts", make("(identifier) @two"))
            .expect("a registered set stays registrable at capacity"),
        2
    );
}

#[test]
fn registering_an_unsupported_language_fails() {
    let error = register_query_set(
        "unknown".to_string(),
        "".to_string(),
        "".to_string(),
        "".to_string(),
        "".to_string(),
    )
    .expect_err("unsupported language should fail");

    assert!(
        error.to_string().contains("Unsupported language"),
        "unexpected error: {error}"
    );
}

#[test]
fn running_an_unregistered_id_fails() {
    for id in [0, u32::MAX] {
        let error = run_language_queries("value".to_string(), id)
            .expect_err("an unregistered id should fail");

        assert!(
            error.to_string().contains("Unknown query set id"),
            "unexpected error for {id}: {error}"
        );
    }
}

#[test]
fn a_set_with_one_active_kind_runs_that_kind_without_a_merged_compile() {
    let set = private_set("ts", TS_IMPORTS, "", "  ", "");
    let tree = parse_root(TS_SOURCE, "ts");

    let merged = set
        .execute_merged(TS_SOURCE, tree.root_node(), None)
        .expect("a single kind needs no compile to decline merging");
    assert!(
        merged.is_none(),
        "one active query kind should use the independent executor without merged compilation"
    );
    assert_eq!(set.compile_count(), 0);

    let results = set
        .execute(TS_SOURCE, tree.root_node())
        .expect("the one kind should run");
    assert_eq!(results.imports.len(), 1);
    assert!(results.exports.is_empty() && results.locals.is_empty());
    assert_eq!(set.compile_count(), 1, "only the one kind compiles");
}

#[test]
fn a_set_without_query_text_matches_nothing_and_compiles_nothing() {
    let set = private_set("ts", "", " ", "\n", "");
    let tree = parse_root(TS_SOURCE, "ts");

    let results = set
        .execute(TS_SOURCE, tree.root_node())
        .expect("an empty set should run");

    assert!(
        results.imports.is_empty()
            && results.exports.is_empty()
            && results.locals.is_empty()
            && results.import_bindings.is_empty()
    );
    assert_eq!(set.compile_count(), 0);
}

#[test]
fn merged_language_queries_fall_back_when_the_match_limit_is_exceeded() {
    let source = "/* one */\n/* two */\n/* three */\nfunction target() {}";
    let query = "(((comment) @comment)* (function_declaration name: (identifier) @name))";
    let set = private_set("js", query, query, "", "");
    let tree = parse_root(source, "js");

    let merged = set
        .execute_merged(source, tree.root_node(), Some(1))
        .expect("valid queries should execute");
    assert!(
        merged.is_none(),
        "an exceeded shared match limit must reject partial merged results"
    );
    assert_eq!(
        set.compile_count(),
        1,
        "the kinds have not run on their own yet"
    );

    let fallback = set
        .execute_with_match_limit(source, tree.root_node(), 1)
        .expect("fallback queries should execute");
    let separate = set
        .execute_separately(source, tree.root_node())
        .expect("independent queries should execute");
    assert_eq!(
        fallback, separate,
        "an exceeded shared match limit must return independent-query results"
    );
    assert_eq!(
        set.compile_count(),
        3,
        "the merged query and the two kinds, each compiled once however often they run"
    );
}

#[test]
fn extract_language_matches_separate_queries_and_projection_with_one_parse() {
    let cases = [
        (
            "ts",
            "import { helper } from './dep';\nexport function greet() { return helper(); }",
            "(function_declaration name: (identifier) @name)",
        ),
        (
            "python",
            "from dep import helper\ndef greet():\n    return helper()",
            "(function_definition name: (identifier) @name)",
        ),
        (
            "go",
            "package main\nfunc greet() { helper() }",
            "(function_declaration name: (identifier) @name)",
        ),
    ];

    for (language_id, source, locals_query) in cases {
        let id = register_locals(language_id, locals_query);
        let separate_results = run_language_queries(source.to_string(), id)
            .expect("separate native queries should succeed");
        let separate_tree = parse_syntax_tree_columns(source, language_id)
            .expect("separate syntax tree projection should succeed");

        reset_parse_invocations_for_tests();
        let set = registered_query_set(id).expect("registered set should be found");
        let (combined_results, combined_tree) = extract_language_parts(source, &set)
            .expect("combined native extraction should succeed");

        assert_eq!(
            parse_invocations_for_tests(),
            1,
            "combined extraction should parse {language_id} exactly once"
        );
        assert_eq!(
            combined_results, separate_results,
            "combined query results should match separate queries for {language_id}"
        );
        assert_columns_match(
            &combined_tree,
            &separate_tree,
            &format!("combined projection should match separate projection for {language_id}"),
        );
    }
}

#[test]
fn run_language_queries_surfaces_query_compile_failures() {
    let id = register_query_set(
        "ts".to_string(),
        "(".to_string(),
        "".to_string(),
        "".to_string(),
        "".to_string(),
    )
    .expect("a query that does not compile still registers");
    let error = run_language_queries("export const value = 1;".to_string(), id)
        .expect_err("invalid query should fail");

    assert!(
        error.to_string().contains("Failed to compile query"),
        "unexpected error: {error}"
    );
}

#[test]
fn a_query_that_does_not_compile_reports_its_own_error_and_is_not_compiled_again() {
    let language = language_for_id("ts").expect("typescript language should exist");
    let alone = compile_query(&language, "(").expect_err("the query should not compile");
    let set = private_set("ts", TS_IMPORTS, "(", TS_LOCALS, "");
    let tree = parse_root(TS_SOURCE, "ts");

    for _ in 0..3 {
        let error = set
            .execute(TS_SOURCE, tree.root_node())
            .expect_err("an invalid kind should fail the set");
        assert_eq!(
            error.to_string(),
            napi::Error::from_reason(alone.clone()).to_string(),
            "the error is the invalid kind's own, as when it was compiled first"
        );
    }

    // The merged text, then each kind up to and including the invalid one; later calls reuse them.
    assert_eq!(set.compile_count(), 3);
}

#[test]
fn a_pattern_that_runs_from_one_kind_into_the_next_does_not_hide_the_invalid_kinds() {
    // `(call_expression` and `function: (identifier)) @call` are each invalid, but their text
    // joined by a newline is one valid pattern, so the merged query compiles. It cannot be split
    // back into the kinds, and each kind still reports its own error.
    let set = private_set(
        "js",
        "(call_expression",
        "function: (identifier)) @call",
        "",
        "",
    );
    let tree = parse_root("f();", "js");

    let error = set
        .execute("f();", tree.root_node())
        .expect_err("an invalid kind should fail the set even when the merged text compiles");

    assert!(
        error.to_string().contains("Failed to compile query"),
        "unexpected error: {error}"
    );
}

// Tree-sitter resolves the capture a predicate names against every capture the text defined before
// it. In the merged text of a set, a predicate in one kind can therefore read a capture that only
// an earlier kind defines, which that kind could not do when it was compiled by itself.
const LEANING_IMPORTS: &str = "(identifier) @a";
const LEANING_EXPORTS: &str = "((identifier) @b (#eq? @a \"x\"))";

/// The error `text` gives when it is compiled by itself, which is what an invalid kind reports.
fn error_of_compiling_alone(language_id: &str, text: &str) -> String {
    let language = language_for_id(language_id).expect("language should exist");
    compile_query(&language, text).expect_err("the text should not compile by itself")
}

fn assert_set_fails_with(set: &QuerySet, alone: &str) {
    let tree = parse_root(TS_SOURCE, "ts");
    for _ in 0..3 {
        let error = set
            .execute(TS_SOURCE, tree.root_node())
            .expect_err("a kind that is invalid by itself should fail the set");
        assert_eq!(
            error.to_string(),
            napi::Error::from_reason(alone.to_string()).to_string(),
            "the error is the invalid kind's own, as when each kind was compiled first"
        );
    }
}

#[test]
fn a_predicate_that_reads_another_kinds_capture_reports_its_own_kinds_error() {
    let language = language_for_id("ts").expect("typescript language should exist");
    let merged_text = format!("{LEANING_IMPORTS}\n{LEANING_EXPORTS}\n");
    assert!(
        compile_query(&language, &merged_text).is_ok(),
        "the merged text compiles because @a is defined by the time the predicate reads it"
    );
    let alone = error_of_compiling_alone("ts", LEANING_EXPORTS);
    let set = private_set("ts", LEANING_IMPORTS, LEANING_EXPORTS, "", "");

    assert_set_fails_with(&set, &alone);

    // The merged text, then the kinds in order up to and including the invalid one; later calls
    // reuse them.
    assert_eq!(set.compile_count(), 3);
}

#[test]
fn a_predicate_that_reads_a_capture_before_its_own_kind_defines_it_does_not_borrow_one() {
    // Imports defines @a too, so the merged text resolves the predicate. Exports by itself reads
    // @a before the node that defines it.
    let exports = "((identifier) (#eq? @a \"x\") (identifier) @a)";
    let language = language_for_id("ts").expect("typescript language should exist");
    let merged_text = format!("{LEANING_IMPORTS}\n{exports}\n");
    assert!(
        compile_query(&language, &merged_text).is_ok(),
        "the merged text compiles because imports defined @a first"
    );
    let alone = error_of_compiling_alone("ts", exports);
    let set = private_set("ts", LEANING_IMPORTS, exports, "", "");

    assert_set_fails_with(&set, &alone);
}

#[test]
fn a_predicate_that_reads_a_capture_only_a_later_kind_defines_reports_its_own_kinds_error() {
    let imports = "((identifier) @a (#eq? @b \"x\"))";
    let alone = error_of_compiling_alone("ts", imports);
    let set = private_set("ts", imports, "(identifier) @b", "", "");

    assert_set_fails_with(&set, &alone);

    // The merged text fails too, so imports is compiled by itself and fails first.
    assert_eq!(set.compile_count(), 2);
}

#[test]
fn kinds_that_define_and_read_the_same_capture_names_still_compile_once() {
    let imports = "((identifier) @name (#eq? @name \"helper\"))";
    let exports = "((identifier) @name (#match? @name \"^value\"))";
    let set = private_set("ts", imports, exports, "", "");
    let tree = parse_root(TS_SOURCE, "ts");

    let merged = set
        .execute(TS_SOURCE, tree.root_node())
        .expect("kinds that read their own captures should run");
    assert_eq!(
        set.compile_count(),
        1,
        "the merged query is the only compile: the kinds are not compiled on their own"
    );

    let separate = set
        .execute_separately(TS_SOURCE, tree.root_node())
        .expect("separate execution should succeed");
    assert_eq!(merged, separate);
    assert_eq!(merged.imports.len(), 2, "helper is read twice");
    assert_eq!(merged.exports.len(), 1, "value is declared once");
}

/// What a set must do when each kind is compiled by itself: run, or fail with the error of the
/// first kind that does not compile.
fn expected_by_compiling_each_kind(
    language: &tree_sitter::Language,
    texts: [&str; 4],
) -> std::result::Result<(), String> {
    for text in texts.iter().filter(|text| !text.trim().is_empty()) {
        compile_query(language, text)?;
    }
    Ok(())
}

#[test]
fn a_set_runs_exactly_when_each_of_its_kinds_compiles_by_itself() {
    // Kinds that define captures, read their own, read one an earlier or a later kind defines, or
    // read one before they define it.
    const SNIPPETS: [&str; 9] = [
        "(identifier) @a",
        "(identifier) @b",
        "((identifier) @a (#eq? @a \"x\"))",
        "((identifier) @b (#eq? @a \"x\"))",
        "((identifier) (#eq? @a \"x\") (identifier) @a)",
        "((string) @s (#eq? @s @a))",
        "(string) @s",
        "((identifier) @c (#set! role \"x\"))",
        "; only a comment",
    ];
    let language = language_for_id("ts").expect("typescript language should exist");
    let tree = parse_root(TS_SOURCE, "ts");
    let mut cases: Vec<[&str; 4]> = Vec::new();
    for imports in SNIPPETS {
        for exports in SNIPPETS {
            cases.push([imports, exports, "", ""]);
        }
    }
    // A capture the first kind defines, read by a kind two places later.
    for locals in SNIPPETS {
        cases.push(["(identifier) @a", "(string) @s", locals, ""]);
    }

    let (mut ran, mut merged_but_invalid_alone) = (0, 0);
    for texts in cases {
        let set = private_set("ts", texts[0], texts[1], texts[2], texts[3]);
        let outcome = set.execute(TS_SOURCE, tree.root_node());
        match expected_by_compiling_each_kind(&language, texts) {
            Ok(()) => {
                outcome.unwrap_or_else(|error| {
                    panic!("{texts:?} compiles kind by kind, but the set failed: {error}")
                });
                ran += 1;
            }
            Err(alone) => {
                let error = outcome.expect_err(&format!(
                    "{texts:?} should fail with its invalid kind's error"
                ));
                assert_eq!(
                    error.to_string(),
                    napi::Error::from_reason(alone).to_string(),
                    "{texts:?}"
                );
                let merged_text = texts.join("\n") + "\n";
                if compile_query(&language, &merged_text).is_ok() {
                    merged_but_invalid_alone += 1;
                }
            }
        }
    }

    assert!(ran > 20, "the cases should include sets that run: {ran}");
    assert!(
        merged_but_invalid_alone > 5,
        "the cases should include sets whose merged text compiles but a kind does not: {merged_but_invalid_alone}"
    );
}

#[test]
fn registered_sets_run_a_smoke_query_in_every_supported_language() {
    for language_id in supported_language_ids() {
        let (source, query) = smoke_case(language_id.as_str());
        let id = register(language_id.as_str(), query, "", query, "");
        let results = run_language_queries(source.to_string(), id).unwrap_or_else(|error| {
            panic!("registered smoke set failed for {language_id}: {error}")
        });

        assert!(
            !results.imports.is_empty() && !results.locals.is_empty(),
            "expected the registered smoke queries to match for {language_id}"
        );
    }
}

#[test]
fn the_caller_query_cache_keeps_a_repeated_query_warm() {
    let mut cache = AdHocQueryCache::with_capacity(2);
    let query_text = "(identifier) @name";

    let first = cache.entry("js", query_text);
    let second = cache.entry("js", query_text);

    assert!(
        Arc::ptr_eq(&first, &second),
        "repeating a query must reuse its compiled entry"
    );
    assert_eq!(cache.len(), 1, "repeating a query must not grow the cache");
    assert!(cache.contains("js", query_text));
}

#[test]
fn the_caller_query_cache_evicts_lru_entries_after_capacity() {
    let mut cache = AdHocQueryCache::with_capacity(2);
    let first = "(identifier) @first";
    let second = "(identifier) @second";
    let third = "(identifier) @third";

    cache.entry("js", first);
    cache.entry("js", second);
    cache.entry("js", first);
    cache.entry("js", third);

    assert_eq!(cache.len(), 2, "cache must not grow past capacity");
    assert!(
        cache.contains("js", first),
        "recently used query must remain"
    );
    assert!(cache.contains("js", third), "newest query must remain");
    assert!(
        !cache.contains("js", second),
        "least recently used query must be evicted"
    );
}

#[test]
fn the_caller_query_cache_releases_inner_capacity_after_partial_eviction() {
    let mut cache = AdHocQueryCache::with_capacity(50);

    for i in 0..50 {
        cache.entry("js", &format!("(identifier) @q{i}"));
    }
    let peak_capacity = cache.language_query_capacity("js");
    assert_eq!(
        cache.len(),
        50,
        "cache must hold every js query up to capacity"
    );

    for i in 0..40 {
        cache.entry("ts", &format!("(identifier) @r{i}"));
    }

    assert_eq!(cache.len(), 50, "cache must not grow past capacity");
    let remaining_js: usize = (0..50)
        .filter(|i| cache.contains("js", &format!("(identifier) @q{i}")))
        .count();
    assert_eq!(
        remaining_js, 10,
        "only the most recently used js queries should survive eviction"
    );
    let shrunk_capacity = cache.language_query_capacity("js");
    assert!(
        shrunk_capacity < peak_capacity,
        "js query map must release capacity from its historical peak after eviction, \
         got shrunk_capacity={shrunk_capacity} peak_capacity={peak_capacity}"
    );
}

#[test]
fn threads_running_the_same_caller_query_agree() {
    // The entry is shared, so threads that ask while it compiles wait for one compile.
    let source = "export const first = 1;\nexport const second = 2;";
    let query =
        "(lexical_declaration (variable_declarator name: (identifier) @shared_caller_name))";
    let barrier = std::sync::Barrier::new(8);

    let results: Vec<Vec<String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|_| {
                scope.spawn(|| {
                    barrier.wait();
                    let results =
                        run_query(source.to_string(), "ts".to_string(), query.to_string())
                            .expect("caller query should run");
                    first_capture_texts(&results.matches)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().expect("thread should finish"))
            .collect()
    });

    assert!(results.iter().all(|texts| texts == &["first", "second"]));
}

    #[test]
    fn smoke_cases_cover_all_supported_language_ids() {
        let supported: HashSet<String> = supported_language_ids().into_iter().collect();
        let smoke_cases: HashSet<String> = smoke_case_language_ids()
            .into_iter()
            .map(str::to_string)
            .collect();

        assert_eq!(
            smoke_cases, supported,
            "smoke-case table must stay in sync with supported language ids"
        );
    }

    #[test]
    fn every_supported_language_parses_and_executes_a_smoke_query() {
        for language_id in supported_language_ids() {
            let (source, query) = smoke_case(language_id.as_str());
            let language = language_for_id(language_id.as_str())
                .expect("supported language should resolve to a parser language");
            let tree = parse_root(source, language_id.as_str());
            let matches = execute_query(source, tree.root_node(), language, query)
                .unwrap_or_else(|error| panic!("smoke query failed for {language_id}: {error}"));

            assert!(
                !matches.is_empty(),
                "expected smoke query to produce at least one match for {language_id}"
            );
        }
    }

#[test]
fn repeated_calls_with_same_language_produce_same_results() {
    // Verifies parser reuse and the shared compiled queries produce consistent results
    let source = "import { foo } from './bar';\nexport const x = 1;";
    let id = register_locals(
        "ts",
        "(lexical_declaration (variable_declarator name: (identifier) @name))",
    );

    let first = run_language_queries(source.to_string(), id).expect("first call should succeed");
    let second = run_language_queries(source.to_string(), id).expect("second call should succeed");

    assert_eq!(first.locals.len(), second.locals.len());
    assert_eq!(
        first_capture_texts(&first.locals),
        first_capture_texts(&second.locals),
    );
}

#[test]
fn different_query_texts_do_not_cross_contaminate() {
    let source = "export const value = 1;\nfunction helper() {}";
    let id_a = register_locals(
        "ts",
        "(lexical_declaration (variable_declarator name: (identifier) @name))",
    );
    let id_b = register_locals("ts", "(function_declaration name: (identifier) @name)");

    let results_a = run_language_queries(source.to_string(), id_a).expect("query A should succeed");
    let results_b = run_language_queries(source.to_string(), id_b).expect("query B should succeed");

    assert_eq!(first_capture_texts(&results_a.locals), vec!["value"]);
    assert_eq!(first_capture_texts(&results_b.locals), vec!["helper"]);
}

#[test]
fn compact_imports_query_returns_name_and_text_only() {
    let id = register_query_set(
        "js".to_string(),
        "(import_statement (string) @mod) @stmt".to_string(),
        "".to_string(),
        "".to_string(),
        "".to_string(),
    )
    .expect("imports-only set should register");
    let results = run_imports_query_compact(
        "import { helper } from \"./dep.js\";\nconst value = helper();".to_string(),
        id,
    )
    .expect("compact imports query should succeed");

    assert_eq!(results.imports.len(), 1);
    let captures = &results.imports[0].captures;
    assert!(captures.iter().any(|c| c.name == "mod"));
    assert!(captures.iter().any(|c| c.name == "stmt"));
}

#[test]
fn compact_imports_only_runs_the_imports_query_of_the_set() {
    // The set's other kinds would match too; only the imports query may run.
    let id = register_query_set(
        "js".to_string(),
        "(import_statement (string) @mod) @stmt".to_string(),
        "(function_declaration name: (identifier) @name)".to_string(),
        "(variable_declarator name: (identifier) @name)".to_string(),
        "".to_string(),
    )
    .expect("full set should register");
    let results = run_imports_query_compact(
        "import { helper } from \"./dep.js\";\nfunction f() {}\nconst value = helper();"
            .to_string(),
        id,
    )
    .expect("compact imports query should succeed");

    assert_eq!(results.imports.len(), 1);
    assert!(results.imports[0].captures.iter().all(|c| c.name != "name"));
}

#[test]
fn compact_imports_returns_empty_for_blank_query() {
    let id = register_query_set(
        "ts".to_string(),
        "   ".to_string(),
        "".to_string(),
        "".to_string(),
        "".to_string(),
    )
    .expect("blank set should register");
    let results = run_imports_query_compact("export const x = 1;".to_string(), id)
        .expect("compact blank query should succeed");

    assert!(results.imports.is_empty());
}

#[test]
fn run_query_returns_full_capture_metadata() {
    let results = run_query(
        "export function helper() { return 1; }".to_string(),
        "ts".to_string(),
        "(function_declaration name: (identifier) @name)".to_string(),
    )
    .expect("single query should succeed");

    assert_eq!(results.matches.len(), 1);
    let capture = &results.matches[0].captures[0];
    assert_eq!(capture.name, "name");
    assert_eq!(capture.text, "helper");
    assert_eq!(capture.node_type, "identifier");
    assert!(capture.start.index < capture.end.index);
}

#[test]
fn parse_syntax_tree_projects_parent_and_child_links() {
    let tree = parse_syntax_tree_columns("const value = 1;", "js")
        .expect("syntax tree projection should succeed");

    assert_eq!(tree.root_id, 0);
    assert!(tree.node_count() > 0);
    let root = tree.root_id as usize;
    assert_eq!(tree.parent_ids[root], -1);

    let root_children = tree.child_offsets[root + 1] - tree.child_offsets[root];
    assert!(root_children > 0, "root should project its children");

    let first_child = tree.child_ids[tree.child_offsets[root] as usize] as usize;
    assert_eq!(tree.parent_ids[first_child], tree.root_id as i32);
    assert_eq!(tree.kinds[tree.kind_ids[root] as usize], "program");
}

#[test]
fn parse_syntax_tree_rejects_unsupported_languages() {
    // `expect_err` would need `Debug` on the projected tree, which holds typed arrays.
    let Err(error) = parse_syntax_tree_columns("value", "unknown") else {
        panic!("unsupported language should fail");
    };

    assert!(
        error.to_string().contains("Unsupported language"),
        "unexpected error: {error}"
    );
}

#[test]
fn typescript_and_tsx_parse_adjacent_generic_call_signatures_without_semicolons() {
    let source = "export interface Handler {\n  <T0>(): Forward<T0>\n  <T1>(): Forward<T1>\n  <T2>(): Forward<T2>\n}\ntype Forward<T> = T;\n";
    for language_id in ["ts", "tsx"] {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(parse_root(source, language_id));
        });
        let tree = receiver
            .recv_timeout(std::time::Duration::from_secs(20))
            .unwrap_or_else(|_| panic!("{language_id} parser did not return"));
        let root = tree.root_node();
        assert!(!root.has_error(), "{language_id}: {}", root.to_sexp());
        let exported = root.named_child(0).expect("interface export");
        let alias = root.named_child(1).expect("forward alias");
        assert_eq!(exported.kind(), "export_statement", "{language_id}");
        assert_eq!(alias.kind(), "type_alias_declaration", "{language_id}");
        let alias_name = alias.child_by_field_name("name").expect("alias name");
        assert_eq!(alias_name.utf8_text(source.as_bytes()).unwrap(), "Forward");
        let interface = exported.child_by_field_name("declaration").expect("interface");
        let body = interface.child_by_field_name("body").expect("interface body");
        assert_eq!(body.named_child_count(), 3, "{language_id}");
    }
}

#[test]
fn typescript_pins_split_generic_method_parse_limit() {
    let cases = [
        (
            "class method",
            "class A {\n m\n <T>() {}\n}\n",
            "(program (class_declaration name: (type_identifier) body: (class_body (public_field_definition name: (property_identifier)) (method_definition name: (MISSING property_identifier) type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters) body: (statement_block)))))",
            true,
        ),
        (
            "abstract method",
            "abstract class A {\n abstract m\n <T>(): void\n}\n",
            "(program (abstract_class_declaration name: (type_identifier) body: (class_body (public_field_definition name: (property_identifier)) (method_signature name: (MISSING property_identifier) type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters) return_type: (type_annotation (predefined_type))))))",
            true,
        ),
        (
            "ambient method",
            "declare class A {\n m\n <T>(): void\n}\n",
            "(program (ambient_declaration (class_declaration name: (type_identifier) body: (class_body (public_field_definition name: (property_identifier)) (method_signature name: (MISSING property_identifier) type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters) return_type: (type_annotation (predefined_type)))))))",
            true,
        ),
        (
            "interface method",
            "interface A {\n m\n <T>(): void\n}\n",
            "(program (interface_declaration name: (type_identifier) body: (interface_body (property_signature name: (property_identifier)) (call_signature type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters) return_type: (type_annotation (predefined_type))))))",
            false,
        ),
        (
            "type-literal method",
            "type A = {\n m\n <T>(): void\n}\n",
            "(program (type_alias_declaration name: (type_identifier) value: (object_type (property_signature name: (property_identifier)) (call_signature type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters) return_type: (type_annotation (predefined_type))))))",
            false,
        ),
    ];
    for (label, source, expected, has_error) in cases {
        for language_id in ["ts", "tsx"] {
            let tree = parse_root(source, language_id);
            let root = tree.root_node();
            assert_eq!(root.to_sexp(), expected, "{label} {language_id}");
            assert_eq!(root.has_error(), has_error, "{label} {language_id}");
        }
    }
}

#[test]
fn typescript_and_tsx_pin_semicolonless_generic_member_contexts() {
    fn first_member_body(node: tree_sitter::Node<'_>) -> Option<tree_sitter::Node<'_>> {
        if node.kind() == "interface_body" || node.kind() == "object_type" {
            return Some(node);
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            if let Some(body) = first_member_body(child) {
                return Some(body);
            }
        }
        None
    }
    let cases: &[(&str, &str, &[&str], &[&str], usize)] = &[
        (
            "Hono-style multiline type parameters and Promise returns",
            "export interface H {\n <T0 extends string,\n  I0 = unknown\n >(): Promise<Forward<T0>>\n <T1 extends number,\n  I1 = unknown\n >(): Promise<Forward<T1>>\n <T2>(): Promise<Forward<T2>>\n}\ntype Forward<T> = T;\n",
            &["export_statement", "type_alias_declaration"],
            &["call_signature", "call_signature", "call_signature"],
            0,
        ),
        (
            "method then call",
            "interface H {\n method(): void\n <T>(): Promise<T>\n}\n",
            &["interface_declaration"],
            &["method_signature", "call_signature"],
            0,
        ),
        (
            "property then call",
            "interface H {\n prop: number\n <T>(): Promise<T>\n}\n",
            &["interface_declaration"],
            &["property_signature", "call_signature"],
            0,
        ),
        (
            "type literal",
            "type L = {\n <T>(): Promise<T>\n <U>(): Promise<U>\n};\ntype Alias<T> = T;\n",
            &["type_alias_declaration", "type_alias_declaration"],
            &["call_signature", "call_signature"],
            0,
        ),
        (
            "ambient module",
            "declare module \"pkg\" {\n export interface H {\n  <T>(): Promise<T>\n  <U>(): Promise<U>\n }\n}\ntype Alias<T> = T;\n",
            &["ambient_declaration", "type_alias_declaration"],
            &["call_signature", "call_signature"],
            0,
        ),
        (
            "comments, blank lines, and CRLF",
            "interface H {\r\n <T>(): Promise<T> // first\r\n\r\n /* between */\r\n <U>(): Promise<U>\r\n}\r\ntype Alias<T> = T;\r\n",
            &["interface_declaration", "type_alias_declaration"],
            &["call_signature", "call_signature"],
            2,
        ),
        (
            "multiline JSDoc with less-than at line start",
            "interface H {\n <T>(): Promise<T>\n /**\n  * <U>(): Alias\n  * @example <div />\n  */\n <U>(): Promise<U>\n}\n",
            &["interface_declaration"],
            &["call_signature", "call_signature"],
            1,
        ),
        (
            "consecutive line comments",
            "interface H {\n <T>(): Promise<T>\n // first\n // second\n <U>(): Promise<U>\n}\n",
            &["interface_declaration"],
            &["call_signature", "call_signature"],
            2,
        ),
        (
            "TypeScript ignore directive",
            "interface H {\n <T>(): Promise<T>\n // @ts-ignore\n <U>(): Promise<U>\n}\n",
            &["interface_declaration"],
            &["call_signature", "call_signature"],
            1,
        ),
        (
            "index signature before call",
            "interface H {\n [key: string]: unknown\n <T>(): Promise<T>\n}\n",
            &["interface_declaration"],
            &["index_signature", "call_signature"],
            0,
        ),
        (
            "construct signature before call",
            "interface H {\n new(name: string): H\n <T>(): Promise<T>\n}\n",
            &["interface_declaration"],
            &["construct_signature", "call_signature"],
            0,
        ),
        (
            "getter signature before call",
            "interface H {\n get name(): string\n <T>(): Promise<T>\n}\n",
            &["interface_declaration"],
            &["method_signature", "call_signature"],
            0,
        ),
        (
            "optional method before call",
            "interface H {\n method?(): void\n <T>(): Promise<T>\n}\n",
            &["interface_declaration"],
            &["method_signature", "call_signature"],
            0,
        ),
        (
            "readonly property before call",
            "interface H {\n readonly name: string\n <T>(): Promise<T>\n}\n",
            &["interface_declaration"],
            &["property_signature", "call_signature"],
            0,
        ),
    ];
    for &(label, source, top_kinds, member_kinds, expected_comments) in cases {
        for language_id in ["ts", "tsx"] {
            let tree = parse_root(source, language_id);
            let root = tree.root_node();
            assert!(!root.has_error(), "{label} {language_id}: {}", root.to_sexp());
            let mut top_cursor = root.walk();
            let mut top_nodes = root.named_children(&mut top_cursor);
            for &kind in top_kinds {
                assert_eq!(top_nodes.next().expect("top-level declaration").kind(), kind, "{label} {language_id}");
            }
            assert!(top_nodes.next().is_none(), "{label} {language_id}: extra top-level node");
            let body = first_member_body(root).expect("interface or type-literal body");
            let mut cursor = body.walk();
            let mut members = body.named_children(&mut cursor);
            let mut comments = 0;
            for &kind in member_kinds {
                let member = loop {
                    let child = members.next().expect("declared member");
                    if child.kind() != "comment" {
                        break child;
                    }
                    comments += 1;
                };
                assert_eq!(member.kind(), kind, "{label} {language_id}");
                if kind == "call_signature" {
                    let return_type = member.child_by_field_name("return_type").expect("call return type");
                    assert!(
                        return_type
                            .utf8_text(source.as_bytes())
                            .expect("return type text")
                            .contains("Promise<"),
                        "{label} {language_id}: {}",
                        return_type.to_sexp(),
                    );
                }
            }
            for trailing in members {
                assert_eq!(trailing.kind(), "comment", "{label} {language_id}: extra member");
                comments += 1;
            }
            assert_eq!(comments, expected_comments, "{label} {language_id}");
        }
    }
}

#[test]
fn typescript_and_tsx_preserve_less_than_and_jsx_expression_trees() {
    let cases = [
        (
            "ts comparison",
            "ts",
            "const a = 1, b = 2;\nconst value = a\n< b;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (number)) (variable_declarator name: (identifier) value: (number))) (lexical_declaration (variable_declarator name: (identifier) value: (binary_expression left: (identifier) right: (identifier)))))",
        ),
        (
            "ts generic call",
            "ts",
            "declare function f<T>(value: T): T;\nconst got = f\n<string>('ok');\n",
            concat!(
                "(program (ambient_declaration (function_signature name: (identifier) type_parameters: (type_parameters ",
                "(type_parameter name: (type_identifier))) parameters: (formal_parameters (required_parameter pattern: ",
                "(identifier) type: (type_annotation (type_identifier)))) return_type: (type_annotation (type_identifier)))) ",
                "(lexical_declaration (variable_declarator name: (identifier) value: (call_expression function: (identifier) ",
                "type_arguments: (type_arguments (predefined_type)) arguments: (arguments (string (string_fragment)))))))",
            ),
        ),
        (
            "tsx jsx after semicolon",
            "tsx",
            "const before = 1;\n<div />;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (number))) (expression_statement (jsx_self_closing_element name: (identifier))))",
        ),
        (
            "tsx jsx without semicolon",
            "tsx",
            "const before = 1\n<div />;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (binary_expression left: (number) right: (identifier))) (ERROR)))",
        ),
        (
            "tsx jsx return",
            "tsx",
            "function view() {\n  const before = 1\n  return <div />\n}\n",
            "(program (function_declaration name: (identifier) parameters: (formal_parameters) body: (statement_block (lexical_declaration (variable_declarator name: (identifier) value: (number))) (return_statement (jsx_self_closing_element name: (identifier))))))",
        ),
    ];
    for (label, language_id, source, expected) in cases {
        let tree = parse_root(source, language_id);
        assert_eq!(tree.root_node().to_sexp(), expected, "{label}");
    }
}

#[test]
fn typescript_and_tsx_pin_statement_start_and_return_asi_trees() {
    let cases = [
        (
            "type alias followed by generic arrow",
            "ts",
            "type A = B\n<T,>(value: T) => value\n",
            "(program (type_alias_declaration name: (type_identifier) value: (type_identifier)) (expression_statement (arrow_function type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters (required_parameter pattern: (identifier) type: (type_annotation (type_identifier)))) body: (identifier))))",
        ),
        (
            "import followed by generic arrow",
            "ts",
            "import x from \"y\"\n<T,>(value: T) => value\n",
            "(program (import_statement (import_clause (identifier)) source: (string (string_fragment))) (expression_statement (arrow_function type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters (required_parameter pattern: (identifier) type: (type_annotation (type_identifier)))) body: (identifier))))",
        ),
        (
            "function signature followed by generic arrow",
            "ts",
            "function f(): B\n<T,>(value: T) => value\n",
            "(program (function_signature name: (identifier) parameters: (formal_parameters) return_type: (type_annotation (type_identifier))) (expression_statement (arrow_function type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters (required_parameter pattern: (identifier) type: (type_annotation (type_identifier)))) body: (identifier))))",
        ),
        (
            "return then JSX expression",
            "tsx",
            "function render() { return\n<div /> }\n",
            "(program (function_declaration name: (identifier) parameters: (formal_parameters) body: (statement_block (return_statement) (expression_statement (jsx_self_closing_element name: (identifier))))))",
        ),
        (
            "return then generic arrow",
            "tsx",
            "function build() { return\n<T,>(x: T) => x }\n",
            "(program (function_declaration name: (identifier) parameters: (formal_parameters) body: (statement_block (return_statement) (expression_statement (arrow_function type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters (required_parameter pattern: (identifier) type: (type_annotation (type_identifier)))) body: (identifier))))))",
        ),
    ];
    for (label, language_id, source, expected) in cases {
        let tree = parse_root(source, language_id);
        let root = tree.root_node();
        assert!(!root.has_error(), "{label}: {}", root.to_sexp());
        assert_eq!(root.to_sexp(), expected, "{label}");
    }
}

#[test]
fn javascript_keeps_jsx_on_the_return_statement_after_a_newline() {
    let source = "function render() { return\n<div /> }\n";
    let root = parse_root(source, "js");
    assert_eq!(
        root.root_node().to_sexp(),
        "(program (function_declaration name: (identifier) parameters: (formal_parameters) body: (statement_block (return_statement (jsx_self_closing_element name: (identifier))))))",
    );
}

#[test]
fn typescript_and_tsx_pin_import_type_before_semicolonless_signature_parse_limit() {
    let source = "interface H {\n <T>(): import('x').Foo<string>\n <U>(): Promise<U>\n}\n";
    for language_id in ["ts", "tsx"] {
        let tree = parse_root(source, language_id);
        let root = tree.root_node();
        assert!(root.has_error(), "{language_id}: {}", root.to_sexp());
        if language_id == "ts" {
            assert_eq!(
                root.to_sexp(),
                "(program (interface_declaration name: (type_identifier) body: (interface_body (call_signature type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters) return_type: (type_annotation (member_expression object: (call_expression function: (import) arguments: (arguments (string (string_fragment)))) property: (property_identifier)))) (MISSING \"}\"))) (ERROR (type_arguments (predefined_type)) type_parameters: (type_parameters (type_parameter name: (type_identifier))) parameters: (formal_parameters) return_type: (type_annotation (generic_type name: (type_identifier) type_arguments: (type_arguments (type_identifier))))))",
            );
        } else {
            assert!(root.to_sexp().contains("(jsx_opening_element"), "tsx: {}", root.to_sexp());
        }
    }
}

#[test]
fn typescript_preserves_non_declaration_less_than_trees() {
    let cases = [
        (
            "as type",
            "const value = x as Foo\n< 5;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (as_expression (identifier) (generic_type name: (type_identifier) type_arguments: (type_arguments (literal_type (number)) (MISSING \">\")))))))",
        ),
        (
            "satisfies type",
            "const value = x satisfies Foo\n< 5;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (satisfies_expression (identifier) (generic_type name: (type_identifier) type_arguments: (type_arguments (literal_type (number)) (MISSING \">\")))))))",
        ),
        (
            "non-null expression",
            "const value = x!\n< y;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (binary_expression left: (non_null_expression (identifier)) right: (identifier)))))",
        ),
        (
            "angle-bracket assertion",
            "const value = <T>x;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (type_assertion (type_arguments (type_identifier)) (identifier)))))",
        ),
        (
            "constructed generic type",
            "const value = new X\n<T>();\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (new_expression constructor: (identifier) type_arguments: (type_arguments (type_identifier)) arguments: (arguments)))))",
        ),
        (
            "generic-like tagged template",
            "const value = tag\n<T>`hello`;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (binary_expression left: (binary_expression left: (identifier) right: (identifier)) right: (template_string (string_fragment))))))",
        ),
        (
            "tagged template across a newline",
            "const value = tag\n`hello`;\n",
            "(program (lexical_declaration (variable_declarator name: (identifier) value: (call_expression function: (identifier) arguments: (template_string (string_fragment))))))",
        ),
        (
            "class heritage type arguments",
            "class C extends B\n<T> {}\n",
            "(program (class_declaration name: (type_identifier) (class_heritage (extends_clause value: (identifier) type_arguments: (type_arguments (type_identifier)))) body: (class_body)))",
        ),
    ];
    for (label, source, expected) in cases {
        for language_id in ["ts", "tsx"] {
            let tree = parse_root(source, language_id);
            let root = tree.root_node();
            if language_id == "tsx" && label == "angle-bracket assertion" {
                assert!(root.has_error(), "{label}: {}", root.to_sexp());
                assert!(root.to_sexp().contains("(jsx_opening_element"), "{label}: {}", root.to_sexp());
            } else {
                assert_eq!(root.to_sexp(), expected, "{label} {language_id}");
            }
        }
    }
}

/// Parses Kotlin source on a worker thread so a scanner that never returns fails the test
/// instead of hanging the suite. Also returns how long the parse took.
fn parse_kotlin_timed(
    source: &str,
    deadline: std::time::Duration,
) -> (tree_sitter::Tree, std::time::Duration) {
    let owned = source.to_string();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let language = language_for_id("kotlin").expect("kotlin language should exist");
        let mut parser = Parser::new();
        parser
            .set_language(&language)
            .expect("parser language should be set");
        let started = std::time::Instant::now();
        let tree = parser.parse(owned, None).expect("source should parse into a tree");
        let _ = sender.send((tree, started.elapsed()));
    });
    receiver.recv_timeout(deadline).unwrap_or_else(|_| {
        let head: String = source.chars().take(80).collect();
        panic!(
            "Kotlin parse of {} bytes did not return within {deadline:?}: {head:?}",
            source.len()
        )
    })
}

fn parse_kotlin_within_deadline(source: &str) -> tree_sitter::Tree {
    parse_kotlin_timed(source, std::time::Duration::from_secs(20)).0
}

#[test]
fn kotlin_parse_returns_for_files_ending_mid_annotation() {
    let truncated_real_snippet =
        "package demo\n\nclass Repo {\n    val items = listOf(1, 2)\n\n    @Deprecated(\"use find\"\n    @get";
    for source in [
        "val x = 1\n\n@Ann",
        "class A {\n  val x = 1\n  @get",
        "class A {\n  val x = 1\n  @set:Foo",
        "class A @",
        "class A\n@constructor",
        "val x = 1\n@",
        "class A {\n  var x = 1\n    @Ann(1",
        truncated_real_snippet,
    ] {
        let tree = parse_kotlin_within_deadline(source);
        assert_eq!(tree.root_node().kind(), "source_file", "{source:?}");
        assert_eq!(tree.root_node().end_byte(), source.len(), "{source:?}");
    }
}

#[test]
fn kotlin_parse_accepts_one_line_class_bodies() {
    let tree = parse_kotlin_within_deadline("class A { val x = 1 }\nclass B { val y = 2 }\n");
    let root = tree.root_node();
    assert!(!root.has_error(), "unexpected error: {}", root.to_sexp());
    let mut cursor = root.walk();
    let classes: Vec<_> = root
        .named_children(&mut cursor)
        .filter(|node| node.kind() == "class_declaration")
        .collect();
    assert_eq!(classes.len(), 2, "{}", root.to_sexp());
}

#[test]
fn kotlin_parse_accepts_forms_the_published_grammar_rejects() {
    let cases = [
        "val items: List<Int> = []\n",
        "class A { val dynamic = 1\n  fun f() = dynamic }\n",
        "fun f(x: Int) {\n  val final = x\n  final.toString()\n}\n",
        "val raw = $$\"price: ${'$'}1 $${1 + 1}\"\n",
        "class Outer {\n  class Inner\n  private constructor(x: Int)\n}\n",
        "class ByteString\ninternal actual constructor(\n  data: ByteArray,\n)\n",
    ];
    for source in cases {
        let tree = parse_kotlin_within_deadline(source);
        let root = tree.root_node();
        assert!(!root.has_error(), "unexpected error for {source:?}: {}", root.to_sexp());
    }

    let raw = parse_kotlin_within_deadline("val raw = $$\"a $${b} $c\"\n");
    let sexp = raw.root_node().to_sexp();
    assert!(sexp.contains("multi_dollar_string_literal"), "{sexp}");
    // A template is a node with a name, so the name is a reference; `$c` has fewer dollars than the prefix and is text.
    assert!(sexp.contains("(interpolation (identifier))"), "{sexp}");
    assert_eq!(sexp.matches("(interpolation").count(), 1, "{sexp}");

    // A letter above ASCII, `_` or a quoted name starts a template on every platform. `$\u{f1}ame` has fewer dollars
    // than the prefix and is text.
    let names = parse_kotlin_within_deadline("val raw = $$\"a $$\u{f1}ame $$_x $$`my name` $\u{f1}ame\"\n");
    let sexp = names.root_node().to_sexp();
    assert!(!names.root_node().has_error(), "{sexp}");
    assert_eq!(sexp.matches("(interpolation").count(), 3, "{sexp}");
}

#[test]
fn kotlin_parse_reads_names_written_with_cjk_hangul_and_supplementary_letters() {
    // U+540D U+524D are CJK ideographs, U+D55C U+AE00 Hangul syllables, and U+20BB7 a CJK ideograph above the
    // basic plane. The grammar generated by an older tree-sitter-cli read none of them as a name.
    let cases = [
        "val \u{540d}\u{524d} = 1\n",
        "val \u{d55c}\u{ae00} = 2\n",
        "class \u{20bb7}\n",
        "fun \u{540d}\u{524d}(\u{d55c}\u{ae00}: Int) = \u{d55c}\u{ae00}\n",
        "\u{540d}\u{524d}@ for (i in 0..1) {}\n",
    ];
    for source in cases {
        let tree = parse_kotlin_within_deadline(source);
        let root = tree.root_node();
        assert!(!root.has_error(), "unexpected error for {source:?}: {}", root.to_sexp());
    }

    // The names also start templates: one dollar in a raw string, two in a `$$` string.
    let raw = parse_kotlin_within_deadline("val raw = \"\"\"x $\u{540d}\u{524d} y\"\"\"\n");
    assert!(!raw.root_node().has_error(), "{}", raw.root_node().to_sexp());
    assert_eq!(raw.root_node().to_sexp().matches("(interpolation").count(), 1);
    let multi = parse_kotlin_within_deadline("val raw = $$\"x $$\u{d55c}\u{ae00} $$\u{20bb7} $\u{540d}\u{524d}\"\n");
    assert!(!multi.root_node().has_error(), "{}", multi.root_node().to_sexp());
    assert_eq!(multi.root_node().to_sexp().matches("(interpolation").count(), 2);
}

/// The statements of the first `block` in `tree` as (kind, text). The text of a call is its callee, so the shape of a
/// body shows which names were read as calls and where each statement ends, without the arguments.
fn kotlin_block_statements(tree: &tree_sitter::Tree, source: &str) -> Vec<(String, String)> {
    let mut stack = vec![tree.root_node()];
    while let Some(node) = stack.pop() {
        if node.kind() == "block" {
            let mut cursor = node.walk();
            let statements: Vec<(String, String)> = node
                .named_children(&mut cursor)
                .map(|statement| {
                    let shown = match statement.kind() {
                        "call_expression" => statement.child(0).unwrap_or(statement),
                        _ => statement,
                    };
                    (statement.kind().to_string(), source[shown.byte_range()].to_string())
                })
                .collect();
            return statements;
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    Vec::new()
}

/// The text of every `identifier` in `tree`, in order.
fn kotlin_identifiers(tree: &tree_sitter::Tree, source: &str) -> Vec<String> {
    let mut identifiers = Vec::new();
    let mut cursor = tree.walk();
    'walk: loop {
        let node = cursor.node();
        if node.kind() == "identifier" {
            identifiers.push(source[node.byte_range()].to_string());
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                break 'walk;
            }
        }
    }
    identifiers
}

#[test]
fn kotlin_parse_reads_a_name_that_starts_with_a_keyword_and_goes_on_with_a_letter_or_digit_above_ascii() {
    // The grammar's scanner compares the word at the start of a line with `else`, `in`, `as`, `by`, `where` and the
    // like to decide whether the line continues the statement above. A longer name that starts with one of them is a
    // call on a new statement. The scanner once found the end of the word with `iswalpha` and `iswalnum`, which the C
    // library and its locale decide: on Linux a letter above ASCII ended the word, the keyword was read, and the call
    // became an infix call on the statement above without a parse error, while Windows read a call. A decimal digit
    // above ASCII, which the lexer reads in a name after its first character, ended the word on every platform. The
    // tree has to be the same on every platform.
    let keywords = ["else", "in", "instanceof", "get", "set", "constructor", "by", "as", "where"];
    // U+C5 is a Latin letter that every version of the grammar reads, so for it the platform is the only difference.
    // Then come CJK ideographs, Hangul syllables and a CJK ideograph above the basic plane. The last four are decimal
    // digits: Arabic-Indic U+661, Devanagari U+967, fullwidth U+FF11 and, above the basic plane, U+1D7CE.
    let suffixes = [
        "\u{c5}",
        "\u{540d}\u{524d}",
        "\u{d55c}\u{ae00}",
        "\u{20bb7}",
        "\u{661}",
        "\u{967}",
        "\u{ff11}",
        "\u{1d7ce}",
    ];
    for keyword in keywords {
        for suffix in suffixes {
            let name = format!("{keyword}{suffix}");
            let source = format!("fun f(x: Int) {{\n  val a = x\n  {name}(a)\n  g(a)\n}}\n");
            let tree = parse_kotlin_within_deadline(&source);
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected error for {source:?}: {}", root.to_sexp());
            // `val a = x` ends before the call, and the callee is the whole name.
            assert_eq!(
                kotlin_block_statements(&tree, &source),
                [
                    ("property_declaration".to_string(), "val a = x".to_string()),
                    ("call_expression".to_string(), name.clone()),
                    ("call_expression".to_string(), "g".to_string()),
                ],
                "statements of {source:?}: {}",
                root.to_sexp()
            );
        }
    }

    // The same boundary decides whether `in`, `!is` and `val` are keywords where a name can also follow on the same
    // line: the condition of a `when` entry and a member after an expression in a class body. The name is one
    // identifier, not the keyword and an error.
    for digit in ["\u{661}", "\u{967}", "\u{ff11}"] {
        let (name_in, name_is, name_val) = (format!("in{digit}"), format!("is{digit}"), format!("val{digit}"));
        let cases = [
            (
                format!("fun g(x: Int) = when (x) {{\n  {name_in} -> 1\n  else -> 2\n}}\n"),
                vec!["g", "x", "Int", "x", name_in.as_str()],
            ),
            (
                format!("fun h() = when {{\n  !{name_is} -> 1\n  else -> 2\n}}\n"),
                vec!["h", name_is.as_str()],
            ),
            (
                format!("class C {{\n  val p = a {name_val} b\n}}\n"),
                vec!["C", "p", "a", name_val.as_str(), "b"],
            ),
        ];
        for (source, identifiers) in cases {
            let tree = parse_kotlin_within_deadline(&source);
            let root = tree.root_node();
            assert!(!root.has_error(), "unexpected error for {source:?}: {}", root.to_sexp());
            assert_eq!(kotlin_identifiers(&tree, &source), identifiers, "identifiers of {source:?}");
        }
    }
}

#[test]
fn kotlin_parse_reads_long_dollar_and_quote_runs_in_linear_time() {
    // Only the last two dollars of a run start a template in a `$$` string, and only the last three quotes of a run
    // close a `$$"""` string. The grammar's scanner once returned one character before them per call and read the
    // whole run again each time, so 200,000 dollars took about a minute. The linear parse takes milliseconds; the
    // bound is far from both.
    let run = "$".repeat(200_000);
    let quotes = "\"".repeat(200_000);
    let source = format!(
        "val a = $$\"{run}name\"\nval b = $$\"\"\"x{run}{{name}}\"\"\"\nval c = $$\"\"\"y{quotes}\"\"\"\n"
    );
    let (tree, elapsed) = parse_kotlin_timed(&source, std::time::Duration::from_secs(10));
    assert!(
        elapsed < std::time::Duration::from_secs(2),
        "the parse took {elapsed:?}"
    );
    let root = tree.root_node();
    assert!(!root.has_error(), "unexpected parse error");

    let mut templates = Vec::new();
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.kind() == "interpolation" {
            templates.push((node.start_byte(), &source[node.byte_range()]));
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    templates.sort();
    let texts: Vec<&str> = templates.iter().map(|(_, text)| *text).collect();
    assert_eq!(texts, ["$$name", "$${name}"]);
}

/// For a tree: how many nodes of `kind` are outside any `ERROR`, how many `ERROR` nodes there are, and how many nodes.
fn kotlin_error_shape(tree: &tree_sitter::Tree, kind: &str) -> (usize, usize, usize) {
    let (mut outside_error, mut errors, mut nodes) = (0, 0, 0);
    let mut stack = vec![(tree.root_node(), false)];
    while let Some((node, inside_error)) = stack.pop() {
        nodes += 1;
        if node.is_error() {
            errors += 1;
        }
        if node.kind() == kind && !inside_error {
            outside_error += 1;
        }
        let inside_error = inside_error || node.is_error();
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor).map(|child| (child, inside_error)));
    }
    (outside_error, errors, nodes)
}

#[test]
fn kotlin_parse_recovers_from_a_stray_dollar_before_names_with_decimal_digits() {
    // A stray `$` between two statements of a lambda, followed by names that start with a keyword and end in a decimal
    // digit above ASCII (U+0663, U+0967, U+1D7CE, U+FF11 and U+0661), made error recovery insert one missing name after
    // another: the 225 bytes took 15 to 100 seconds, then the projection of the tree of hundreds of thousands of nodes
    // failed on its node limit. The parse is bounded by the deadline, which is far from the milliseconds it takes.
    let source = "{x\na\n$ s\u{663}(a)\n  by\u{967}(a)\n(a)\n  where\u{1d7ce}(a)\n  constructor\u{967}(a)\n  instanceof\u{ff11}(a)\n  g(a)\n}\n\nclass C {\n  val p = a val\u{661} b\n}\n\nfun g(x: Int) = when (x) {\n  in\u{661} -> 1\n  else -> 2\n}\n\nfun h() = when {\n  !is\u{967} -> 1\n  else -> 2\n}\n";
    assert_eq!(source.len(), 225);
    let (tree, _) = parse_kotlin_timed(source, std::time::Duration::from_secs(20));
    let root = tree.root_node();
    assert!(root.has_error(), "a stray `$` is a syntax error: {}", root.to_sexp());
    // The `$` is the one thing the parser cannot use: one ERROR, no inserted name, a tree the size of the text, and the
    // class and both functions after it are declarations outside the ERROR.
    let (classes, errors, nodes) = kotlin_error_shape(&tree, "class_declaration");
    assert_eq!((classes, errors), (1, 1), "{}", root.to_sexp());
    assert!(nodes < 500, "{nodes} nodes: {}", root.to_sexp());
    assert!(!root.to_sexp().contains("MISSING"), "{}", root.to_sexp());
    assert_eq!(kotlin_error_shape(&tree, "function_declaration").0, 2, "{}", root.to_sexp());

    // The addon's own parse and projection of the file finish with the tree, not with the node limit.
    let columns = parse_syntax_tree_columns(source, "kotlin").expect("the sample should project");
    assert!(columns.node_count() < 500, "{} nodes", columns.node_count());
    let error_kind = columns.kinds.iter().position(|kind| kind == "ERROR").expect("an ERROR kind") as u32;
    assert_eq!(columns.kind_ids.iter().filter(|kind| **kind == error_kind).count(), 1);
}

#[test]
fn kotlin_parse_keeps_the_declarations_after_a_stray_character() {
    // Error recovery once read everything up to the next template as one token, so the classes after a stray character
    // were not in the tree at all. They are declarations outside the `ERROR`, whatever the stray character is.
    let classes: String = (0..50)
        .map(|index| format!("class C{index} {{\n  val v = {index}\n}}\n"))
        .collect();
    for stray in ["$ ", "$", "$$", "$as\u{663}", "\u{301}", "#", "`"] {
        let source = format!("class A {{\n  val x = 1\n}}\n{stray}\n{classes}");
        let (tree, _) = parse_kotlin_timed(&source, std::time::Duration::from_secs(20));
        assert!(tree.root_node().has_error(), "{stray:?} is not valid Kotlin");
        let (classes_found, _, _) = kotlin_error_shape(&tree, "class_declaration");
        assert_eq!(classes_found, 51, "{stray:?}: {}", tree.root_node().to_sexp());
        let (properties_found, _, _) = kotlin_error_shape(&tree, "property_declaration");
        assert_eq!(properties_found, 51, "{stray:?}");
    }
}

#[test]
fn kotlin_parse_closes_a_class_left_open_at_the_end_of_the_file() {
    // Error recovery needs a `_semi` after the last member to close the class with a missing `}`, and the scanner
    // reports one at the end of the input after a newline or other whitespace.
    for tail in ["\n", "\n   ", "\r\n", "  ", "\n\n\n"] {
        let source = format!("class A {{\n    class B(val a: Int){tail}");
        let (tree, _) = parse_kotlin_timed(&source, std::time::Duration::from_secs(20));
        let root = tree.root_node();
        let (classes, errors, _) = kotlin_error_shape(&tree, "class_declaration");
        assert_eq!((classes, errors), (2, 0), "{source:?}: {}", root.to_sexp());
        assert!(root.to_sexp().contains("(MISSING \"}\")"), "{source:?}: {}", root.to_sexp());
    }
}
