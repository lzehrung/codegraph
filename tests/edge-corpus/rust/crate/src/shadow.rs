// @def value
pub fn value() -> i32 {
    1
}

pub fn shadow_with_let() -> i32 {
    let before = value(); // @ref value
    let value = 2; // @def localValue=value
    let after = value; // @ref localValue @goto localValue @not-ref value
    let inner = {
        let value = 3; // @def innerValue=value
        value // @ref innerValue @not-ref localValue
    };
    before + after + inner
}
