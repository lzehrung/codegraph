const api = @import("./api.zig");

pub fn run() i32 { // @def run
    var box = api.Box{ .value = 3 };
    box.bump(2); // @ref bump @goto bump
    const value = box.read(); // @ref read @goto read
    const nested = api.Container.Nested.answer(); // @ref answer @known-gap nested_imported_method_reference observed=none
    const nested_goto = api.Container.Nested.answer(); // @goto answer @known-gap nested_imported_method_goto observed=not_found
    const visible = api.exported(); // @ref exported @goto exported
    const hidden = api.internalUser(); // @ref internalUser @goto internalUser
    return value + nested + nested_goto + visible + hidden;
}

test "api calls from test block" {
    _ = api.exported(); // @ref exported @goto exported
    _ = api.internalUser(); // @ref internalUser @goto internalUser
    var box = api.Box{ .value = 1 };
    box.bump(1); // @ref bump @goto bump
    _ = box.read(); // @ref read @goto read
}

comptime {
    const decoy = "exported internalUser"; // @not-ref exported @not-ref internalUser
    _ = decoy;
}

// @not-ref-block exported
const poem =
    \\exported internalUser Box
    \\answer bump
;

// exported internalUser answer bump are decoys in this comment.
