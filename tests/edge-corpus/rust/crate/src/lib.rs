pub mod api;
pub mod calc;
pub mod consumer;
pub mod decoy;
pub mod nested;
pub mod shadow;
pub mod shapes;
pub mod field_error;

// Macros are intentionally out of scope. `self::` is this crate root; raw strings and comments repeat real names as decoys.
use self::calc::add; // @ref add

/// `add` and `square` appear in this doc comment only as decoys.
pub fn from_root() -> i32 {
    let via_self = add(1, 2); // @goto add
    let raw_decoy = r##"add square // @coverage not_indexed complete"##; // @not-ref add @not-ref square
    let commented = 0; /* Circle */ // Circle appears only in this comment @not-ref Circle
    let _ = via_self + raw_decoy.len() as i32 + commented;
    via_self
}
