mod duplicate_keywords;
mod duplicate_tokens;
mod languages;
mod parser_pool;
mod projection;
mod query;
mod types;

#[cfg(test)]
mod tests;

use napi::bindgen_prelude::Result;
use napi_derive::napi;

use crate::languages::language_for_id;
use crate::parser_pool::parse_source;
use crate::projection::{push_projected_node, ProjectionLimits};
use crate::query::{execute_query_cached, execute_query_compact};
use crate::types::{
    CompactQueryResults, NativeDuplicateTokens, NativeLanguageExtraction, NativeQueryResults,
    NativeQueryRunResult, NativeSyntaxTree,
};

#[napi]
pub fn supported_language_ids() -> Vec<String> {
    languages::supported_language_ids()
}


fn execute_language_queries(
    source: &str,
    language_id: &str,
    language: &tree_sitter::Language,
    root: tree_sitter::Node<'_>,
    imports_query: &str,
    exports_query: &str,
    locals_query: &str,
    import_bindings_query: &str,
) -> Result<NativeQueryResults> {
    Ok(NativeQueryResults {
        imports: execute_query_cached(source, root, language, imports_query, language_id)?,
        exports: execute_query_cached(source, root, language, exports_query, language_id)?,
        locals: execute_query_cached(source, root, language, locals_query, language_id)?,
        import_bindings: execute_query_cached(source, root, language, import_bindings_query, language_id)?,
    })
}

fn project_syntax_tree(root: tree_sitter::Node<'_>) -> Result<NativeSyntaxTree> {
    let mut nodes = Vec::new();
    let root_id = push_projected_node(root, &mut nodes, ProjectionLimits::default())
        .map_err(|error| napi::Error::from_reason(error.message()))?;
    Ok(NativeSyntaxTree { root_id, nodes })
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
    let tree = parse_source(source.as_str(), language_id.as_str(), &language)?;
    let root = tree.root_node();
    execute_language_queries(
        source.as_str(),
        language_id.as_str(),
        &language,
        root,
        imports_query.as_str(),
        exports_query.as_str(),
        locals_query.as_str(),
        import_bindings_query.as_str(),
    )
}

#[napi]
pub fn extract_language(
    source: String,
    language_id: String,
    imports_query: String,
    exports_query: String,
    locals_query: String,
    import_bindings_query: String,
) -> Result<NativeLanguageExtraction> {
    let language = language_for_id(&language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;
    let tree = parse_source(source.as_str(), language_id.as_str(), &language)?;
    let root = tree.root_node();
    let results = execute_language_queries(
        source.as_str(),
        language_id.as_str(),
        &language,
        root,
        imports_query.as_str(),
        exports_query.as_str(),
        locals_query.as_str(),
        import_bindings_query.as_str(),
    )?;

    Ok(NativeLanguageExtraction {
            results,
            syntax_tree: project_syntax_tree(root)?,
        })
}

#[napi]
/// Run only the imports query and return compact results (name + text only).
/// This is the graph-mode entrypoint optimized for minimal marshaling.
pub fn run_imports_query_compact(
    source: String,
    language_id: String,
    imports_query: String,
) -> Result<CompactQueryResults> {
    let language = language_for_id(&language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;
    let tree = parse_source(source.as_str(), language_id.as_str(), &language)?;
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

#[napi]
pub fn tokenize_duplicate_source(source: String) -> NativeDuplicateTokens {
    duplicate_tokens::tokenize_duplicate_source(source.as_str())
}

#[napi]
/// Execute a single arbitrary query and return full capture metadata.
pub fn run_query(
    source: String,
    language_id: String,
    query_text: String,
) -> Result<NativeQueryRunResult> {
    let language = language_for_id(&language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;
    let tree = parse_source(source.as_str(), language_id.as_str(), &language)?;
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
    let tree = parse_source(source.as_str(), language_id.as_str(), &language)?;

    Ok(project_syntax_tree(tree.root_node())?)
}
