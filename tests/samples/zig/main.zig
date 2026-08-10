const helpers = @import("./helpers.zig");
const math = @import("./math.zig");

pub fn run() void {
    const value: math.Number = helpers.helper();
    _ = value;
}

const std = @import("std");
const build_options = @import("build_options");
