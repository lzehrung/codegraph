use napi::bindgen_prelude::Result;
use std::cell::RefCell;
use std::collections::HashMap;
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Query, QueryCapture, QueryCursor};

use crate::types::{
    point_with_index, CompactCapture, CompactMatch, NativeCapture, NativeMatch,
};

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
pub(crate) fn execute_query(
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
pub(crate) fn execute_query_cached(
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
/// Execute a compact imports-only query. Returns only name+text per capture,
/// skipping nodeType and position data to reduce marshaling overhead.
pub(crate) fn execute_query_compact(
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
