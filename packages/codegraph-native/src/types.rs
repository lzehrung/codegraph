use napi_derive::napi;
use tree_sitter::Point;

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

pub(crate) fn point_with_index(point: Point, index: usize) -> NativePoint {
    NativePoint {
        row: point.row as u32,
        column: point.column as u32,
        index: index as u32,
    }
}
