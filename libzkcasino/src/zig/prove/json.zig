//! Flatten witness inputs the same way TypeScript `Circuit._normalizeParams` does:
//! every field is a JSON array of decimal strings.
const std = @import("std");
const Fr = @import("../crypto/fr.zig").Fr;
const baby = @import("../crypto/babyjub.zig");
const elg = @import("../crypto/elgamal.zig");

pub const Point = baby.Point;
pub const Ciphertext = elg.Ciphertext;
pub const PublicKey = elg.PublicKey;

pub const Json = struct {
    alloc: std.mem.Allocator,
    buf: std.ArrayList(u8) = .empty,
    first: bool = true,

    pub fn init(alloc: std.mem.Allocator) Json {
        return .{ .alloc = alloc };
    }

    pub fn deinit(self: *Json) void {
        self.buf.deinit(self.alloc);
    }

    pub fn begin(self: *Json) !void {
        try self.buf.append(self.alloc, '{');
        self.first = true;
    }

    pub fn finish(self: *Json) ![:0]u8 {
        try self.buf.append(self.alloc, '}');
        try self.buf.append(self.alloc, 0);
        const slice = try self.buf.toOwnedSlice(self.alloc);
        return slice[0 .. slice.len - 1 :0];
    }

    fn key(self: *Json, name: []const u8) !void {
        if (!self.first) try self.buf.append(self.alloc, ',');
        self.first = false;
        try self.buf.append(self.alloc, '"');
        try self.buf.appendSlice(self.alloc, name);
        try self.buf.appendSlice(self.alloc, "\":[");
    }

    fn endArr(self: *Json) !void {
        try self.buf.append(self.alloc, ']');
    }

    fn commaVal(self: *Json, first_val: *bool) !void {
        if (!first_val.*) try self.buf.append(self.alloc, ',');
        first_val.* = false;
    }

    fn writeQuoted(self: *Json, s: []const u8) !void {
        try self.buf.append(self.alloc, '"');
        try self.buf.appendSlice(self.alloc, s);
        try self.buf.append(self.alloc, '"');
    }

    fn writeFr(self: *Json, v: Fr) !void {
        var dec: [80]u8 = undefined;
        try self.writeQuoted(v.toDec(&dec));
    }

    pub fn fieldFr(self: *Json, name: []const u8, v: Fr) !void {
        try self.key(name);
        try self.writeFr(v);
        try self.endArr();
    }

    pub fn fieldU64(self: *Json, name: []const u8, v: u64) !void {
        try self.key(name);
        var tmp: [32]u8 = undefined;
        const s = std.fmt.bufPrint(&tmp, "{d}", .{v}) catch unreachable;
        try self.writeQuoted(s);
        try self.endArr();
    }

    pub fn fieldDec(self: *Json, name: []const u8, s: []const u8) !void {
        try self.key(name);
        try self.writeQuoted(s);
        try self.endArr();
    }

    pub fn fieldFrs(self: *Json, name: []const u8, vs: []const Fr) !void {
        try self.key(name);
        var first_val = true;
        for (vs) |v| {
            try self.commaVal(&first_val);
            try self.writeFr(v);
        }
        try self.endArr();
    }

    pub fn fieldU64s(self: *Json, name: []const u8, vs: []const u64) !void {
        try self.key(name);
        var first_val = true;
        var tmp: [32]u8 = undefined;
        for (vs) |v| {
            try self.commaVal(&first_val);
            const s = std.fmt.bufPrint(&tmp, "{d}", .{v}) catch unreachable;
            try self.writeQuoted(s);
        }
        try self.endArr();
    }

    pub fn fieldBytes(self: *Json, name: []const u8, vs: []const u8) !void {
        try self.key(name);
        var first_val = true;
        var tmp: [8]u8 = undefined;
        for (vs) |v| {
            try self.commaVal(&first_val);
            const s = std.fmt.bufPrint(&tmp, "{d}", .{v}) catch unreachable;
            try self.writeQuoted(s);
        }
        try self.endArr();
    }

    pub fn fieldPoint(self: *Json, name: []const u8, p: Point) !void {
        try self.key(name);
        try self.writeFr(p.x);
        try self.buf.append(self.alloc, ',');
        try self.writeFr(p.y);
        try self.endArr();
    }

    pub fn fieldPoints(self: *Json, name: []const u8, ps: []const Point) !void {
        try self.key(name);
        var first_val = true;
        for (ps) |p| {
            try self.commaVal(&first_val);
            try self.writeFr(p.x);
            try self.commaVal(&first_val);
            try self.writeFr(p.y);
        }
        try self.endArr();
    }

    pub fn fieldCt(self: *Json, name: []const u8, ct: Ciphertext) !void {
        try self.fieldCts(name, &.{ct});
    }

    pub fn fieldCts(self: *Json, name: []const u8, cts: []const Ciphertext) !void {
        try self.key(name);
        var first_val = true;
        for (cts) |ct| {
            inline for (ct.limbs()) |limb| {
                try self.commaVal(&first_val);
                try self.writeFr(limb);
            }
        }
        try self.endArr();
    }

    pub fn fieldCts2(self: *Json, name: []const u8, rows: []const []const Ciphertext) !void {
        try self.key(name);
        var first_val = true;
        for (rows) |row| {
            for (row) |ct| {
                inline for (ct.limbs()) |limb| {
                    try self.commaVal(&first_val);
                    try self.writeFr(limb);
                }
            }
        }
        try self.endArr();
    }

    pub fn fieldFrGrid(self: *Json, name: []const u8, rows: []const []const Fr) !void {
        try self.key(name);
        var first_val = true;
        for (rows) |row| {
            for (row) |v| {
                try self.commaVal(&first_val);
                try self.writeFr(v);
            }
        }
        try self.endArr();
    }
};

pub fn registerJson(alloc: std.mem.Allocator, sk: Fr, pk: PublicKey) ![:0]u8 {
    var j = Json.init(alloc);
    errdefer j.deinit();
    try j.begin();
    try j.fieldFr("privateKey", sk);
    try j.fieldPoint("publicKey", pk);
    return j.finish();
}

pub fn shuffleJson(
    alloc: std.mem.Allocator,
    hash: Fr,
    deck: []const Ciphertext,
    keys: []const PublicKey,
    matrix: []const u8,
    randomness: []const Fr,
) ![:0]u8 {
    var j = Json.init(alloc);
    errdefer j.deinit();
    try j.begin();
    try j.fieldFr("hash", hash);
    try j.fieldCts("deck", deck);
    try j.fieldPoints("publicKeys", keys);
    try j.fieldBytes("permutationMatrix", matrix);
    try j.fieldFrs("randomness", randomness);
    return j.finish();
}

pub fn linearShareJson(
    alloc: std.mem.Allocator,
    hash: Fr,
    deck: []const Ciphertext,
    pk: PublicKey,
    keys: []const PublicKey,
    n_actual: u64,
    sk: Fr,
    randomness: []const []const Fr,
) ![:0]u8 {
    var j = Json.init(alloc);
    errdefer j.deinit();
    try j.begin();
    try j.fieldFr("hash", hash);
    try j.fieldCts("ciphertext", deck);
    try j.fieldPoint("publicKey", pk);
    try j.fieldPoints("publicKeys", keys);
    try j.fieldU64("nActualPlayers", n_actual);
    try j.fieldFr("privateKey", sk);
    try j.fieldFrGrid("randomness", randomness);
    return j.finish();
}
