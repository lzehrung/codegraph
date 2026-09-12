use napi::bindgen_prelude::Result;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet, VecDeque};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Query, QueryCapture, QueryCursor};

use crate::types::{
    point_with_index, CompactCapture, CompactMatch, NativeCapture, NativeMatch, NativeQueryResults,
};

fn capture_to_compact(
    source: &str,
    capture: &QueryCapture<'_>,
    capture_names: &[&str],
) -> CompactCapture {
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

fn capture_to_object(
    source: &str,
    capture: &QueryCapture<'_>,
    capture_names: &[&str],
) -> NativeCapture {
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

/// Maximum compiled queries retained per thread.
///
/// Covers the roughly 150 built-in queries with room for caller queries.
/// Entries are not pinned: enough distinct caller queries can evict built-ins.
/// Each worker thread has its own cache. The merged-query failure memo uses
/// the same entry limit.
const QUERY_CACHE_CAPACITY: usize = 256;

pub(crate) struct QueryCache {
    capacity: usize,
    /// Nested map: language_id -> query_text -> compiled Query.
    /// Using nested maps allows lookups with &str keys (no allocation on hits).
    entries: HashMap<String, HashMap<String, Query>>,
    /// LRU order, oldest at the front. Length equals the compiled-query count.
    order: VecDeque<(String, String)>,
    /// Merged query text that is valid only in separate query-kind executions.
    failed_merged: HashMap<String, HashSet<String>>,
    failed_order: VecDeque<(String, String)>,
}

impl QueryCache {
    fn new() -> Self {
        Self::with_capacity(QUERY_CACHE_CAPACITY)
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            order: VecDeque::new(),
            failed_merged: HashMap::new(),
            failed_order: VecDeque::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.order.len()
    }

    pub(crate) fn contains(&self, language_id: &str, query_text: &str) -> bool {
        self.entries
            .get(language_id)
            .is_some_and(|by_text| by_text.contains_key(query_text))
    }

    #[cfg(test)]
    pub(crate) fn failed_merged_len(&self) -> usize {
        self.failed_order.len()
    }

    pub(crate) fn get_or_compile(
        &mut self,
        language_id: &str,
        language: &Language,
        query_text: &str,
    ) -> Result<&Query> {
        if self.contains(language_id, query_text) {
            Self::touch(&mut self.order, language_id, query_text);
        } else {
            let query = Query::new(language, query_text)
                .map_err(|e| napi::Error::from_reason(format!("Failed to compile query: {e}")))?;
            if self.order.len() >= self.capacity {
                if let Some((evict_id, evict_text)) = self.order.pop_front() {
                    let empty = self
                        .entries
                        .get_mut(&evict_id)
                        .map(|by_text| {
                            by_text.remove(&evict_text);
                            by_text.is_empty()
                        })
                        .unwrap_or(false);
                    if empty {
                        self.entries.remove(&evict_id);
                    }
                }
            }
            self.entries
                .entry(language_id.to_string())
                .or_default()
                .insert(query_text.to_string(), query);
            self.order
                .push_back((language_id.to_string(), query_text.to_string()));
        }
        Ok(self
            .entries
            .get(language_id)
            .and_then(|by_text| by_text.get(query_text))
            .expect("query must be present after compile or hit"))
    }

    pub(crate) fn has_failed_merged(&self, language_id: &str, query_text: &str) -> bool {
        self.failed_merged
            .get(language_id)
            .is_some_and(|failed_queries| failed_queries.contains(query_text))
    }

    pub(crate) fn record_failed_merged(&mut self, language_id: &str, query_text: &str) {
        if self.has_failed_merged(language_id, query_text) {
            Self::touch(&mut self.failed_order, language_id, query_text);
            return;
        }
        if self.failed_order.len() >= self.capacity {
            if let Some((evict_id, evict_text)) = self.failed_order.pop_front() {
                let empty = self
                    .failed_merged
                    .get_mut(&evict_id)
                    .map(|failed_queries| {
                        failed_queries.remove(&evict_text);
                        failed_queries.is_empty()
                    })
                    .unwrap_or(false);
                if empty {
                    self.failed_merged.remove(&evict_id);
                }
            }
        }
        self.failed_merged
            .entry(language_id.to_string())
            .or_default()
            .insert(query_text.to_string());
        self.failed_order
            .push_back((language_id.to_string(), query_text.to_string()));
    }

    fn touch(order: &mut VecDeque<(String, String)>, language_id: &str, query_text: &str) {
        if let Some(index) = order
            .iter()
            .position(|(id, text)| id == language_id && text == query_text)
        {
            if let Some(key) = order.remove(index) {
                order.push_back(key);
            }
        }
    }
}

thread_local! {
    static QUERY_CACHE: RefCell<QueryCache> = RefCell::new(QueryCache::new());
}

#[derive(Clone, Copy)]
enum QueryResultKind {
    Imports,
    Exports,
    Locals,
    ImportBindings,
}

#[derive(Clone, Copy)]
pub(crate) struct LanguageQueryTexts<'a> {
    pub(crate) imports: &'a str,
    pub(crate) exports: &'a str,
    pub(crate) locals: &'a str,
    pub(crate) import_bindings: &'a str,
}

struct QueryRoute {
    kind: QueryResultKind,
    pattern_range: std::ops::Range<usize>,
}

fn empty_query_results() -> NativeQueryResults {
    NativeQueryResults {
        imports: Vec::new(),
        exports: Vec::new(),
        locals: Vec::new(),
        import_bindings: Vec::new(),
    }
}

fn push_query_match(
    results: &mut NativeQueryResults,
    kind: QueryResultKind,
    query_match: NativeMatch,
) {
    match kind {
        QueryResultKind::Imports => results.imports.push(query_match),
        QueryResultKind::Exports => results.exports.push(query_match),
        QueryResultKind::Locals => results.locals.push(query_match),
        QueryResultKind::ImportBindings => results.import_bindings.push(query_match),
    }
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
            .map(|capture| capture_to_object(source, capture, capture_names))
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
                .map(|capture| capture_to_object(source, capture, capture_names))
                .collect();
            out.push(NativeMatch {
                pattern_index: query_match.pattern_index as u32,
                captures,
            });
        }

        Ok(out)
    })
}

pub(crate) fn execute_language_queries_separately(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    language_id: &str,
    queries: LanguageQueryTexts<'_>,
) -> Result<NativeQueryResults> {
    Ok(NativeQueryResults {
        imports: execute_query_cached(source, root, language, queries.imports, language_id)?,
        exports: execute_query_cached(source, root, language, queries.exports, language_id)?,
        locals: execute_query_cached(source, root, language, queries.locals, language_id)?,
        import_bindings: execute_query_cached(
            source,
            root,
            language,
            queries.import_bindings,
            language_id,
        )?,
    })
}

#[cfg(test)]
pub(crate) fn try_execute_merged_language_queries(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    language_id: &str,
    queries: LanguageQueryTexts<'_>,
) -> Result<Option<NativeQueryResults>> {
    try_execute_merged_language_queries_with_limit(
        source,
        root,
        language,
        language_id,
        queries,
        None,
    )
}

#[cfg(test)]
pub(crate) fn record_merged_query_compile_failure_for_tests(language_id: &str, query_text: &str) {
    QUERY_CACHE.with(|cache| {
        cache
            .borrow_mut()
            .record_failed_merged(language_id, query_text)
    });
}

#[cfg(test)]
pub(crate) fn try_execute_merged_language_queries_with_match_limit(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    language_id: &str,
    queries: LanguageQueryTexts<'_>,
    match_limit: u32,
) -> Result<Option<NativeQueryResults>> {
    try_execute_merged_language_queries_with_limit(
        source,
        root,
        language,
        language_id,
        queries,
        Some(match_limit),
    )
}

fn try_execute_merged_language_queries_with_limit(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    language_id: &str,
    queries: LanguageQueryTexts<'_>,
    match_limit: Option<u32>,
) -> Result<Option<NativeQueryResults>> {
    QUERY_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        let query_kinds = [
            (QueryResultKind::Imports, queries.imports),
            (QueryResultKind::Exports, queries.exports),
            (QueryResultKind::Locals, queries.locals),
            (QueryResultKind::ImportBindings, queries.import_bindings),
        ];
        let mut merged_query = String::new();
        let mut routes = Vec::new();
        let mut pattern_start = 0;

        for (kind, query_text) in query_kinds {
            if query_text.trim().is_empty() {
                continue;
            }
            let query = cache.get_or_compile(language_id, language, query_text)?;
            let pattern_end = pattern_start + query.pattern_count();
            routes.push(QueryRoute {
                kind,
                pattern_range: pattern_start..pattern_end,
            });
            merged_query.push_str(query_text);
            merged_query.push('\n');
            pattern_start = pattern_end;
        }

        if routes.is_empty() {
            return Ok(Some(empty_query_results()));
        }
        if routes.len() == 1 {
            return Ok(None);
        }

        if cache.has_failed_merged(language_id, &merged_query) {
            return Ok(None);
        }
        let query = match cache.get_or_compile(language_id, language, &merged_query) {
            Ok(query) => query,
            Err(_) => {
                cache.record_failed_merged(language_id, &merged_query);
                return Ok(None);
            }
        };
        let capture_names = query.capture_names();
        let mut cursor = QueryCursor::new();
        if let Some(match_limit) = match_limit {
            cursor.set_match_limit(match_limit);
        }
        let mut results = empty_query_results();

        {
            let mut matches = cursor.matches(query, root, source.as_bytes());
            while let Some(query_match) = matches.next() {
                let pattern_index = query_match.pattern_index;
                let route = routes
                    .iter()
                    .find(|route| route.pattern_range.contains(&pattern_index))
                    .ok_or_else(|| {
                        napi::Error::from_reason(format!(
                            "Merged query returned an unknown pattern index: {pattern_index}"
                        ))
                    })?;
                let captures = query_match
                    .captures
                    .iter()
                    .map(|capture| capture_to_object(source, capture, capture_names))
                    .collect();
                push_query_match(
                    &mut results,
                    route.kind,
                    NativeMatch {
                        pattern_index: (pattern_index - route.pattern_range.start) as u32,
                        captures,
                    },
                );
            }
        }

        if cursor.did_exceed_match_limit() {
            return Ok(None);
        }
        Ok(Some(results))
    })
}

/// Execute all query kinds with one tree traversal. Each original query is compiled
/// first, preserving its existing validation error. If the concatenation is invalid,
/// retain the established independent-query behavior.
pub(crate) fn execute_language_queries_cached(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    language_id: &str,
    queries: LanguageQueryTexts<'_>,
) -> Result<NativeQueryResults> {
    execute_language_queries_cached_with_limit(source, root, language, language_id, queries, None)
}

#[cfg(test)]
pub(crate) fn execute_language_queries_cached_with_match_limit(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    language_id: &str,
    queries: LanguageQueryTexts<'_>,
    match_limit: u32,
) -> Result<NativeQueryResults> {
    execute_language_queries_cached_with_limit(
        source,
        root,
        language,
        language_id,
        queries,
        Some(match_limit),
    )
}

fn execute_language_queries_cached_with_limit(
    source: &str,
    root: tree_sitter::Node<'_>,
    language: &Language,
    language_id: &str,
    queries: LanguageQueryTexts<'_>,
    match_limit: Option<u32>,
) -> Result<NativeQueryResults> {
    match try_execute_merged_language_queries_with_limit(
        source,
        root,
        language,
        language_id,
        queries,
        match_limit,
    )? {
        Some(results) => Ok(results),
        None => execute_language_queries_separately(source, root, language, language_id, queries),
    }
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
                .map(|capture| capture_to_compact(source, capture, capture_names))
                .collect();
            out.push(CompactMatch {
                pattern_index: query_match.pattern_index as u32,
                captures,
            });
        }

        Ok(out)
    })
}
