use napi::bindgen_prelude::Result;
use napi_derive::napi;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Parser, Point, Query, QueryCapture, QueryCursor};

#[derive(Debug)]
#[napi(object)]
pub struct NativePoint {
    pub row: u32,
    pub column: u32,
    pub index: u32,
}

#[derive(Debug)]
#[napi(object)]
pub struct NativeCapture {
    pub name: String,
    pub text: String,
    pub node_type: String,
    pub start: NativePoint,
    pub end: NativePoint,
}

#[derive(Debug)]
#[napi(object)]
pub struct NativeMatch {
    pub pattern_index: u32,
    pub captures: Vec<NativeCapture>,
}

#[derive(Debug)]
#[napi(object)]
pub struct NativeQueryResults {
    pub imports: Vec<NativeMatch>,
    pub exports: Vec<NativeMatch>,
    pub locals: Vec<NativeMatch>,
    pub import_bindings: Vec<NativeMatch>,
}

fn point_with_index(point: Point, index: usize) -> NativePoint {
    NativePoint {
        row: point.row as u32,
        column: point.column as u32,
        index: index as u32,
    }
}

fn capture_to_object(source: &str, capture: &QueryCapture<'_>, capture_names: &[&str]) -> NativeCapture {
    let node = capture.node;
    let name = capture_names
        .get(capture.index as usize)
        .copied()
        .unwrap_or_default()
        .to_string();
    let text = source
        .get(node.start_byte()..node.end_byte())
        .unwrap_or("")
        .to_string();

    NativeCapture {
        name,
        text,
        node_type: node.kind().to_string(),
        start: point_with_index(node.start_position(), node.start_byte()),
        end: point_with_index(node.end_position(), node.end_byte()),
    }
}

fn execute_query(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: Language,
    query_text: &str,
) -> Result<Vec<NativeMatch>> {
    if query_text.trim().is_empty() {
        return Ok(Vec::new());
    }

    let query = Query::new(&language, query_text)
        .map_err(|error| napi::Error::from_reason(format!("Failed to compile query: {error}")))?;
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(&query, root, source.as_bytes());
    let mut out = Vec::new();

    while let Some(query_match) = matches.next() {
        let captures = query_match
            .captures
            .iter()
            .map(|capture| capture_to_object(source, capture, &capture_names))
            .collect();
        out.push(NativeMatch {
            pattern_index: query_match.pattern_index as u32,
            captures,
        });
    }

    Ok(out)
}

fn language_for_id(language_id: &str) -> Option<Language> {
    match language_id {
        "c" => Some(tree_sitter_c::LANGUAGE.into()),
        "cpp" => Some(tree_sitter_cpp::LANGUAGE.into()),
        "css" | "less" => Some(tree_sitter_css::LANGUAGE.into()),
        "csharp" => Some(arborium_c_sharp::language().into()),
        "go" => Some(tree_sitter_go::LANGUAGE.into()),
        "html" => Some(tree_sitter_html::LANGUAGE.into()),
        "java" => Some(tree_sitter_java::LANGUAGE.into()),
        "js" => Some(tree_sitter_javascript::LANGUAGE.into()),
        "kotlin" => Some(tree_sitter_kotlin_ng::LANGUAGE.into()),
        "python" => Some(tree_sitter_python::LANGUAGE.into()),
        "ruby" => Some(tree_sitter_ruby::LANGUAGE.into()),
        "rust" => Some(tree_sitter_rust::LANGUAGE.into()),
        "scss" => Some(arborium_scss::language().into()),
        "svelte" => Some(tree_sitter_svelte_next::LANGUAGE.into()),
        "swift" => Some(tree_sitter_swift::LANGUAGE.into()),
        "ts" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "tsx" => Some(tree_sitter_typescript::LANGUAGE_TSX.into()),
        "vue" => Some(arborium_vue::language().into()),
        _ => None,
    }
}

#[napi]
pub fn supported_language_ids() -> Vec<String> {
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
        "python",
        "ruby",
        "rust",
        "scss",
        "svelte",
        "swift",
        "ts",
        "tsx",
        "vue",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

#[napi]
pub fn run_language_queries(
    source: String,
    language_id: String,
    imports_query: String,
    exports_query: String,
    locals_query: String,
    import_bindings_query: String,
) -> Result<NativeQueryResults> {
    let language = language_for_id(&language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| napi::Error::from_reason(format!("Failed to set parser language: {error}")))?;
    let tree = parser
        .parse(source.as_str(), None)
        .ok_or_else(|| napi::Error::from_reason("Failed to parse source".to_string()))?;
    let root = tree.root_node();

    Ok(NativeQueryResults {
        imports: execute_query(source.as_str(), root, language.clone(), imports_query.as_str())?,
        exports: execute_query(source.as_str(), root, language.clone(), exports_query.as_str())?,
        locals: execute_query(source.as_str(), root, language.clone(), locals_query.as_str())?,
        import_bindings: execute_query(
            source.as_str(),
            root,
            language,
            import_bindings_query.as_str(),
        )?,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        execute_query, language_for_id, run_language_queries, supported_language_ids, NativeMatch,
    };
    use std::collections::HashSet;
    use tree_sitter::Parser;

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
            "svelte" => (
                "<script src=\"./dep.js\"></script>",
                "(script_element (start_tag (attribute (attribute_name) @attr (#eq? @attr \"src\") (quoted_attribute_value (attribute_value) @mod)))) @stmt",
            ),
            "swift" => (
                "func helper() {}",
                "(function_declaration name: (simple_identifier) @name)",
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
            "python",
            "ruby",
            "rust",
            "scss",
            "svelte",
            "swift",
            "ts",
            "tsx",
            "vue",
        ]
        .into_iter()
        .collect()
    }

    #[test]
    fn supported_language_ids_contains_expected_languages() {
        let supported = supported_language_ids();
        for language_id in ["ts", "tsx", "js", "python", "go", "rust", "vue", "svelte"] {
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
}
