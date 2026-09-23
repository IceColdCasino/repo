const std = @import("std");

pub const FrElement = extern struct {
    shortVal: i32 align(1),
    type: u32 align(1),
    longVal: [4]u64 align(1),
};

pub const Fr_SHORT = 0x00000000;
pub const Fr_LONG = 0x80000000;
pub const Fr_LONGMONTGOMERY = 0xC0000000;

pub const Fr_N64 = 4;

test "FrElement size and alignment" {
    try std.testing.expectEqual(@as(usize, 40), @sizeOf(FrElement));
    try std.testing.expectEqual(@as(usize, 1), @alignOf(FrElement));
}
