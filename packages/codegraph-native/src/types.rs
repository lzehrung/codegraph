#[cfg(not(test))]
use napi::bindgen_prelude::{Int32Array, Uint32Array, Uint8Array};
use napi_derive::napi;
use tree_sitter::Point;

#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct NativePoint {
    pub row: u32,
    pub column: u32,
    pub index: u32,
}

#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct NativeCapture {
    pub name: String,
    pub text: String,
    pub node_type: String,
    pub start: NativePoint,
    pub end: NativePoint,
}

#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct NativeMatch {
    pub pattern_index: u32,
    pub captures: Vec<NativeCapture>,
}

#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct NativeQueryResults {
    pub imports: Vec<NativeMatch>,
    pub exports: Vec<NativeMatch>,
    pub locals: Vec<NativeMatch>,
    pub import_bindings: Vec<NativeMatch>,
}

/// Not built in unit tests: it carries a projected tree, whose typed arrays hold JS
/// references. See `NativeSyntaxTree`.
#[cfg(not(test))]
#[napi(object)]
pub struct NativeLanguageExtraction {
    pub results: NativeQueryResults,
    pub syntax_tree: NativeSyntaxTree,
}

/// Compact capture with only name and text -- used by graph-mode imports
/// where position and node-type data are not consumed by the caller.
#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct CompactCapture {
    pub name: String,
    pub text: String,
}

#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct CompactMatch {
    pub pattern_index: u32,
    pub captures: Vec<CompactCapture>,
}

#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct CompactQueryResults {
    pub imports: Vec<CompactMatch>,
}

#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct NativeDuplicateTokens {
    pub normalized_tokens: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
#[napi(object)]
pub struct NativeQueryRunResult {
    pub matches: Vec<NativeMatch>,
}

/// Column-oriented projection of a Tree-sitter tree.
///
/// Every attribute is one typed array indexed by node id, and node kinds and child
/// field names are interned into string tables. A grammar has a few hundred distinct
/// kinds, so a file with 2,000 nodes crosses the napi boundary as ~15 typed arrays
/// plus ~200 strings instead of 2,000 objects holding ~4,000 strings. That keeps both
/// the boundary crossing and the worker-to-main-thread transfer proportional to bytes
/// rather than to node count, and lets the transfer move buffers instead of cloning.
///
/// Child lists use compressed sparse row layout: the children of node `i` are
/// `child_ids[child_offsets[i]..child_offsets[i + 1]]`, and `child_field_name_ids`
/// is parallel to `child_ids`.
///
/// Excluded from `cfg(test)` builds: typed arrays hold JS references whose `Drop`
/// calls into the Node runtime, which the `noop` feature used by `cargo test` does
/// not provide. Unit tests cover `projection::project_columns`, which is pure Rust;
/// this type is only the marshalling shell around it, and the JS-side parity suites
/// exercise it end to end.
#[cfg(not(test))]
#[napi(object)]
pub struct NativeSyntaxTree {
    pub root_id: u32,
    pub node_count: u32,
    /// Distinct node kinds; `kind_ids[i]` indexes this table.
    pub kinds: Vec<String>,
    /// Distinct child field names; index 0 is always the empty name.
    pub field_names: Vec<String>,
    pub kind_ids: Uint32Array,
    /// -1 for the root node.
    pub parent_ids: Int32Array,
    pub named: Uint8Array,
    pub start_row: Uint32Array,
    pub start_column: Uint32Array,
    /// UTF-8 byte offset, matching Tree-sitter's `start_byte()`.
    pub start_index: Uint32Array,
    pub end_row: Uint32Array,
    pub end_column: Uint32Array,
    /// UTF-8 byte offset, matching Tree-sitter's `end_byte()`.
    pub end_index: Uint32Array,
    pub child_offsets: Uint32Array,
    pub child_ids: Uint32Array,
    pub child_field_name_ids: Uint32Array,
    pub named_child_offsets: Uint32Array,
    pub named_child_ids: Uint32Array,
}

pub(crate) fn point_with_index(point: Point, index: usize) -> NativePoint {
    NativePoint {
        row: point.row as u32,
        column: point.column as u32,
        index: index as u32,
    }
}
