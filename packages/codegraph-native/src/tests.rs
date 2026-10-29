use super::{
    extract_language_parts, parse_syntax_tree_columns, run_imports_query_compact,
    run_language_queries, run_query, supported_language_ids,
};
use crate::projection::ProjectedColumns;
use crate::languages::language_for_id;
use crate::parser_pool::{parse_invocations_for_tests, reset_parse_invocations_for_tests};
use crate::query::{
    execute_language_queries_cached_with_match_limit,
    execute_language_queries_separately,
    execute_query,
    record_merged_query_compile_failure_for_tests,
    try_execute_merged_language_queries,
    try_execute_merged_language_queries_with_match_limit,
    LanguageQueryTexts,
    QueryCache,
};
use crate::types::NativeMatch;
use std::collections::HashSet;
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

    #[test]
    fn run_language_queries_returns_imports_and_locals_for_javascript() {
        let results = run_language_queries(
            "import { helper } from \"./dep.js\";\nconst value = helper();".to_string(),
            "js".to_string(),
            "(import_statement (string) @mod) @stmt".to_string(),
            "".to_string(),
            "(variable_declarator name: (identifier) @name)".to_string(),
            "(import_statement (import_clause (named_imports (import_specifier name: (identifier) @iname))) (string) @from) @stmt"
                .to_string(),
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
            let language = language_for_id(language_id.as_str())
                .expect("supported language should resolve to a parser language");
            let tree = parse_root(source, language_id.as_str());
            let two_patterns = format!("{query}\n{query}");
            let queries = LanguageQueryTexts {
                imports: query,
                exports: two_patterns.as_str(),
                locals: "",
                import_bindings: query,
            };
            let separate = execute_language_queries_separately(
                source,
                tree.root_node(),
                &language,
                language_id.as_str(),
                queries,
            )
            .unwrap_or_else(|error| {
                panic!("separate query execution failed for {language_id}: {error}")
            });
            let merged = try_execute_merged_language_queries(
                source,
                tree.root_node(),
                &language,
                language_id.as_str(),
                queries,
            )
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
    fn cached_merged_compile_failures_skip_retries() {
        let source = "const cachedMergeFailure = 1;";
        let query = "(identifier) @cached_merge_failure";
        let language = language_for_id("ts").expect("typescript language should exist");
        let tree = parse_root(source, "ts");
        record_merged_query_compile_failure_for_tests("ts", &format!("{query}\n{query}\n"));

        let merged = try_execute_merged_language_queries(
            source,
            tree.root_node(),
            &language,
            "ts",
            LanguageQueryTexts {
                imports: query,
                exports: query,
                locals: "",
                import_bindings: "",
            },
        )
        .expect("individual query should compile");

        assert!(
            merged.is_none(),
            "a cached merged compile failure must skip recompiling the same query text"
        );
    }

    #[test]
    fn compiled_query_cache_keeps_a_repeated_query_warm() {
        let language = language_for_id("js").expect("javascript language should exist");
        let mut cache = QueryCache::with_capacity(2);
        let query_text = "(identifier) @name";

        cache
            .get_or_compile("js", &language, query_text)
            .expect("query should compile");
        cache
            .get_or_compile("js", &language, query_text)
            .expect("repeated query should reuse the compiled entry");

        assert_eq!(cache.len(), 1, "repeating a query must not grow the cache");
        assert!(cache.contains("js", query_text));
    }

    #[test]
    fn compiled_query_cache_evicts_lru_entries_after_capacity() {
        let language = language_for_id("js").expect("javascript language should exist");
        let mut cache = QueryCache::with_capacity(2);
        let first = "(identifier) @first";
        let second = "(identifier) @second";
        let third = "(identifier) @third";

        cache
            .get_or_compile("js", &language, first)
            .expect("first query should compile");
        cache
            .get_or_compile("js", &language, second)
            .expect("second query should compile");
        cache
            .get_or_compile("js", &language, first)
            .expect("first query should stay warm");
        cache
            .get_or_compile("js", &language, third)
            .expect("third query should compile");

        assert_eq!(cache.len(), 2, "cache must not grow past capacity");
        assert!(cache.contains("js", first), "recently used query must remain");
        assert!(cache.contains("js", third), "newest query must remain");
        assert!(
            !cache.contains("js", second),
            "least recently used query must be evicted"
        );
    }

    #[test]
    fn merged_query_compile_failure_memo_evicts_after_capacity() {
        let mut cache = QueryCache::with_capacity(2);
        cache.record_failed_merged("ts", "one");
        cache.record_failed_merged("ts", "two");
        assert!(cache.has_failed_merged("ts", "one"));
        cache.touch_failed_merged("ts", "one");
        cache.record_failed_merged("ts", "three");

        assert_eq!(
            cache.failed_merged_len(),
            2,
            "failure memo must not grow past capacity"
        );
        assert!(
            cache.has_failed_merged("ts", "one"),
            "a repeatedly hit merged failure must stay warm instead of evicting as if cold"
        );
        assert!(cache.has_failed_merged("ts", "three"));
        assert!(
            !cache.has_failed_merged("ts", "two"),
            "least recently recorded merged failure must be evicted"
        );
    }

    #[test]
    fn compiled_query_cache_releases_inner_capacity_after_partial_eviction() {
        let js = language_for_id("js").expect("javascript language should exist");
        let ts = language_for_id("ts").expect("typescript language should exist");
        let mut cache = QueryCache::with_capacity(50);

        for i in 0..50 {
            let query_text = format!("(identifier) @q{i}");
            cache
                .get_or_compile("js", &js, &query_text)
                .expect("js query should compile");
        }
        let peak_capacity = cache.language_query_capacity("js");
        assert_eq!(cache.len(), 50, "cache must hold every js query up to capacity");

        for i in 0..40 {
            let query_text = format!("(identifier) @r{i}");
            cache
                .get_or_compile("ts", &ts, &query_text)
                .expect("ts query should compile");
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
    fn merged_query_compile_failure_memo_releases_inner_capacity_after_partial_eviction() {
        let mut cache = QueryCache::with_capacity(50);

        for i in 0..50 {
            cache.record_failed_merged("ts", &format!("query-{i}"));
        }
        let peak_capacity = cache.failed_merged_capacity("ts");
        assert_eq!(cache.failed_merged_len(), 50, "memo must hold every failure up to capacity");

        for i in 0..40 {
            cache.record_failed_merged("py", &format!("query-{i}"));
        }

        assert_eq!(cache.failed_merged_len(), 50, "memo must not grow past capacity");
        let remaining_ts: usize = (0..50)
            .filter(|i| cache.has_failed_merged("ts", &format!("query-{i}")))
            .count();
        assert_eq!(
            remaining_ts, 10,
            "only the most recently recorded ts failures should survive eviction"
        );
        let shrunk_capacity = cache.failed_merged_capacity("ts");
        assert!(
            shrunk_capacity < peak_capacity,
            "failure memo must release capacity from its historical peak after eviction, \
             got shrunk_capacity={shrunk_capacity} peak_capacity={peak_capacity}"
        );
    }

    #[test]
    fn merged_language_queries_skip_single_active_kind() {
        let source = "const singleQueryKind = 1;";
        let query = "(identifier) @single_query_kind";
        let language = language_for_id("ts").expect("typescript language should exist");
        let tree = parse_root(source, "ts");
        let merged = try_execute_merged_language_queries(
            source,
            tree.root_node(),
            &language,
            "ts",
            LanguageQueryTexts {
                imports: query,
                exports: "",
                locals: "",
                import_bindings: "",
            },
        )
        .expect("individual query should compile");

        assert!(
            merged.is_none(),
            "one active query kind should use the independent executor without merged compilation"
        );
    }

    #[test]
    fn merged_language_queries_fall_back_when_the_match_limit_is_exceeded() {
        let source = "/* one */\n/* two */\n/* three */\nfunction target() {}";
        let query = "(((comment) @comment)* (function_declaration name: (identifier) @name))";
        let language = language_for_id("js").expect("javascript language should exist");
        let tree = parse_root(source, "js");
        let queries = LanguageQueryTexts {
            imports: query,
            exports: query,
            locals: "",
            import_bindings: "",
        };
        let merged = try_execute_merged_language_queries_with_match_limit(
            source,
            tree.root_node(),
            &language,
            "js",
            queries,
            1,
        )
        .expect("valid queries should execute");
        assert!(
            merged.is_none(),
            "an exceeded shared match limit must reject partial merged results"
        );

        let fallback = execute_language_queries_cached_with_match_limit(
            source,
            tree.root_node(),
            &language,
            "js",
            queries,
            1,
        )
        .expect("fallback queries should execute");
        let separate = execute_language_queries_separately(
            source,
            tree.root_node(),
            &language,
            "js",
            queries,
        )
        .expect("independent queries should execute");
        assert_eq!(
            fallback, separate,
            "an exceeded shared match limit must return independent-query results"
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
            let separate_results = run_language_queries(
                source.to_string(),
                language_id.to_string(),
                "".to_string(),
                "".to_string(),
                locals_query.to_string(),
                "".to_string(),
            )
            .expect("separate native queries should succeed");
            let separate_tree = parse_syntax_tree_columns(source, language_id)
                .expect("separate syntax tree projection should succeed");

            reset_parse_invocations_for_tests();
            let (combined_results, combined_tree) = extract_language_parts(
                source,
                language_id,
                LanguageQueryTexts {
                    imports: "",
                    exports: "",
                    locals: locals_query,
                    import_bindings: "",
                },
            )
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
    fn run_language_queries_rejects_unsupported_languages() {
        let error = run_language_queries(
            "value".to_string(),
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
    fn run_language_queries_surfaces_query_compile_failures() {
        let error = run_language_queries(
            "export const value = 1;".to_string(),
            "ts".to_string(),
            "(".to_string(),
            "".to_string(),
            "".to_string(),
            "".to_string(),
        )
        .expect_err("invalid query should fail");

        assert!(
            error.to_string().contains("Failed to compile query"),
            "unexpected error: {error}"
        );
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
        // Verifies parser reuse and query caching produce consistent results
        let source = "import { foo } from './bar';\nexport const x = 1;";
        let query_text = "(lexical_declaration (variable_declarator name: (identifier) @name))";

        let first = run_language_queries(
            source.to_string(),
            "ts".to_string(),
            "".to_string(),
            "".to_string(),
            query_text.to_string(),
            "".to_string(),
        )
        .expect("first call should succeed");

        let second = run_language_queries(
            source.to_string(),
            "ts".to_string(),
            "".to_string(),
            "".to_string(),
            query_text.to_string(),
            "".to_string(),
        )
        .expect("second call should succeed");

        assert_eq!(first.locals.len(), second.locals.len());
        assert_eq!(
            first_capture_texts(&first.locals),
            first_capture_texts(&second.locals),
        );
    }

    #[test]
    fn different_query_texts_do_not_cross_contaminate() {
        let source = "export const value = 1;\nfunction helper() {}";

        let results_a = run_language_queries(
            source.to_string(),
            "ts".to_string(),
            "".to_string(),
            "".to_string(),
            "(lexical_declaration (variable_declarator name: (identifier) @name))".to_string(),
            "".to_string(),
        )
        .expect("query A should succeed");

        let results_b = run_language_queries(
            source.to_string(),
            "ts".to_string(),
            "".to_string(),
            "".to_string(),
            "(function_declaration name: (identifier) @name)".to_string(),
            "".to_string(),
        )
        .expect("query B should succeed");

        assert_eq!(first_capture_texts(&results_a.locals), vec!["value"]);
        assert_eq!(first_capture_texts(&results_b.locals), vec!["helper"]);
    }

    #[test]
    fn compact_imports_query_returns_name_and_text_only() {
        let results = run_imports_query_compact(
            "import { helper } from \"./dep.js\";\nconst value = helper();".to_string(),
            "js".to_string(),
            "(import_statement (string) @mod) @stmt".to_string(),
        )
        .expect("compact imports query should succeed");

        assert_eq!(results.imports.len(), 1);
        let captures = &results.imports[0].captures;
        assert!(captures.iter().any(|c| c.name == "mod"));
        assert!(captures.iter().any(|c| c.name == "stmt"));
    }

    #[test]
fn compact_imports_returns_empty_for_blank_query() {
        let results = run_imports_query_compact(
            "export const x = 1;".to_string(),
            "ts".to_string(),
            "   ".to_string(),
        )
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
