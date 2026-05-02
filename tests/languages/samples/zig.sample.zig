const std = @import("std");

pub fn run() void {
    _ = std;
}

test "basic" {
    try std.testing.expect(true);
}
