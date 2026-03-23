use napi::bindgen_prelude::Result;
use napi_derive::napi;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Parser, Point, Query, QueryCapture, QueryCursor};

#[napi(object)]
pub struct NativePoint {
    pub row: u32,
    pub column: u32,
    pub index: u32,
}

#[napi(object)]
pub struct NativeCapture {
    pub name: String,
    pub text: String,
    pub node_type: String,
    pub start: NativePoint,
    pub end: NativePoint,
}

#[napi(object)]
pub struct NativeMatch {
    pub pattern_index: u32,
    pub captures: Vec<NativeCapture>,
}

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
