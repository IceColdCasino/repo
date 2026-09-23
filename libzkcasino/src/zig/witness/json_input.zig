const std = @import("std");
const fr = @import("fr.zig");
const calcwit = @import("calcwit.zig");

pub fn fnv1a(str: []const u8) u64 {
    const FNV_OFFSET = 0xCBF29CE484222325;
    const FNV_PRIME = 0x100000001B3;
    var hash: u64 = FNV_OFFSET;
    for (str) |c| {
        hash ^= c;
        hash = hash *% FNV_PRIME; // wrapping multiplication
    }
    return hash;
}

fn checkValidNumber(s: []const u8, base: u32) bool {
    for (s) |c| {
        const valid = switch (base) {
            16 => (c >= '0' and c <= '9') or (c >= 'a' and c <= 'f') or (c >= 'A' and c <= 'F'),
            else => c >= '0' and c < '0' + base,
        };
        if (!valid) return false;
    }
    return true;
}

pub fn json2FrElements(val: std.json.Value, allocator: std.mem.Allocator) !std.ArrayList(fr.FrElement) {
    var result: std.ArrayList(fr.FrElement) = .empty;
    errdefer result.deinit(allocator);

    switch (val) {
        .string => |s| {
            var base: u32 = 10;
            var num_str: []const u8 = s;

            if (s.len >= 2) {
                const prefix = s[0..2];
                if (std.mem.eql(u8, prefix, "0b") or std.mem.eql(u8, prefix, "0B")) {
                    num_str = s[2..];
                    base = 2;
                } else if (std.mem.eql(u8, prefix, "0o") or std.mem.eql(u8, prefix, "0O")) {
                    num_str = s[2..];
                    base = 8;
                } else if (std.mem.eql(u8, prefix, "0x") or std.mem.eql(u8, prefix, "0X")) {
                    num_str = s[2..];
                    base = 16;
                }
            }

            if (!checkValidNumber(num_str, base)) {
                return error.InvalidNumber;
            }

            // TODO: Parse number string to FrElement
            // For now, use a simple implementation
            const v = try parseFrElement(num_str, base);
            try result.append(allocator, v);
        },
        .integer => |n| {
            try result.append(allocator, fr.FrElement{ .shortVal = @intCast(n), .type = fr.Fr_SHORT, .longVal = .{0} ** 4 });
        },
        .float => |f| {
            const n = @as(i64, @intFromFloat(f));
            try result.append(allocator, fr.FrElement{ .shortVal = @intCast(n), .type = fr.Fr_SHORT, .longVal = .{0} ** 4 });
        },
        .array => |arr| {
            for (arr.items) |item| {
                var sub = try json2FrElements(item, allocator);
                defer sub.deinit(allocator);
                try result.appendSlice(allocator, sub.items);
            }
        },
        else => return error.InvalidJsonType,
    }

    return result;
}

fn parseFrElement(s: []const u8, base: u32) !fr.FrElement {
    // Parse as u256 to handle large field elements
    const n = try std.fmt.parseInt(u256, s, @intCast(base));
    
    // Convert to FrElement longVal [4]u64
    var longVal: [4]u64 = .{0} ** 4;
    const n_u256: u256 = n;
    longVal[0] = @intCast(n_u256 & 0xFFFFFFFFFFFFFFFF);
    longVal[1] = @intCast((n_u256 >> 64) & 0xFFFFFFFFFFFFFFFF);
    longVal[2] = @intCast((n_u256 >> 128) & 0xFFFFFFFFFFFFFFFF);
    longVal[3] = @intCast((n_u256 >> 192) & 0xFFFFFFFFFFFFFFFF);
    
    // Check if it fits in shortVal (32-bit signed)
    if (n <= 0x7FFFFFFF) {
        return fr.FrElement{ .shortVal = @intCast(n), .type = fr.Fr_SHORT, .longVal = .{0} ** 4 };
    } else {
        return fr.FrElement{ .shortVal = 0, .type = fr.Fr_LONG, .longVal = longVal };
    }
}

pub fn loadJsonValue(ctx: *calcwit.CircomCalcWit, jin: std.json.Value, allocator: std.mem.Allocator) !void {
    var flat = std.StringHashMap(std.json.Value).init(allocator);
    defer flat.deinit();

    try qualifyInput("", jin, &flat, allocator);

    var it = flat.iterator();
    while (it.next()) |entry| {
        const h = fnv1a(entry.key_ptr.*);
        var v = try json2FrElements(entry.value_ptr.*, allocator);
        defer v.deinit(allocator);

        const signalSize = ctx.getInputSignalSize(h);
        if (v.items.len < signalSize) {
            return error.NotEnoughValues;
        }
        if (v.items.len > signalSize) {
            return error.TooManyValues;
        }

        for (v.items, 0..) |val, i| {
            ctx.setInputSignal(h, @intCast(i), val);
        }
    }
}

pub fn loadJson(ctx: *calcwit.CircomCalcWit, json_str: []const u8, allocator: std.mem.Allocator) !void {
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, json_str, .{});
    defer parsed.deinit();
    try loadJsonValue(ctx, parsed.value, allocator);
}

fn qualifyInput(prefix: []const u8, jin: std.json.Value, jout: *std.StringHashMap(std.json.Value), allocator: std.mem.Allocator) !void {
    switch (jin) {
        .array => |arr| {
            if (arr.items.len > 0) {
                // TODO: handle array of objects
                try jout.put(prefix, jin);
            } else {
                try jout.put(prefix, jin);
            }
        },
        .object => |obj| {
            var it = obj.iterator();
            while (it.next()) |entry| {
                const new_prefix = if (prefix.len == 0) entry.key_ptr.* else try std.fmt.allocPrint(allocator, "{s}.{s}", .{ prefix, entry.key_ptr.* });
                try qualifyInput(new_prefix, entry.value_ptr.*, jout, allocator);
            }
        },
        else => {
            try jout.put(prefix, jin);
        },
    }
}
