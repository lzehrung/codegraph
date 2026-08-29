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
            "svelte" => (
                "<script src=\"./dep.js\"></script>",
                "(script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr \"src\") (quoted_attribute_value (attribute_value) @mod)))) @stmt",
            ),
            "swift" => (
                "func helper() {}",
                "(function_declaration name: (simple_identifier) @name)",
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
            "vue" => (
                "<script src=\"./logic.ts\"></script>",
                "(script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr \"src\") (quoted_attribute_value (attribute_value) @mod)))) @stmt",
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
            "svelte",
            "swift",
            "ts",
            "tsx",
            "vue",
            "zig",
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn supported_language_ids_contains_expected_languages() {
        let supported = supported_language_ids();
        for language_id in ["ts", "tsx", "js", "python", "php", "go", "rust", "vue", "svelte", "zig"] {
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
