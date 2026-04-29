use napi::bindgen_prelude::Result;
use napi_derive::napi;
use std::cell::RefCell;
use std::collections::HashMap;
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

/// Compact capture with only name and text -- used by graph-mode imports
/// where position and node-type data are not consumed by the caller.
#[derive(Debug)]
#[napi(object)]
pub struct CompactCapture {
    pub name: String,
    pub text: String,
}

#[derive(Debug)]
#[napi(object)]
pub struct CompactMatch {
    pub pattern_index: u32,
    pub captures: Vec<CompactCapture>,
}

#[derive(Debug)]
#[napi(object)]
pub struct CompactQueryResults {
    pub imports: Vec<CompactMatch>,
}

#[derive(Debug)]
#[napi(object)]
pub struct NativeQueryRunResult {
    pub matches: Vec<NativeMatch>,
}

#[derive(Debug)]
#[napi(object)]
pub struct NativeSyntaxNode {
    pub id: u32,
    pub parent_id: i32,
    pub node_type: String,
    pub named: bool,
    pub start: NativePoint,
    pub end: NativePoint,
    pub child_ids: Vec<u32>,
    pub named_child_ids: Vec<u32>,
    pub child_field_names: Vec<String>,
}

#[derive(Debug)]
#[napi(object)]
pub struct NativeSyntaxTree {
    pub root_id: u32,
    pub nodes: Vec<NativeSyntaxNode>,
}

fn point_with_index(point: Point, index: usize) -> NativePoint {
    NativePoint {
        row: point.row as u32,
        column: point.column as u32,
        index: index as u32,
    }
}

fn capture_to_compact(source: &str, capture: &QueryCapture<'_>, capture_names: &[&str]) -> CompactCapture {
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
    CompactCapture { name, text }
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

// ---------------------------------------------------------------------------
// Parser pooling: one Parser instance per language, reused across calls.
// ---------------------------------------------------------------------------

struct ParserPool {
    parsers: HashMap<String, Parser>,
}

impl ParserPool {
    fn new() -> Self {
        Self {
            parsers: HashMap::new(),
        }
    }

    fn get_or_create(&mut self, language_id: &str, language: &Language) -> Result<&mut Parser> {
        // Fast path: lookup with &str key (no allocation when parser exists).
        if self.parsers.contains_key(language_id) {
            return Ok(self.parsers.get_mut(language_id).unwrap());
        }
        // Slow path: create parser and insert (allocates key string).
        let mut parser = Parser::new();
        parser
            .set_language(language)
            .map_err(|err| napi::Error::from_reason(format!("Failed to set parser language: {err}")))?;
        self.parsers.insert(language_id.to_string(), parser);
        Ok(self.parsers.get_mut(language_id).unwrap())
    }
}

thread_local! {
    static PARSER_POOL: RefCell<ParserPool> = RefCell::new(ParserPool::new());
}

// ---------------------------------------------------------------------------
// Query caching: compiled Query objects keyed by (language_id, query_text).
// ---------------------------------------------------------------------------

struct QueryCache {
    /// Nested map: language_id -> query_text -> compiled Query.
    /// Using nested maps allows lookups with &str keys (no allocation on hits).
    entries: HashMap<String, HashMap<String, Query>>,
}

impl QueryCache {
    fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    fn get_or_compile(
        &mut self,
        language_id: &str,
        language: &Language,
        query_text: &str,
    ) -> Result<&Query> {
        // Fast path: check with &str keys (no allocation on cache hits).
        if let Some(by_text) = self.entries.get(language_id) {
            if by_text.contains_key(query_text) {
                return Ok(self.entries[language_id].get(query_text).unwrap());
            }
        }
        // Slow path: compile and insert (allocates key strings).
        let query = Query::new(language, query_text)
            .map_err(|e| napi::Error::from_reason(format!("Failed to compile query: {e}")))?;
        self.entries
            .entry(language_id.to_string())
            .or_default()
            .insert(query_text.to_string(), query);
        Ok(self.entries[language_id].get(query_text).unwrap())
    }
}

thread_local! {
    static QUERY_CACHE: RefCell<QueryCache> = RefCell::new(QueryCache::new());
}

// ---------------------------------------------------------------------------
// Query execution using cached queries.
// ---------------------------------------------------------------------------

/// Execute a query without caching. Used by tests where the language_id is
/// not known or the query is one-off.
#[cfg(test)]
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

/// Execute a query using the compiled-query cache. The cache is keyed by
/// (language_id, query_text) so a query compiled for one grammar is never
/// reused for a different grammar.
fn execute_query_cached(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    query_text: &str,
    language_id: &str,
) -> Result<Vec<NativeMatch>> {
    if query_text.trim().is_empty() {
        return Ok(Vec::new());
    }

    QUERY_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let query = cache.get_or_compile(language_id, language, query_text)?;
        let capture_names = query.capture_names();
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(query, root, source.as_bytes());
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
    })
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
        "php" => Some(tree_sitter_php::LANGUAGE_PHP.into()),
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

fn push_projected_node(
    node: tree_sitter::Node<'_>,
    parent_id: Option<u32>,
    out: &mut Vec<NativeSyntaxNode>,
) -> u32 {
    let node_id = out.len() as u32;
    let mut child_ids = Vec::new();
    let mut named_child_ids = Vec::new();
    let mut child_field_names = Vec::new();

    out.push(NativeSyntaxNode {
        id: node_id,
        parent_id: parent_id.map(|id| id as i32).unwrap_or(-1),
        node_type: node.kind().to_string(),
        named: node.is_named(),
        start: point_with_index(node.start_position(), node.start_byte()),
        end: point_with_index(node.end_position(), node.end_byte()),
        child_ids: Vec::new(),
        named_child_ids: Vec::new(),
        child_field_names: Vec::new(),
    });

    for child_index in 0..node.child_count() {
        if let Some(child) = node.child(child_index) {
            let child_id = push_projected_node(child, Some(node_id), out);
            child_ids.push(child_id);
            if child.is_named() {
                named_child_ids.push(child_id);
            }
            child_field_names.push(
                node.field_name_for_child(child_index as u32)
                    .unwrap_or("")
                    .to_string(),
            );
        }
    }

    let projected = out
        .get_mut(node_id as usize)
        .expect("projected node should exist");
    projected.child_ids = child_ids;
    projected.named_child_ids = named_child_ids;
    projected.child_field_names = child_field_names;
    node_id
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
        "php",
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

    let tree = PARSER_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        let parser = pool.get_or_create(&language_id, &language)?;
        parser
            .parse(source.as_str(), None)
            .ok_or_else(|| napi::Error::from_reason("Failed to parse source".to_string()))
    })?;
    let root = tree.root_node();
    let lid = language_id.as_str();

    Ok(NativeQueryResults {
        imports: execute_query_cached(source.as_str(), root, &language, imports_query.as_str(), lid)?,
        exports: execute_query_cached(source.as_str(), root, &language, exports_query.as_str(), lid)?,
        locals: execute_query_cached(source.as_str(), root, &language, locals_query.as_str(), lid)?,
        import_bindings: execute_query_cached(
            source.as_str(),
            root,
            &language,
            import_bindings_query.as_str(),
            lid,
        )?,
    })
}

/// Execute a compact imports-only query. Returns only name+text per capture,
/// skipping nodeType and position data to reduce marshaling overhead.
fn execute_query_compact(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    query_text: &str,
    language_id: &str,
) -> Result<Vec<CompactMatch>> {
    if query_text.trim().is_empty() {
        return Ok(Vec::new());
    }

    QUERY_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let query = cache.get_or_compile(language_id, language, query_text)?;
        let capture_names = query.capture_names();
        let mut cursor = QueryCursor::new();
        let mut matches = cursor.matches(query, root, source.as_bytes());
        let mut out = Vec::new();

        while let Some(query_match) = matches.next() {
            let captures = query_match
                .captures
                .iter()
                .map(|capture| capture_to_compact(source, capture, &capture_names))
                .collect();
            out.push(CompactMatch {
                pattern_index: query_match.pattern_index as u32,
                captures,
            });
        }

        Ok(out)
    })
}

/// Run only the imports query and return compact results (name + text only).
/// This is the graph-mode entrypoint optimized for minimal marshaling.
#[napi]
pub fn run_imports_query_compact(
    source: String,
    language_id: String,
    imports_query: String,
) -> Result<CompactQueryResults> {
    let language = language_for_id(&language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;

    let tree = PARSER_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        let parser = pool.get_or_create(&language_id, &language)?;
        parser
            .parse(source.as_str(), None)
            .ok_or_else(|| napi::Error::from_reason("Failed to parse source".to_string()))
    })?;
    let root = tree.root_node();

    Ok(CompactQueryResults {
        imports: execute_query_compact(
            source.as_str(),
            root,
            &language,
            imports_query.as_str(),
            language_id.as_str(),
        )?,
    })
}

/// Execute a single arbitrary query and return full capture metadata.
#[napi]
pub fn run_query(
    source: String,
    language_id: String,
    query_text: String,
) -> Result<NativeQueryRunResult> {
    let language = language_for_id(&language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;

    let tree = PARSER_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        let parser = pool.get_or_create(&language_id, &language)?;
        parser
            .parse(source.as_str(), None)
            .ok_or_else(|| napi::Error::from_reason("Failed to parse source".to_string()))
    })?;
    let root = tree.root_node();

    Ok(NativeQueryRunResult {
        matches: execute_query_cached(
            source.as_str(),
            root,
            &language,
            query_text.as_str(),
            language_id.as_str(),
        )?,
    })
}

#[napi]
pub fn parse_syntax_tree(source: String, language_id: String) -> Result<NativeSyntaxTree> {
    let language = language_for_id(&language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;

    let tree = PARSER_POOL.with(|pool| {
        let mut pool = pool.borrow_mut();
        let parser = pool.get_or_create(&language_id, &language)?;
        parser
            .parse(source.as_str(), None)
            .ok_or_else(|| napi::Error::from_reason("Failed to parse source".to_string()))
    })?;

    let mut nodes = Vec::new();
    let root_id = push_projected_node(tree.root_node(), None, &mut nodes);
    Ok(NativeSyntaxTree { root_id, nodes })
}

#[cfg(test)]
mod tests {
    use super::{
        execute_query, language_for_id, run_imports_query_compact, run_language_queries,
        supported_language_ids, NativeMatch,
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
            "php",
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
        for language_id in ["ts", "tsx", "js", "python", "php", "go", "rust", "vue", "svelte"] {
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
}
