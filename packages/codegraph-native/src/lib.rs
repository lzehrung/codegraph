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
use crate::projection::push_projected_node;
use crate::query::{execute_query_cached, execute_query_compact};
use crate::types::{
    CompactQueryResults, NativeQueryResults, NativeQueryRunResult, NativeSyntaxTree,
};

#[napi]
pub fn supported_language_ids() -> Vec<String> {
    languages::supported_language_ids()
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

    let mut nodes = Vec::new();
    let root_id = push_projected_node(tree.root_node(), None, &mut nodes);
    Ok(NativeSyntaxTree { root_id, nodes })
}
