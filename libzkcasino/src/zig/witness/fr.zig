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

// BN254 curve order Q (little-endian limbs)
// Q = 0x30644e72e131a029 * 2^256 + 0x43e1f593f0000001
pub const Q_LIMBS = [4]u64{
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
};

pub const Fr_q = Q_LIMBS;

// Pure Zig modular addition: r = (a + b) mod Q
// a, b, r are pointers to [4]u64 arrays
pub fn rawAdd(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    var carry: u64 = 0;
    inline for (0..4) |i| {
        const sum: u128 = @as(u128, a[i]) + @as(u128, b[i]) + carry;
        r[i] = @truncate(sum);
        carry = @truncate(sum >> 64);
    }
    // Subtract Q if sum >= Q
    var cmp: i32 = 0;
    inline for (0..4) |i| {
        const j = 3 - i;
        if (r[j] < Q_LIMBS[j]) { cmp = -1; break; }
        if (r[j] > Q_LIMBS[j]) { cmp = 1; break; }
    }
    if (cmp >= 0) {
        var borrow: u64 = 0;
        inline for (0..4) |i| {
            const diff: u128 = @as(u128, r[i]) - @as(u128, Q_LIMBS[i]) - borrow;
            r[i] = @truncate(diff);
            borrow = if (diff >> 64 != 0) 1 else 0;
        }
    }
}

// Pure Zig modular subtraction: r = (a - b) mod Q
pub fn rawSub(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    var borrow: u64 = 0;
    inline for (0..4) |i| {
        const diff: u128 = @as(u128, a[i]) - @as(u128, b[i]) - borrow;
        r[i] = @truncate(diff);
        borrow = if (diff >> 64 != 0) 1 else 0;
    }
    // Add Q if result is negative (a < b)
    var cmp: i32 = 0;
    inline for (0..4) |i| {
        if (a[i] < b[i]) { cmp = -1; break; }
        if (a[i] > b[i]) { cmp = 1; break; }
    }
    if (cmp < 0) {
        var carry: u64 = 0;
        inline for (0..4) |i| {
            const sum: u128 = @as(u128, r[i]) + @as(u128, Q_LIMBS[i]) + carry;
            r[i] = @truncate(sum);
            carry = @truncate(sum >> 64);
        }
    }
}

// Pure Zig modular negation: r = (-a) mod Q
pub fn rawNeg(r: [*c]u64, a: [*c]u64) void {
    if (a[0] == 0 and a[1] == 0 and a[2] == 0 and a[3] == 0) {
        r[0] = 0; r[1] = 0; r[2] = 0; r[3] = 0;
    } else {
        var borrow: u64 = 1;
        inline for (0..4) |i| {
            const diff: u128 = @as(u128, 0) - @as(u128, a[i]) - borrow;
            r[i] = @truncate(diff);
            borrow = if (diff >> 64 != 0) 1 else 0;
        }
        // Add Q if result is negative
        var cmp: i32 = 0;
        inline for (0..4) |i| {
            const j = 3 - i;
            if (r[j] < Q_LIMBS[j]) { cmp = -1; break; }
            if (r[j] > Q_LIMBS[j]) { cmp = 1; break; }
        }
        if (cmp < 0) {
            var carry: u64 = 0;
            inline for (0..4) |i| {
                const sum: u128 = @as(u128, r[i]) + @as(u128, Q_LIMBS[i]) + carry;
                r[i] = @truncate(sum);
                carry = @truncate(sum >> 64);
            }
        }
    }
}

// Pure Zig modular multiplication: r = (a * b) mod Q using schoolbook multiplication
pub fn rawMMul(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    // 8-limb intermediate product
    var product: [8]u64 = undefined;
    inline for (0..4) |i| {
        inline for (0..4) |j| {
            const prod: u128 = @as(u128, a[i]) * @as(u128, b[j]);
            product[i + j] += @truncate(prod);
            product[i + j + 1] += @truncate(prod >> 64);
        }
    }
    // Extract lower 4 limbs
    var result: [4]u64 = undefined;
    inline for (0..4) |i| {
        result[i] = product[i];
    }
    // Reduce mod Q using repeated subtraction
    var cmp: i32 = 0;
    inline for (0..4) |i| {
        const j = 3 - i;
        if (result[j] < Q_LIMBS[j]) { cmp = -1; break; }
        if (result[j] > Q_LIMBS[j]) { cmp = 1; break; }
    }
    while (cmp >= 0) {
        var borrow: u64 = 0;
        inline for (0..4) |i| {
            const diff: u128 = @as(u128, result[i]) - @as(u128, Q_LIMBS[i]) - borrow;
            result[i] = @truncate(diff);
            borrow = if (diff >> 64 != 0) 1 else 0;
        }
        cmp = 0;
        inline for (0..4) |i| {
            const j = 3 - i;
            if (result[j] < Q_LIMBS[j]) { cmp = -1; break; }
            if (result[j] > Q_LIMBS[j]) { cmp = 1; break; }
        }
    }
    inline for (0..4) |i| {
        r[i] = result[i];
    }
}

// Pure Zig modular squaring: r = (a * a) mod Q
pub fn rawMSquare(r: [*c]u64, a: [*c]u64) void {
    rawMMul(r, a, a);
}

// Pure Zig modular inversion: r = a^(-1) mod Q using Fermat's little theorem
pub fn rawInv(r: [*c]u64, a: [*c]u64) void {
    var result: [4]u64 = .{1, 0, 0, 0};
    var base: [4]u64 = undefined;
    inline for (0..4) |i| base[i] = a[i];
    const exp: [4]u64 = .{Q_LIMBS[0] - 2, Q_LIMBS[1], Q_LIMBS[2], Q_LIMBS[3]};
    inline for (0..256) |bit| {
        const limb = bit / 64;
        const bitpos = bit % 64;
        if (((exp[limb] >> bitpos) & 1) != 0) {
            rawMMul(&result, &result, &base);
        }
        rawMMul(&base, &base, &base);
    }
    inline for (0..4) |i| r[i] = result[i];
}

// Pure Zig bitwise AND: r = a & b
pub fn rawAnd(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    inline for (0..4) |i| {
        r[i] = a[i] & b[i];
    }
}

// Pure Zig bitwise OR: r = a | b
pub fn rawOr(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    inline for (0..4) |i| {
        r[i] = a[i] | b[i];
    }
}

// Pure Zig bitwise XOR: r = a ^ b
pub fn rawXor(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    inline for (0..4) |i| {
        r[i] = a[i] ^ b[i];
    }
}

// Pure Zig bitwise NOT: r = ~a
pub fn rawNot(r: [*c]u64, a: [*c]u64) void {
    inline for (0..4) |i| {
        r[i] = ~a[i];
    }
}

// Pure Zig shift left: r = a << b (use low limb of b as shift count)
pub fn rawShl(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    const n: u6 = @intCast(b[0] % 64);
    if (n >= 64) {
        r[0] = 0; r[1] = 0; r[2] = 0; r[3] = 0;
    } else if (n == 0) {
        r[0] = a[0]; r[1] = a[1]; r[2] = a[2]; r[3] = a[3];
    } else {
        const n64 = @as(u64, n);
        r[0] = a[0] >> n;
        r[1] = (a[1] >> n) | (a[0] << @intCast(64 - n64));
        r[2] = (a[2] >> n) | (a[1] << @intCast(64 - n64));
        r[3] = (a[3] >> n) | (a[2] << @intCast(64 - n64));
    }
}

// Pure Zig shift right: r = a >> b (use low limb of b as shift count)
pub fn rawShr(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    const n: u6 = @intCast(b[0] % 64);
    if (n >= 64) {
        r[0] = 0; r[1] = 0; r[2] = 0; r[3] = 0;
    } else if (n == 0) {
        r[0] = a[0]; r[1] = a[1]; r[2] = a[2]; r[3] = a[3];
    } else {
        const n64 = @as(u64, n);
        r[3] = a[3] << n;
        r[2] = (a[2] << n) | (a[3] >> @intCast(64 - n64));
        r[1] = (a[1] << n) | (a[2] >> @intCast(64 - n64));
        r[0] = (a[0] << n) | (a[1] >> @intCast(64 - n64));
    }
}

// Pure Zig comparison: return -1 if a < b, 0 if equal, 1 if a > b
pub fn rawCmp(a: [*c]u64, b: [*c]u64) c_int {
    inline for (0..4) |i| {
        const j = 3 - i;
        if (a[j] < b[j]) return -1;
        if (a[j] > b[j]) return 1;
    }
    return 0;
}

// Pure Zig is zero check
pub fn rawIsZero(a: [*c]u64) c_int {
    if (a[0] == 0 and a[1] == 0 and a[2] == 0 and a[3] == 0) return 1;
    return 0;
}

pub fn Fr_copy(r: [*c]FrElement, a: [*c]FrElement) void {
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
            const src_ptr = @as([*c]u64, @ptrCast(@alignCast(@constCast(&Fr_q))));
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
        // Pure Zig Montgomery-to-normal conversion placeholder
        p.*.type = Fr_LONG;
    }
}

fn toMontgomery(pE: [*c]FrElement) void {
    toLongNormal(pE);
    const p = pE;
    if (p.*.type == Fr_LONG) {
        // Pure Zig Montgomery multiplication placeholder
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
    rawAdd(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&ta.longVal)), @ptrCast(@alignCast(&tb.longVal)));
}

pub export fn Fr_sub(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    toLongNormal(a);
    toLongNormal(b);
    r.*.type = Fr_LONG;
    rawSub(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)), @ptrCast(@alignCast(&b.*.longVal)));
}

pub export fn Fr_neg(r: [*c]FrElement, a: [*c]FrElement) void {
    toLongNormal(a);
    r.*.type = Fr_LONG;
    rawNeg(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)));
}

pub export fn Fr_mul(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    toMontgomery(a);
    toMontgomery(b);
    r.*.type = Fr_LONGMONTGOMERY;
    rawMMul(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)), @ptrCast(@alignCast(&b.*.longVal)));
}

pub export fn Fr_square(r: [*c]FrElement, a: [*c]FrElement) void {
    Fr_mul(r, a, a);
}

pub export fn Fr_band(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    toLongNormal(a);
    toLongNormal(b);
    r.*.type = Fr_LONG;
    rawAnd(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)), @ptrCast(@alignCast(&b.*.longVal)));
}

pub export fn Fr_bor(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    toLongNormal(a);
    toLongNormal(b);
    r.*.type = Fr_LONG;
    rawOr(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)), @ptrCast(@alignCast(&b.*.longVal)));
}

pub export fn Fr_bxor(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    toLongNormal(a);
    toLongNormal(b);
    r.*.type = Fr_LONG;
    rawXor(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)), @ptrCast(@alignCast(&b.*.longVal)));
}

pub export fn Fr_bnot(r: [*c]FrElement, a: [*c]FrElement) void {
    toLongNormal(a);
    r.*.type = Fr_LONG;
    rawNot(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)));
}

pub export fn Fr_shl(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    toLongNormal(a);
    toLongNormal(b);
    r.*.type = Fr_LONG;
    rawShl(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)), @ptrCast(@alignCast(&b.*.longVal)));
}

pub export fn Fr_shr(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    toLongNormal(a);
    toLongNormal(b);
    r.*.type = Fr_LONG;
    rawShr(@ptrCast(@alignCast(&r.*.longVal)), @ptrCast(@alignCast(&a.*.longVal)), @ptrCast(@alignCast(&b.*.longVal)));
}

fn getIntValue(pE: [*c]FrElement) i64 {
    if ((pE.*.type & Fr_LONG) == 0) {
        return pE.*.shortVal;
    }
    toLongNormal(pE);

    // Check if represents negative (value > q/2)
    const lv = pE.*.longVal;
    const is_large = lv[0] >> @as(u6, 31);
    if (is_large != 0 or lv[1] != 0 or lv[2] != 0 or lv[3] != 0) {
        return @as(i64, @intCast(lv[0])) - @as(i64, @intCast(Fr_q[0]));
    }
    return @as(i64, @intCast(lv[0]));
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
    return rawIsZero(@ptrCast(@alignCast(&pE.*.longVal)));
}

pub export fn Fr_toInt(pE: [*c]FrElement) c_int {
    return @intCast(getIntValue(pE));
}

pub export fn Fr_fail() void {
    // no-op
}

pub export fn Fr_rawMSquare(pRawResult: [*c]u64, pRawA: [*c]u64) void {
    rawMMul(pRawResult, pRawA, pRawA);
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
    var a = FrElement{ .shortVal = 5, .type = Fr_SHORT, .longVal = @splat(0) };
    var b = FrElement{ .shortVal = 3, .type = Fr_SHORT, .longVal = @splat(0) };
    var r = FrElement{ .shortVal = 0, .type = Fr_SHORT, .longVal = @splat(0) };

    Fr_add(&r, &a, &b);

    try std.testing.expectEqual(Fr_LONG, r.type);
    try std.testing.expectEqual(@as(u64, 8), r.longVal[0]);
}
