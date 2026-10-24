pub mod child;

use self::child::from_child; // @ref from_child

// @def helper
pub fn helper() -> i32 {
    4
}

pub fn through_self() -> i32 {
    from_child() // @goto from_child
}
