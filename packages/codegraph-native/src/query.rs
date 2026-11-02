use napi::bindgen_prelude::Result;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex, OnceLock, PoisonError};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Node, Query, QueryCapture, QueryCursor};

use crate::types::{point_with_index, CompactCapture, CompactMatch, NativeCapture, NativeMatch};

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
    CompactCapture {
        name,
        text,
        start_index: node.start_byte() as u32,
    }
}

pub(crate) fn capture_to_object(
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

/// Compile `query_text` for `language`. The error is the message `napi` reports, so a failure can be
/// stored and returned again without compiling the text a second time.
pub(crate) fn compile_query(
    language: &Language,
    query_text: &str,
) -> std::result::Result<Query, String> {
    Query::new(language, query_text).map_err(|error| format!("Failed to compile query: {error}"))
}

/// Every match of `query` under `root`, with full capture metadata.
pub(crate) fn collect_matches(source: &str, root: Node<'_>, query: &Query) -> Vec<NativeMatch> {
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, source.as_bytes());
    let mut out = Vec::new();

    while let Some(query_match) = matches.next() {
        let captures = query_match
            .captures()
            .iter()
            .map(|capture| capture_to_object(source, capture, capture_names))
            .collect();
        out.push(NativeMatch {
            pattern_index: query_match.pattern_index as u32,
            captures,
        });
    }

    out
}

/// Every match of `query` under `root`, with only the name, text, and byte offset of each capture.
pub(crate) fn collect_compact_matches(
    source: &str,
    root: Node<'_>,
    query: &Query,
) -> Vec<CompactMatch> {
    let capture_names = query.capture_names();
    let mut cursor = QueryCursor::new();
    let mut matches = cursor.matches(query, root, source.as_bytes());
    let mut out = Vec::new();

    while let Some(query_match) = matches.next() {
        let captures = query_match
            .captures()
            .iter()
            .map(|capture| capture_to_compact(source, capture, capture_names))
            .collect();
        out.push(CompactMatch {
            pattern_index: query_match.pattern_index as u32,
            captures,
        });
    }

    out
}

// ---------------------------------------------------------------------------
// Caller queries: compiled once per process, keyed by (language_id, query_text).
// ---------------------------------------------------------------------------

/// Maximum caller queries retained by the process.
///
/// Registered query sets are not counted: they live in `query_set` for the life of the process.
/// This cache holds the queries callers pass as text (`run_query`), such as chunking and grep
/// queries, so a stream of distinct caller queries cannot grow without bound.
const AD_HOC_QUERY_CAPACITY: usize = 256;

/// One compiled caller query, shared by every thread that asks for the same text.
///
/// The cell fills once. Threads that ask while it fills wait for that compile instead of repeating
/// it, and a query that does not compile keeps its error, so the text is never compiled twice.
pub(crate) struct SharedQuery {
    compiled: OnceLock<std::result::Result<Query, String>>,
}

impl SharedQuery {
    fn new() -> Self {
        Self {
            compiled: OnceLock::new(),
        }
    }

    pub(crate) fn get(&self, language: &Language, query_text: &str) -> Result<&Query> {
        self.compiled
            .get_or_init(|| compile_query(language, query_text))
            .as_ref()
            .map_err(|message| napi::Error::from_reason(message.clone()))
    }
}

/// Least recently used compiled caller queries.
///
/// A lookup holds the cache lock only to find or add the entry. Compiling happens on the
/// entry, outside the lock, so one thread's compile never blocks another thread's lookup.
pub(crate) struct AdHocQueryCache {
    capacity: usize,
    /// Nested map: language_id -> query_text -> entry.
    /// Using nested maps allows lookups with &str keys (no allocation on hits).
    entries: HashMap<String, HashMap<String, Arc<SharedQuery>>>,
    /// LRU order, oldest at the front. Length equals the entry count.
    order: VecDeque<(String, String)>,
}

impl AdHocQueryCache {
    fn new() -> Self {
        Self::with_capacity(AD_HOC_QUERY_CAPACITY)
    }

    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            entries: HashMap::new(),
            order: VecDeque::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.order.len()
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, language_id: &str, query_text: &str) -> bool {
        self.entries
            .get(language_id)
            .is_some_and(|by_text| by_text.contains_key(query_text))
    }

    #[cfg(test)]
    pub(crate) fn language_query_capacity(&self, language_id: &str) -> usize {
        self.entries
            .get(language_id)
            .map(|by_text| by_text.capacity())
            .unwrap_or(0)
    }

    /// The entry for `(language_id, query_text)`, added (and the least recently used entry
    /// evicted at capacity) when it is not there yet.
    pub(crate) fn entry(&mut self, language_id: &str, query_text: &str) -> Arc<SharedQuery> {
        if let Some(entry) = self
            .entries
            .get(language_id)
            .and_then(|by_text| by_text.get(query_text))
        {
            let entry = Arc::clone(entry);
            Self::touch(&mut self.order, language_id, query_text);
            return entry;
        }

        if self.order.len() >= self.capacity {
            self.evict_oldest();
        }
        let entry = Arc::new(SharedQuery::new());
        self.entries
            .entry(language_id.to_string())
            .or_default()
            .insert(query_text.to_string(), Arc::clone(&entry));
        self.order
            .push_back((language_id.to_string(), query_text.to_string()));
        entry
    }

    fn evict_oldest(&mut self) {
        let Some((evict_id, evict_text)) = self.order.pop_front() else {
            return;
        };
        let empty = self
            .entries
            .get_mut(&evict_id)
            .map(|by_text| {
                by_text.remove(&evict_text);
                let is_empty = by_text.is_empty();
                if !is_empty {
                    // Release capacity from the historical peak so a long stream of
                    // distinct caller queries for one language does not retain a
                    // bucket allocation sized for every query it has ever held.
                    by_text.shrink_to_fit();
                }
                is_empty
            })
            .unwrap_or(false);
        if empty {
            self.entries.remove(&evict_id);
        }
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

static AD_HOC_QUERIES: LazyLock<Mutex<AdHocQueryCache>> =
    LazyLock::new(|| Mutex::new(AdHocQueryCache::new()));

// ---------------------------------------------------------------------------
// Query execution.
// ---------------------------------------------------------------------------

/// Execute a query without caching. Used by tests where the language_id is
/// not known or the query is one-off.
#[cfg(test)]
pub(crate) fn execute_query(
    source: &str,
    root: Node<'_>,
    language: Language,
    query_text: &str,
) -> Result<Vec<NativeMatch>> {
    if query_text.trim().is_empty() {
        return Ok(Vec::new());
    }

    let query = compile_query(&language, query_text).map_err(napi::Error::from_reason)?;
    Ok(collect_matches(source, root, &query))
}

/// Execute a caller query using the process-wide compiled-query cache. The cache is keyed by
/// (language_id, query_text) so a query compiled for one grammar is never reused for a different
/// grammar.
pub(crate) fn execute_query_cached(
    source: &str,
    root: Node<'_>,
    language: &Language,
    query_text: &str,
    language_id: &str,
) -> Result<Vec<NativeMatch>> {
    if query_text.trim().is_empty() {
        return Ok(Vec::new());
    }

    let entry = AD_HOC_QUERIES
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .entry(language_id, query_text);
    let query = entry.get(language, query_text)?;
    Ok(collect_matches(source, root, query))
}
