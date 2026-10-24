pub use crate::calc::{add as renamed_add, mul}; // @ref add @ref mul
pub use crate::shapes::Circle as Ring; // @ref Circle

pub fn through_reexport() -> i32 {
    mul(1, 2) // @goto mul
}
