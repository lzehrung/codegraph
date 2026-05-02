const helpers = @import("./helpers.zig");
const math = @import("./math.zig");

pub fn run() void {
    const value: math.Number = helpers.helper();
    _ = value;
}
