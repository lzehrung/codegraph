//! Query sets: the four extraction queries of one language, registered once and compiled once.
//!
//! A caller registers a language's imports, exports, locals, and import-binding queries and gets
//! an id back. Every extraction call then names the id instead of carrying the query text. The
//! registry is process-wide, so the compiled queries are shared by every thread that runs an
//! extraction: the first thread to need a set compiles it, and the others wait for that compile.

use napi::bindgen_prelude::Result;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, LazyLock, OnceLock, PoisonError, RwLock};
use streaming_iterator::StreamingIterator;
use tree_sitter::{Language, Node, Query, QueryCursor};

use crate::languages::language_for_id;
use crate::query::{capture_to_object, collect_compact_matches, collect_matches, compile_query};
use crate::types::{CompactMatch, NativeMatch, NativeQueryResults};

/// Query sets one process can register.
///
/// A real run registers a few dozen: one per language and scope. The limit keeps a caller that
/// registers distinct texts without end from growing the registry without bound.
const MAX_QUERY_SETS: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QueryKind {
    Imports,
    Exports,
    Locals,
    ImportBindings,
}

impl QueryKind {
    /// In the order the merged query lists them, and the order separate execution runs them.
    const ALL: [QueryKind; 4] = [
        QueryKind::Imports,
        QueryKind::Exports,
        QueryKind::Locals,
        QueryKind::ImportBindings,
    ];

    fn index(self) -> usize {
        self as usize
    }
}

#[derive(Clone, Copy)]
pub(crate) struct LanguageQueryTexts<'a> {
    pub(crate) imports: &'a str,
    pub(crate) exports: &'a str,
    pub(crate) locals: &'a str,
    pub(crate) import_bindings: &'a str,
}

impl LanguageQueryTexts<'_> {
    fn text(&self, kind: QueryKind) -> &str {
        match kind {
            QueryKind::Imports => self.imports,
            QueryKind::Exports => self.exports,
            QueryKind::Locals => self.locals,
            QueryKind::ImportBindings => self.import_bindings,
        }
    }
}

struct KindQuery {
    text: String,
    /// This kind compiled by itself. Filled only when something runs the kind apart from the
    /// merged query: a set with fewer than two kinds, a set whose kinds do not merge, a traversal
    /// that exceeded the match limit, or the compact imports entry point.
    alone: OnceLock<std::result::Result<Query, String>>,
}

struct QueryRoute {
    kind: QueryKind,
    /// Pattern indexes of the merged query that belong to `kind`.
    pattern_range: Range<usize>,
}

struct MergedQuery {
    query: Query,
    routes: Vec<QueryRoute>,
}

enum Plan {
    /// No kind has query text.
    Empty,
    /// Run each kind's own query, one traversal each.
    Separate,
    /// Run every kind in one traversal.
    Merged(MergedQuery),
}

/// Where one kind's text sits in the merged text.
struct Segment {
    kind: QueryKind,
    range: Range<usize>,
}

pub(crate) struct QuerySet {
    language_id: String,
    language: Language,
    kinds: [KindQuery; 4],
    /// How the set executes. Decided on first use, because deciding compiles.
    plan: OnceLock<std::result::Result<Plan, String>>,
    compiles: AtomicU32,
}

impl QuerySet {
    pub(crate) fn new(language_id: &str, texts: LanguageQueryTexts<'_>) -> Result<Self> {
        let language = language_for_id(language_id).ok_or_else(|| {
            napi::Error::from_reason(format!("Unsupported language: {language_id}"))
        })?;
        let kinds = QueryKind::ALL.map(|kind| KindQuery {
            text: texts.text(kind).to_string(),
            alone: OnceLock::new(),
        });
        Ok(Self {
            language_id: language_id.to_string(),
            language,
            kinds,
            plan: OnceLock::new(),
            compiles: AtomicU32::new(0),
        })
    }

    pub(crate) fn language_id(&self) -> &str {
        &self.language_id
    }

    pub(crate) fn language(&self) -> &Language {
        &self.language
    }

    /// Tree-sitter compiles this set has cost so far, whether or not they succeeded.
    pub(crate) fn compile_count(&self) -> u32 {
        self.compiles.load(Ordering::Relaxed)
    }

    fn text(&self, kind: QueryKind) -> &str {
        &self.kinds[kind.index()].text
    }

    fn is_active(&self, kind: QueryKind) -> bool {
        !self.text(kind).trim().is_empty()
    }

    fn compile(&self, query_text: &str) -> std::result::Result<Query, String> {
        self.compiles.fetch_add(1, Ordering::Relaxed);
        compile_query(&self.language, query_text)
    }

    /// `kind` compiled by itself, once. A query that does not compile keeps its error message.
    fn alone_compiled(&self, kind: QueryKind) -> &std::result::Result<Query, String> {
        let entry = &self.kinds[kind.index()];
        entry.alone.get_or_init(|| self.compile(&entry.text))
    }

    fn alone(&self, kind: QueryKind) -> Result<&Query> {
        self.alone_compiled(kind)
            .as_ref()
            .map_err(|message| napi::Error::from_reason(message.clone()))
    }

    fn plan(&self) -> Result<&Plan> {
        self.plan
            .get_or_init(|| self.build_plan())
            .as_ref()
            .map_err(|message| napi::Error::from_reason(message.clone()))
    }

    /// Decide how the set executes, compiling what that needs.
    ///
    /// Two or more kinds run in one traversal of a merged query. The merged text is compiled once
    /// and stands for all of them: when it splits back into whole patterns per kind (see
    /// `merged_routes`), each kind's text is a run of complete patterns, so it compiles on its own
    /// and the kinds need no compile of their own. Otherwise the kinds are compiled one at a time
    /// in order, so a query that is invalid on its own reports its own error, and a set whose
    /// texts are each valid but do not merge runs the kinds separately.
    fn build_plan(&self) -> std::result::Result<Plan, String> {
        self.build_plan_with(|merged_text| self.compile(merged_text))
    }

    /// `build_plan`, with the compile of the merged text supplied by the caller so a test can make
    /// it fail.
    fn build_plan_with(
        &self,
        compile_merged: impl FnOnce(&str) -> std::result::Result<Query, String>,
    ) -> std::result::Result<Plan, String> {
        let active: Vec<QueryKind> = QueryKind::ALL
            .into_iter()
            .filter(|kind| self.is_active(*kind))
            .collect();
        match active.len() {
            0 => return Ok(Plan::Empty),
            1 => return Ok(Plan::Separate),
            _ => {}
        }

        let mut merged_text = String::new();
        let mut segments = Vec::with_capacity(active.len());
        for kind in &active {
            let start = merged_text.len();
            merged_text.push_str(self.text(*kind));
            segments.push(Segment {
                kind: *kind,
                range: start..merged_text.len(),
            });
            merged_text.push('\n');
        }

        if let Ok(query) = compile_merged(&merged_text) {
            if let Some(routes) = merged_routes(&query, &merged_text, &segments) {
                return Ok(Plan::Merged(MergedQuery { query, routes }));
            }
        }

        for kind in &active {
            if let Err(message) = self.alone_compiled(*kind) {
                return Err(message.clone());
            }
        }
        Ok(Plan::Separate)
    }

    /// Run every kind's queries over `root` and return the matches by kind.
    pub(crate) fn execute(&self, source: &str, root: Node<'_>) -> Result<NativeQueryResults> {
        self.execute_with_limit(source, root, None)
    }

    #[cfg(test)]
    pub(crate) fn execute_with_match_limit(
        &self,
        source: &str,
        root: Node<'_>,
        match_limit: u32,
    ) -> Result<NativeQueryResults> {
        self.execute_with_limit(source, root, Some(match_limit))
    }

    fn execute_with_limit(
        &self,
        source: &str,
        root: Node<'_>,
        match_limit: Option<u32>,
    ) -> Result<NativeQueryResults> {
        match self.plan()? {
            Plan::Empty => Ok(empty_query_results()),
            Plan::Separate => self.execute_separately(source, root),
            Plan::Merged(merged) => match run_merged(source, root, merged, match_limit)? {
                Some(results) => Ok(results),
                // A traversal that hit the match limit may have dropped matches. Each kind runs
                // again on its own, where the limit applies to that kind alone.
                None => self.execute_separately(source, root),
            },
        }
    }

    /// The merged traversal alone: `None` when the set does not run merged, or the traversal
    /// exceeded `match_limit`.
    #[cfg(test)]
    pub(crate) fn execute_merged(
        &self,
        source: &str,
        root: Node<'_>,
        match_limit: Option<u32>,
    ) -> Result<Option<NativeQueryResults>> {
        match self.plan()? {
            Plan::Empty => Ok(Some(empty_query_results())),
            Plan::Separate => Ok(None),
            Plan::Merged(merged) => run_merged(source, root, merged, match_limit),
        }
    }

    /// Run each kind's own query, one traversal each.
    pub(crate) fn execute_separately(
        &self,
        source: &str,
        root: Node<'_>,
    ) -> Result<NativeQueryResults> {
        let mut results = empty_query_results();
        for kind in QueryKind::ALL {
            if !self.is_active(kind) {
                continue;
            }
            let matches = collect_matches(source, root, self.alone(kind)?);
            *results_for(&mut results, kind) = matches;
        }
        Ok(results)
    }

    /// Run only the imports query and return name, text, and byte offset for each capture.
    pub(crate) fn execute_imports_compact(
        &self,
        source: &str,
        root: Node<'_>,
    ) -> Result<Vec<CompactMatch>> {
        if !self.is_active(QueryKind::Imports) {
            return Ok(Vec::new());
        }
        Ok(collect_compact_matches(
            source,
            root,
            self.alone(QueryKind::Imports)?,
        ))
    }
}

fn empty_query_results() -> NativeQueryResults {
    NativeQueryResults {
        imports: Vec::new(),
        exports: Vec::new(),
        locals: Vec::new(),
        import_bindings: Vec::new(),
    }
}

fn results_for(results: &mut NativeQueryResults, kind: QueryKind) -> &mut Vec<NativeMatch> {
    match kind {
        QueryKind::Imports => &mut results.imports,
        QueryKind::Exports => &mut results.exports,
        QueryKind::Locals => &mut results.locals,
        QueryKind::ImportBindings => &mut results.import_bindings,
    }
}

/// Offset of the first byte of `text` that is not whitespace or a `;` comment, which is where
/// Tree-sitter starts reading a query pattern.
///
/// Only ASCII whitespace counts. Tree-sitter's own whitespace test is a superset of it, so this
/// can only land earlier than Tree-sitter does, which `merged_routes` treats as "does not split".
fn first_token_offset(text: &str) -> Option<usize> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while let Some(&byte) = bytes.get(index) {
        match byte {
            b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c => index += 1,
            b';' => {
                while bytes.get(index).is_some_and(|&byte| byte != b'\n') {
                    index += 1;
                }
            }
            _ => return Some(index),
        }
    }
    None
}

/// Split the patterns of a compiled merged query back into the kinds that wrote them, or `None`
/// when the merged text does not split into whole patterns per kind.
///
/// Tree-sitter records where each pattern's first token starts, and a pattern starts where the
/// previous one ends. A kind whose text holds whole patterns therefore has a pattern starting at
/// its first token. If no pattern does, a pattern from an earlier kind runs into this kind's text
/// (`(call_expression` followed by `function: (identifier))`, say), and the pattern indexes cannot
/// be attributed to kinds.
fn merged_routes(
    query: &Query,
    merged_text: &str,
    segments: &[Segment],
) -> Option<Vec<QueryRoute>> {
    let pattern_count = query.pattern_count();
    let mut next = 0;
    let mut routes = Vec::with_capacity(segments.len());
    for segment in segments {
        let first = next;
        // Kinds are separated by a newline, which no pattern starts on.
        while next < pattern_count && query.start_byte_for_pattern(next) < segment.range.end {
            next += 1;
        }
        let first_token = first_token_offset(&merged_text[segment.range.clone()])
            .map(|offset| segment.range.start + offset);
        let splits_cleanly = match first_token {
            Some(offset) => first < next && query.start_byte_for_pattern(first) == offset,
            // A kind with nothing but comments owns no patterns.
            None => first == next,
        };
        if !splits_cleanly {
            return None;
        }
        routes.push(QueryRoute {
            kind: segment.kind,
            pattern_range: first..next,
        });
    }
    (next == pattern_count).then_some(routes)
}

/// Execute the merged query in one traversal. `None` when the traversal exceeded the match
/// limit, so the caller must not trust its matches.
fn run_merged(
    source: &str,
    root: Node<'_>,
    merged: &MergedQuery,
    match_limit: Option<u32>,
) -> Result<Option<NativeQueryResults>> {
    let capture_names = merged.query.capture_names();
    let mut cursor = QueryCursor::new();
    if let Some(match_limit) = match_limit {
        cursor.set_match_limit(match_limit);
    }
    let mut results = empty_query_results();

    {
        let mut matches = cursor.matches(&merged.query, root, source.as_bytes());
        while let Some(query_match) = matches.next() {
            let pattern_index = query_match.pattern_index;
            let route = merged
                .routes
                .iter()
                .find(|route| route.pattern_range.contains(&pattern_index))
                .ok_or_else(|| {
                    napi::Error::from_reason(format!(
                        "Merged query returned an unknown pattern index: {pattern_index}"
                    ))
                })?;
            let captures = query_match
                .captures()
                .iter()
                .map(|capture| capture_to_object(source, capture, capture_names))
                .collect();
            results_for(&mut results, route.kind).push(NativeMatch {
                pattern_index: (pattern_index - route.pattern_range.start) as u32,
                captures,
            });
        }
    }

    if cursor.did_exceed_match_limit() {
        return Ok(None);
    }
    Ok(Some(results))
}

/// Registered query sets, by id. Ids start at 1 and are never reused or released.
pub(crate) struct QuerySetRegistry {
    capacity: usize,
    sets: Vec<Arc<QuerySet>>,
    /// Ids of the sets registered for each language, so finding an equal set compares only that
    /// language's few sets.
    by_language: HashMap<String, Vec<u32>>,
}

impl QuerySetRegistry {
    pub(crate) fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            sets: Vec::new(),
            by_language: HashMap::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.sets.len()
    }

    /// The id of the set already registered for these texts, if any.
    pub(crate) fn find(&self, language_id: &str, texts: LanguageQueryTexts<'_>) -> Option<u32> {
        self.by_language
            .get(language_id)?
            .iter()
            .copied()
            .find(|id| {
                self.get(*id).is_some_and(|set| {
                    QueryKind::ALL
                        .iter()
                        .all(|kind| set.text(*kind) == texts.text(*kind))
                })
            })
    }

    /// The id for these texts: the existing one when they are registered, a new one otherwise.
    pub(crate) fn register(
        &mut self,
        language_id: &str,
        texts: LanguageQueryTexts<'_>,
    ) -> Result<u32> {
        if let Some(id) = self.find(language_id, texts) {
            return Ok(id);
        }
        if self.sets.len() >= self.capacity {
            return Err(napi::Error::from_reason(format!(
                "Too many query sets are registered ({}); register each language's queries once and reuse the id",
                self.capacity
            )));
        }
        let set = QuerySet::new(language_id, texts)?;
        self.sets.push(Arc::new(set));
        let id = self.sets.len() as u32;
        self.by_language
            .entry(language_id.to_string())
            .or_default()
            .push(id);
        Ok(id)
    }

    pub(crate) fn get(&self, id: u32) -> Option<Arc<QuerySet>> {
        let index = (id as usize).checked_sub(1)?;
        self.sets.get(index).cloned()
    }
}

static QUERY_SETS: LazyLock<RwLock<QuerySetRegistry>> =
    LazyLock::new(|| RwLock::new(QuerySetRegistry::with_capacity(MAX_QUERY_SETS)));

/// Register a language's queries and return the id extraction calls take in their place.
/// Registering the same texts for the same language again, from any thread, returns the same id.
pub(crate) fn register_query_set(language_id: &str, texts: LanguageQueryTexts<'_>) -> Result<u32> {
    let known = QUERY_SETS
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .find(language_id, texts);
    if let Some(id) = known {
        return Ok(id);
    }
    QUERY_SETS
        .write()
        .unwrap_or_else(PoisonError::into_inner)
        .register(language_id, texts)
}

/// The set registered under `id`.
pub(crate) fn registered_query_set(id: u32) -> Result<Arc<QuerySet>> {
    QUERY_SETS
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .get(id)
        .ok_or_else(|| {
            napi::Error::from_reason(format!(
                "Unknown query set id: {id}; register the queries with registerQuerySet first"
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts_set(imports: &str, exports: &str, locals: &str, import_bindings: &str) -> QuerySet {
        QuerySet::new(
            "ts",
            LanguageQueryTexts {
                imports,
                exports,
                locals,
                import_bindings,
            },
        )
        .expect("query set should build")
    }

    fn parse(source: &str) -> tree_sitter::Tree {
        let mut parser = tree_sitter::Parser::new();
        parser
            .set_language(&language_for_id("ts").expect("typescript language should exist"))
            .expect("parser language should be set");
        parser.parse(source, None).expect("source should parse")
    }

    #[test]
    fn first_token_offset_skips_whitespace_and_comments_only() {
        assert_eq!(first_token_offset("(a)"), Some(0));
        assert_eq!(first_token_offset("  \t\r\n(a)"), Some(5));
        assert_eq!(first_token_offset("; one\n;two\n  (a)"), Some(13));
        assert_eq!(first_token_offset("\n\u{0b}\u{0c}x"), Some(3));
        assert_eq!(first_token_offset(""), None);
        assert_eq!(first_token_offset(" \n "), None);
        assert_eq!(first_token_offset("; only a comment"), None);
        assert_eq!(first_token_offset("; comment\n"), None);
        // A non-ASCII space is not skipped: Tree-sitter may start a pattern after it, and the
        // mismatch sends the set to separate execution instead of misrouting patterns.
        assert_eq!(first_token_offset("\u{a0}(a)"), Some(0));
    }

    #[test]
    fn merged_routes_attribute_each_pattern_to_the_kind_that_wrote_it() {
        let set = ts_set(
            "(identifier) @a\n(identifier) @b",
            "; comment first\n(identifier) @c",
            "; only a comment",
            "(identifier) @d\n(identifier) @e\n(identifier) @f",
        );
        let plan = set.plan().expect("the set should plan");
        let Plan::Merged(merged) = plan else {
            panic!("texts that split into whole patterns per kind must run merged");
        };

        let routes: Vec<(QueryKind, Range<usize>)> = merged
            .routes
            .iter()
            .map(|route| (route.kind, route.pattern_range.clone()))
            .collect();
        assert_eq!(
            routes,
            vec![
                (QueryKind::Imports, 0..2),
                (QueryKind::Exports, 2..3),
                (QueryKind::Locals, 3..3),
                (QueryKind::ImportBindings, 3..6),
            ]
        );
        assert_eq!(merged.query.pattern_count(), 6);
    }

    #[test]
    fn merged_routes_refuse_a_pattern_that_runs_from_one_kind_into_the_next() {
        let language = language_for_id("ts").expect("typescript language should exist");
        let imports = "(call_expression";
        let exports = "function: (identifier)) @call";
        let merged_text = format!("{imports}\n{exports}\n");
        let query = compile_query(&language, &merged_text).expect("the joined text is one pattern");
        let segments = [
            Segment {
                kind: QueryKind::Imports,
                range: 0..imports.len(),
            },
            Segment {
                kind: QueryKind::Exports,
                range: imports.len() + 1..imports.len() + 1 + exports.len(),
            },
        ];

        assert!(merged_routes(&query, &merged_text, &segments).is_none());
    }

    #[test]
    fn kinds_that_do_not_merge_run_separately_and_compile_once_each() {
        let set = ts_set(
            "(import_statement (string) @mod) @stmt",
            "(export_statement) @export",
            "(variable_declarator name: (identifier) @name)",
            "",
        );
        let source = "import { a } from './a';\nexport const b = a;";
        let tree = parse(source);

        let plan = set
            .build_plan_with(|_| Err("the merged text is not valid".to_string()))
            .expect("kinds that are valid on their own still run");
        assert!(matches!(plan, Plan::Separate));
        assert_eq!(
            set.compile_count(),
            3,
            "each active kind compiles once; the failed merge is the caller's"
        );

        assert!(set.plan.set(Ok(plan)).is_ok());
        let first = set
            .execute(source, tree.root_node())
            .expect("separate execution should succeed");
        let second = set
            .execute(source, tree.root_node())
            .expect("separate execution should succeed again");
        assert_eq!(first, second);
        assert_eq!(first.imports.len(), 1);
        assert_eq!(first.exports.len(), 1);
        assert_eq!(first.locals.len(), 1);
        assert_eq!(set.compile_count(), 3, "running again compiles nothing");
    }

    #[test]
    fn a_failed_merge_reports_the_first_kind_that_is_invalid_alone() {
        let set = ts_set(
            "(import_statement (string) @mod) @stmt",
            "(",
            "(variable_declarator name: (identifier) @name)",
            "",
        );

        let error = set
            .build_plan_with(|_| Err("the merged text is not valid".to_string()))
            .err()
            .expect("an invalid kind should fail the plan");

        assert!(error.starts_with("Failed to compile query"), "{error}");
        assert_eq!(
            set.compile_count(),
            2,
            "kinds after the invalid one are not compiled"
        );
    }
}
