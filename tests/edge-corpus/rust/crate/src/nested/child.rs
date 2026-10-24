use super::helper; // @ref helper
use crate::calc::square as crate_square; // @ref square @not-ref decoySquare

// @def from_child
pub fn from_child() -> i32 {
    let from_super = helper(); // @goto helper
    let from_crate = crate_square(1.0); // @goto square=crate_square
    from_super + from_crate as i32
}
