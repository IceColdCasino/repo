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

// External symbols from libfr.a
extern const Fr_q: FrElement;
extern const Fr_R3: FrElement;
// Fr_rawq is a local symbol in libfr.a, use Fr_q.longVal instead
extern const Fr_rawR3: [Fr_N64]u64;

// libfr.a raw functions
extern "c" fn Fr_rawCopy(dst: [*c]u64, src: [*c]u64) void;
extern "c" fn Fr_rawSwap(a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawAdd(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawSub(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawNeg(dst: [*c]u64, a: [*c]u64) void;
extern "c" fn Fr_rawMMul(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawMMul1(dst: [*c]u64, a: [*c]u64, b: u64) void;
extern "c" fn Fr_rawFromMontgomery(dst: [*c]u64, src: [*c]u64) void;

// C++ mangling of Fr_rawToMontgomery depends on whether uint64_t is
// unsigned long. The wrapper in fr_raw_to_montgomery.cpp makes one C name.
extern "c" fn zkcasino_Fr_rawToMontgomery(dst: [*c]u64, src: [*c]u64) void;
export fn Fr_rawToMontgomery(dst: [*c]u64, src: [*c]u64) void {
    zkcasino_Fr_rawToMontgomery(dst, src);
}
extern "c" fn Fr_rawIsEq(a: [*c]u64, b: [*c]u64) c_int;
extern "c" fn Fr_rawIsZero(a: [*c]u64) c_int;
extern "c" fn Fr_rawAnd(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawOr(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawXor(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawNot(dst: [*c]u64, a: [*c]u64) void;
extern "c" fn Fr_rawShl(dst: [*c]u64, a: [*c]u64, n: u64) void;
extern "c" fn Fr_rawShr(dst: [*c]u64, a: [*c]u64, n: u64) void;
extern "c" fn Fr_rawCmp(a: [*c]u64, b: [*c]u64) c_int;

pub export fn Fr_copy(r: [*c]FrElement, a: [*c]FrElement) void {
    r.* = a.*;
}

pub export fn Fr_copyn(r: [*c]FrElement, a: [*c]FrElement, n: c_int) void {
    for (0..@intCast(n)) |i| {
        r[i] = a[i];
    }
}

fn toLongNormal(pE: [*c]FrElement) void {
    const p = pE;
    if ((p.*.type & Fr_LONG) == 0) {
        const sv = p.*.shortVal;
        p.*.type = Fr_LONG;
        const longVal_ptr = @as([*c]u64, @ptrCast(@alignCast(&p.*.longVal)));
        for (0..4) |i| longVal_ptr[i] = 0;
        if (sv < 0) {
            // negative: result = q - |sv|
            const dest_ptr = @as([*c]u64, @ptrCast(@alignCast(&p.*.longVal)));
            const src_ptr = @as([*c]u64, @ptrCast(@alignCast(@constCast(&Fr_q.longVal))));
            for (0..4) |i| dest_ptr[i] = src_ptr[i];
            const abs_sv = @as(u64, @intCast(-@as(i64, sv)));
            var borrow = abs_sv;
            for (0..4) |i| {
                const val = longVal_ptr[i];
                const diff = val -% borrow;
                borrow = if (diff > val) 1 else 0;
                longVal_ptr[i] = diff;
            }
        } else {
            longVal_ptr[0] = @as(u64, @intCast(sv));
        }
    }
    if (p.*.type == Fr_LONGMONTGOMERY) {
        Fr_rawFromMontgomery(@ptrCast(@alignCast(&p.*.longVal)), @ptrCast(@alignCast(&p.*.longVal)));
        p.*.type = Fr_LONG;
    }
}

fn toMontgomery(pE: [*c]FrElement) void {
    toLongNormal(pE);
    const p = pE;
    if (p.*.type == Fr_LONG) {
        Fr_rawToMontgomery(@ptrCast(@alignCast(&p.*.longVal)), @ptrCast(@alignCast(&p.*.longVal)));
        p.*.type = Fr_LONGMONTGOMERY;
    }
}

pub export fn Fr_toNormal(r: [*c]FrElement, a: [*c]FrElement) void {
    r.* = a.*;
    toLongNormal(r);
}

pub export fn Fr_toLongNormal(r: [*c]FrElement, a: [*c]FrElement) void {
    r.* = a.*;
    toLongNormal(r);
}

pub export fn Fr_toMontgomery(r: [*c]FrElement, a: [*c]FrElement) void {
    r.* = a.*;
    toMontgomery(r);
}

pub export fn Fr_add(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var ta = a.*;
    var tb = b.*;
    toLongNormal(&ta);
    toLongNormal(&tb);
    r.*.type = Fr_LONG;
    Fr_rawAdd(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), @ptrCast(@alignCast(&tb.longVal)));
}

pub export fn Fr_sub(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var ta = a.*;
    var tb = b.*;
    toLongNormal(&ta);
    toLongNormal(&tb);
    r.*.type = Fr_LONG;
    Fr_rawSub(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), @ptrCast(@alignCast(&tb.longVal)));
}

pub export fn Fr_neg(r: [*c]FrElement, a: [*c]FrElement) void {
    var ta = a.*;
    toLongNormal(&ta);
    r.*.type = Fr_LONG;
    Fr_rawNeg(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)));
}

pub export fn Fr_mul(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var ta = a.*;
    var tb = b.*;
    toMontgomery(&ta);
    toMontgomery(&tb);
    r.*.type = Fr_LONGMONTGOMERY;
    Fr_rawMMul(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), @ptrCast(@alignCast(&tb.longVal)));
}

pub export fn Fr_square(r: [*c]FrElement, a: [*c]FrElement) void {
    Fr_mul(r, a, a);
}

pub export fn Fr_band(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var ta = a.*;
    var tb = b.*;
    toLongNormal(&ta);
    toLongNormal(&tb);
    r.*.type = Fr_LONG;
    Fr_rawAnd(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), @ptrCast(@alignCast(&tb.longVal)));
}

pub export fn Fr_bor(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var ta = a.*;
    var tb = b.*;
    toLongNormal(&ta);
    toLongNormal(&tb);
    r.*.type = Fr_LONG;
    Fr_rawOr(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), @ptrCast(@alignCast(&tb.longVal)));
}

pub export fn Fr_bxor(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var ta = a.*;
    var tb = b.*;
    toLongNormal(&ta);
    toLongNormal(&tb);
    r.*.type = Fr_LONG;
    Fr_rawXor(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), @ptrCast(@alignCast(&tb.longVal)));
}

pub export fn Fr_bnot(r: [*c]FrElement, a: [*c]FrElement) void {
    var ta = a.*;
    toLongNormal(&ta);
    r.*.type = Fr_LONG;
    Fr_rawNot(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)));
}

pub export fn Fr_shl(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var ta = a.*;
    var tb = b.*;
    toLongNormal(&ta);
    toLongNormal(&tb);
    const n = tb.longVal[0];
    r.*.type = Fr_LONG;
    Fr_rawShl(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), n);
}

pub export fn Fr_shr(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var ta = a.*;
    var tb = b.*;
    toLongNormal(&ta);
    toLongNormal(&tb);
    const n = tb.longVal[0];
    r.*.type = Fr_LONG;
    Fr_rawShr(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), n);
}

fn getIntValue(pE: [*c]FrElement) i64 {
    if ((pE.*.type & Fr_LONG) == 0) {
        return pE.*.shortVal;
    }
    var tmp = pE.*;
    toLongNormal(&tmp);

    // Check if represents negative (value > q/2)
    const is_large = tmp.longVal[0] >> 31;
    if (is_large != 0 or tmp.longVal[1] != 0 or tmp.longVal[2] != 0 or tmp.longVal[3] != 0) {
        return @as(i64, @intCast(tmp.longVal[0])) - @as(i64, @intCast(Fr_q.longVal[0]));
    }
    return @as(i64, @intCast(tmp.longVal[0]));
}

pub export fn Fr_eq(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (getIntValue(a) == getIntValue(b)) 1 else 0;
}

pub export fn Fr_neq(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (getIntValue(a) != getIntValue(b)) 1 else 0;
}

pub export fn Fr_lt(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (getIntValue(a) < getIntValue(b)) 1 else 0;
}

pub export fn Fr_gt(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (getIntValue(a) > getIntValue(b)) 1 else 0;
}

pub export fn Fr_leq(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (getIntValue(a) <= getIntValue(b)) 1 else 0;
}

pub export fn Fr_geq(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (getIntValue(a) >= getIntValue(b)) 1 else 0;
}

pub export fn Fr_land(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (Fr_isTrue(a) != 0 and Fr_isTrue(b) != 0) 1 else 0;
}

pub export fn Fr_lor(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (Fr_isTrue(a) != 0 or Fr_isTrue(b) != 0) 1 else 0;
}

pub export fn Fr_lnot(r: [*c]FrElement, a: [*c]FrElement) void {
    r.*.type = Fr_SHORT;
    r.*.shortVal = if (Fr_isTrue(a) != 0) 0 else 1;
}

pub export fn Fr_isTrue(pE: [*c]FrElement) c_int {
    if ((pE.*.type & Fr_LONG) == 0) {
        return if (pE.*.shortVal != 0) 1 else 0;
    }
    return Fr_rawIsZero(@ptrCast(@alignCast(&pE.*.longVal)));
}

pub export fn Fr_toInt(pE: [*c]FrElement) c_int {
    return @intCast(getIntValue(pE));
}

pub export fn Fr_fail() void {
    // no-op
}

pub export fn Fr_rawMSquare(pRawResult: [*c]u64, pRawA: [*c]u64) void {
    Fr_rawMMul(pRawResult, pRawA, pRawA);
}

pub export fn fnv1a(str: [*c]const u8) u64 {
    const FNV_OFFSET = 0xCBF29CE484222325;
    const FNV_PRIME = 0x100000001B3;
    var hash: u64 = FNV_OFFSET;
    var i: usize = 0;
    while (str[i] != 0) : (i += 1) {
        hash ^= @as(u64, @intCast(str[i]));
        hash = hash *% FNV_PRIME;
    }
    return hash;
}

test "FrElement size and alignment" {
    try std.testing.expectEqual(@as(usize, 40), @sizeOf(FrElement));
    try std.testing.expectEqual(@as(usize, 1), @alignOf(FrElement));
}

test "Fr_add simple" {
    var a = FrElement{ .shortVal = 5, .type = Fr_SHORT, .longVal = .{0} ** 4 };
    var b = FrElement{ .shortVal = 3, .type = Fr_SHORT, .longVal = .{0} ** 4 };
    var r = FrElement{ .shortVal = 0, .type = Fr_SHORT, .longVal = .{0} ** 4 };

    Fr_add(&r, &a, &b);

    try std.testing.expectEqual(Fr_LONG, r.type);
    try std.testing.expectEqual(@as(u64, 8), r.longVal[0]);
}
