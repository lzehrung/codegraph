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
#[cfg(not(test))]
use napi::bindgen_prelude::{Int32Array, Uint32Array, Uint8Array};
use napi_derive::napi;

use crate::languages::language_for_id;
use crate::parser_pool::parse_source;
use crate::projection::{project_columns, ProjectedColumns, ProjectionLimits};
use crate::query::{execute_query_cached, execute_query_compact};
#[cfg(not(test))]
use crate::types::{NativeLanguageExtraction, NativeSyntaxTree};
use crate::types::{
    CompactQueryResults, NativeDuplicateTokens, NativeQueryResults, NativeQueryRunResult,
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

/// Parse and project without touching any JS value, so unit tests can exercise the
/// real pipeline. `parse_syntax_tree` is the thin marshalling wrapper around this.
fn parse_syntax_tree_columns(source: &str, language_id: &str) -> Result<ProjectedColumns> {
    let language = language_for_id(language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;
    let tree = parse_source(source, language_id, &language)?;
    project_columns(tree.root_node(), ProjectionLimits::default())
        .map_err(|error| napi::Error::from_reason(error.message()))
}

/// Run the four language queries and project the tree from a single parse, without
/// touching any JS value. `extract_language` is the thin marshalling wrapper.
fn extract_language_parts(
    source: &str,
    language_id: &str,
    imports_query: &str,
    exports_query: &str,
    locals_query: &str,
    import_bindings_query: &str,
) -> Result<(NativeQueryResults, ProjectedColumns)> {
    let language = language_for_id(language_id)
        .ok_or_else(|| napi::Error::from_reason(format!("Unsupported language: {language_id}")))?;
    let tree = parse_source(source, language_id, &language)?;
    let root = tree.root_node();
    let results = execute_language_queries(
        source,
        language_id,
        &language,
        root,
        imports_query,
        exports_query,
        locals_query,
        import_bindings_query,
    )?;
    let columns = project_columns(root, ProjectionLimits::default())
        .map_err(|error| napi::Error::from_reason(error.message()))?;
    Ok((results, columns))
}

#[cfg(not(test))]
fn to_native_syntax_tree(columns: ProjectedColumns) -> NativeSyntaxTree {
    NativeSyntaxTree {
        root_id: columns.root_id,
        node_count: columns.node_count(),
        kinds: columns.kinds,
        field_names: columns.field_names,
        kind_ids: Uint32Array::new(columns.kind_ids),
        parent_ids: Int32Array::new(columns.parent_ids),
        named: Uint8Array::new(columns.named),
        start_row: Uint32Array::new(columns.start_row),
        start_column: Uint32Array::new(columns.start_column),
        start_index: Uint32Array::new(columns.start_index),
        end_row: Uint32Array::new(columns.end_row),
        end_column: Uint32Array::new(columns.end_column),
        end_index: Uint32Array::new(columns.end_index),
        child_offsets: Uint32Array::new(columns.child_offsets),
        child_ids: Uint32Array::new(columns.child_ids),
        child_field_name_ids: Uint32Array::new(columns.child_field_name_ids),
        named_child_offsets: Uint32Array::new(columns.named_child_offsets),
        named_child_ids: Uint32Array::new(columns.named_child_ids),
    }
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

#[cfg(not(test))]
#[napi]
pub fn extract_language(
    source: String,
    language_id: String,
    imports_query: String,
    exports_query: String,
    locals_query: String,
    import_bindings_query: String,
) -> Result<NativeLanguageExtraction> {
    let (results, columns) = extract_language_parts(
        source.as_str(),
        language_id.as_str(),
        imports_query.as_str(),
        exports_query.as_str(),
        locals_query.as_str(),
        import_bindings_query.as_str(),
    )?;
    Ok(NativeLanguageExtraction {
        results,
        syntax_tree: to_native_syntax_tree(columns),
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

#[cfg(not(test))]
#[napi]
pub fn parse_syntax_tree(source: String, language_id: String) -> Result<NativeSyntaxTree> {
    let columns = parse_syntax_tree_columns(source.as_str(), language_id.as_str())?;
    Ok(to_native_syntax_tree(columns))
}
