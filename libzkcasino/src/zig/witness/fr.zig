const std = @import("std");

pub const FrElement = extern struct {
    shortVal: i32 align(1),
    type: u32 align(1),
    longVal: [4]u64 align(1),
};

pub const Fr_SHORT = 0x00000000;
pub const Fr_MONT = 0x40000000;
pub const Fr_LONG = 0x80000000;
pub const Fr_LONGMONTGOMERY = 0xC0000000;

// 2^256 mod Q, and R^2 mod Q. n0' = -Q^{-1} mod 2^64 (CIOS).
const R_MOD_Q = [4]u64{
    0xac96341c4ffffffb,
    0x36fc76959f60cd29,
    0x666ea36f7879462e,
    0x0e0a77c19a07df2f,
};
const R2 = [4]u64{
    0x1bb8e645ae216da7,
    0x53fe3ab1e35c59e3,
    0x8c49833d53bb8085,
    0x0216d0b17f4e44a5,
};
const MONT_N0: u64 = 0xc2e1f593efffffff;

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
            const diff: u128 = @as(u128, r[i]) -% @as(u128, Q_LIMBS[i]) -% borrow;
            r[i] = @truncate(diff);
            borrow = if (diff > 0xffffffffffffffff) 1 else 0;
        }
    }
}

fn plainSub(a: [*c]const u64, b: [*c]const u64, out: [*c]u64) void {
    var borrow: u64 = 0;
    inline for (0..4) |i| {
        const diff: u128 = @as(u128, a[i]) -% @as(u128, b[i]) -% borrow;
        out[i] = @truncate(diff);
        borrow = if (diff > 0xffffffffffffffff) 1 else 0;
    }
}

// Pure Zig modular subtraction: r = (a - b) mod Q
pub fn rawSub(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    if (rawCmp(a, b) >= 0) {
        plainSub(a, b, r);
        return;
    }
    var gap: [4]u64 = undefined;
    plainSub(b, a, &gap);
    plainSub(&Q_LIMBS, &gap, r);
}

// Pure Zig modular negation: r = (-a) mod Q
pub fn rawNeg(r: [*c]u64, a: [*c]u64) void {
    if (a[0] == 0 and a[1] == 0 and a[2] == 0 and a[3] == 0) {
        r[0] = 0;
        r[1] = 0;
        r[2] = 0;
        r[3] = 0;
        return;
    }
    rawSub(r, @constCast(&Q_LIMBS), a);
}

fn load4(p: [*c]u64) [4]u64 {
    return .{ p[0], p[1], p[2], p[3] };
}

fn store4(p: [*c]u64, v: [4]u64) void {
    inline for (0..4) |i| p[i] = v[i];
}

fn cmp4(a: [4]u64, b: [4]u64) i32 {
    inline for (0..4) |i| {
        const j = 3 - i;
        if (a[j] < b[j]) return -1;
        if (a[j] > b[j]) return 1;
    }
    return 0;
}

fn subQ(a: [4]u64) [4]u64 {
    var out: [4]u64 = undefined;
    var borrow: u64 = 0;
    inline for (0..4) |i| {
        const diff: u128 = @as(u128, a[i]) -% @as(u128, Q_LIMBS[i]) -% borrow;
        out[i] = @truncate(diff);
        borrow = if (diff > 0xffffffffffffffff) 1 else 0;
    }
    return out;
}

/// CIOS Montgomery multiply. Inputs and output are in Montgomery form.
fn montMul(a: [4]u64, b: [4]u64) [4]u64 {
    var t = [6]u64{ 0, 0, 0, 0, 0, 0 };
    inline for (0..4) |i| {
        var carry: u128 = 0;
        inline for (0..4) |j| {
            const prod = @as(u128, t[j]) + @as(u128, a[j]) * @as(u128, b[i]) + carry;
            t[j] = @truncate(prod);
            carry = prod >> 64;
        }
        const top = @as(u128, t[4]) + carry;
        t[4] = @truncate(top);
        t[5] = @truncate(top >> 64);

        const m: u64 = t[0] *% MONT_N0;
        var carry2: u128 = 0;
        {
            const prod = @as(u128, t[0]) + @as(u128, m) * @as(u128, Q_LIMBS[0]);
            carry2 = prod >> 64;
        }
        inline for (1..4) |j| {
            const prod = @as(u128, t[j]) + @as(u128, m) * @as(u128, Q_LIMBS[j]) + carry2;
            t[j - 1] = @truncate(prod);
            carry2 = prod >> 64;
        }
        const prod = @as(u128, t[4]) + carry2;
        t[3] = @truncate(prod);
        const extra = (prod >> 64) + t[5];
        t[4] = @truncate(extra);
        t[5] = @truncate(extra >> 64);
    }
    var r: [4]u64 = .{ t[0], t[1], t[2], t[3] };
    if (t[4] != 0 or t[5] != 0 or cmp4(r, Q_LIMBS) >= 0) {
        r = subQ(r);
        if (cmp4(r, Q_LIMBS) >= 0) r = subQ(r);
    }
    return r;
}

fn toMont(a: [4]u64) [4]u64 {
    return montMul(a, R2);
}

fn fromMont(a: [4]u64) [4]u64 {
    return montMul(a, .{ 1, 0, 0, 0 });
}

// Normal-domain product mod Q.
pub fn rawMMul(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    const n = fromMont(montMul(toMont(load4(a)), toMont(load4(b))));
    store4(r, n);
}

// Pure Zig modular division: r = (a / b) mod Q = a * b^(q-2) mod Q
pub fn rawDiv(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    var inv_b: [4]u64 = undefined;
    inline for (0..4) |i| inv_b[i] = b[i];
    rawInv(&inv_b, &inv_b);
    rawMMul(r, a, &inv_b);
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

fn shiftCount(b: [*c]u64) u32 {
    if (b[1] != 0 or b[2] != 0 or b[3] != 0 or b[0] >= 256) return 256;
    return @intCast(b[0]);
}

fn u256Shr(a: [4]u64, n: u32) [4]u64 {
    if (n >= 256) return .{ 0, 0, 0, 0 };
    const limb: usize = n / 64;
    const bits: u6 = @intCast(n % 64);
    var out = [4]u64{ 0, 0, 0, 0 };
    var i: usize = 0;
    while (i + limb < 4) : (i += 1) {
        var v: u64 = a[i + limb] >> bits;
        if (bits != 0 and i + limb + 1 < 4) {
            const sh: u6 = @intCast(@as(u8, 64) - @as(u8, bits));
            v |= a[i + limb + 1] << sh;
        }
        out[i] = v;
    }
    return out;
}

fn u256Shl(a: [4]u64, n: u32) [4]u64 {
    if (n >= 256) return .{ 0, 0, 0, 0 };
    const limb: usize = n / 64;
    const bits: u6 = @intCast(n % 64);
    var out = [4]u64{ 0, 0, 0, 0 };
    var i: usize = limb;
    while (i < 4) : (i += 1) {
        var v: u64 = a[i - limb] << bits;
        if (bits != 0 and i >= limb + 1) {
            const sh: u6 = @intCast(@as(u8, 64) - @as(u8, bits));
            v |= a[i - limb - 1] >> sh;
        }
        out[i] = v;
    }
    return out;
}

pub fn rawShl(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    const out = u256Shl(.{ a[0], a[1], a[2], a[3] }, shiftCount(b));
    r[0] = out[0];
    r[1] = out[1];
    r[2] = out[2];
    r[3] = out[3];
}

pub fn rawShr(r: [*c]u64, a: [*c]u64, b: [*c]u64) void {
    const out = u256Shr(.{ a[0], a[1], a[2], a[3] }, shiftCount(b));
    r[0] = out[0];
    r[1] = out[1];
    r[2] = out[2];
    r[3] = out[3];
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

pub export fn Fr_copy(r: [*c]FrElement, a: [*c]FrElement) void {
    r.* = a.*;
}

pub export fn Fr_copyn(r: [*c]FrElement, a: [*c]FrElement, n: usize) void {
    for (0..n) |i| r[i] = a[i];
}

fn shortToNormal(sv: i32) [4]u64 {
    if (sv >= 0) return .{ @intCast(sv), 0, 0, 0 };
    var out = Q_LIMBS;
    var borrow: u64 = @intCast(-@as(i64, sv));
    inline for (0..4) |i| {
        const val = out[i];
        const diff = val -% borrow;
        borrow = if (diff > val) 1 else 0;
        out[i] = diff;
    }
    return out;
}

fn normalLimbs(e: FrElement) [4]u64 {
    if ((e.type & Fr_LONG) == 0) return shortToNormal(e.shortVal);
    if ((e.type & Fr_MONT) != 0) return fromMont(e.longVal);
    return e.longVal;
}

fn montLimbs(e: FrElement) [4]u64 {
    if ((e.type & Fr_MONT) != 0 and (e.type & Fr_LONG) != 0) return e.longVal;
    if ((e.type & Fr_MONT) != 0) return toMont(shortToNormal(e.shortVal));
    return toMont(normalLimbs(e));
}

fn asI32(limbs: [4]u64) ?i32 {
    if (limbs[1] == 0 and limbs[2] == 0 and limbs[3] == 0 and limbs[0] <= 0x7fffffff) {
        return @intCast(limbs[0]);
    }
    var mag = Q_LIMBS;
    var borrow: u64 = 0;
    inline for (0..4) |i| {
        const diff: u128 = @as(u128, mag[i]) -% @as(u128, limbs[i]) -% borrow;
        mag[i] = @truncate(diff);
        borrow = if (diff > 0xffffffffffffffff) 1 else 0;
    }
    if (borrow == 0 and mag[1] == 0 and mag[2] == 0 and mag[3] == 0 and mag[0] > 0 and mag[0] <= 0x80000000) {
        if (mag[0] == 0x80000000) return std.math.minInt(i32);
        return -@as(i32, @intCast(mag[0]));
    }
    return null;
}

fn setFromNormal(r: [*c]FrElement, normal: [4]u64) void {
    const mont = toMont(normal);
    if (asI32(normal)) |s| {
        r.*.shortVal = s;
        r.*.type = Fr_MONT;
        r.*.longVal = mont;
    } else {
        r.*.shortVal = 0;
        r.*.type = Fr_LONGMONTGOMERY;
        r.*.longVal = mont;
    }
}

fn setBool(r: [*c]FrElement, v: bool) void {
    setFromNormal(r, .{ if (v) 1 else 0, 0, 0, 0 });
}

fn add4(a: [4]u64, b: [4]u64) [4]u64 {
    var out: [4]u64 = undefined;
    rawAdd(&out, @constCast(&a), @constCast(&b));
    return out;
}

fn sub4(a: [4]u64, b: [4]u64) [4]u64 {
    var out: [4]u64 = undefined;
    rawSub(&out, @constCast(&a), @constCast(&b));
    return out;
}

pub export fn Fr_toNormal(r: [*c]FrElement, a: [*c]FrElement) void {
    setFromNormal(r, normalLimbs(a.*));
}

pub export fn Fr_toLongNormal(r: [*c]FrElement, a: [*c]FrElement) void {
    const n = normalLimbs(a.*);
    r.*.shortVal = 0;
    r.*.type = Fr_LONG;
    r.*.longVal = n;
}

pub export fn Fr_toMontgomery(r: [*c]FrElement, a: [*c]FrElement) void {
    const n = normalLimbs(a.*);
    setFromNormal(r, n);
}

pub export fn Fr_add(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setFromNormal(r, add4(normalLimbs(a.*), normalLimbs(b.*)));
}

pub export fn Fr_sub(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setFromNormal(r, sub4(normalLimbs(a.*), normalLimbs(b.*)));
}

pub export fn Fr_neg(r: [*c]FrElement, a: [*c]FrElement) void {
    var n = normalLimbs(a.*);
    var out: [4]u64 = undefined;
    rawNeg(&out, &n);
    setFromNormal(r, out);
}

pub export fn Fr_mul(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    const prod = montMul(montLimbs(a.*), montLimbs(b.*));
    setFromNormal(r, fromMont(prod));
}

pub export fn Fr_div(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var an = normalLimbs(a.*);
    var bn = normalLimbs(b.*);
    var out: [4]u64 = undefined;
    rawDiv(&out, &an, &bn);
    setFromNormal(r, out);
}

pub export fn Fr_idiv(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setFromNormal(r, div256(normalLimbs(a.*), normalLimbs(b.*)));
}

fn shl1(a: [4]u64) [4]u64 {
    return .{
        a[0] << 1,
        (a[1] << 1) | (a[0] >> 63),
        (a[2] << 1) | (a[1] >> 63),
        (a[3] << 1) | (a[2] >> 63),
    };
}

fn div256(a: [4]u64, b: [4]u64) [4]u64 {
    if (b[0] == 0 and b[1] == 0 and b[2] == 0 and b[3] == 0) return .{ 0, 0, 0, 0 };
    var quot: [4]u64 = .{ 0, 0, 0, 0 };
    var rem: [4]u64 = .{ 0, 0, 0, 0 };
    var bit: i32 = 255;
    while (bit >= 0) : (bit -= 1) {
        rem = shl1(rem);
        const limb: usize = @intCast(@divFloor(bit, 64));
        const bp: u6 = @intCast(@mod(bit, 64));
        if (((a[limb] >> bp) & 1) != 0) rem[0] |= 1;
        if (cmp4(rem, b) >= 0) {
            var borrow: u64 = 0;
            inline for (0..4) |j| {
                const diff: u128 = @as(u128, rem[j]) -% @as(u128, b[j]) -% borrow;
                rem[j] = @truncate(diff);
                borrow = if (diff > 0xffffffffffffffff) 1 else 0;
            }
            quot[limb] |= @as(u64, 1) << bp;
        }
    }
    return quot;
}

pub export fn Fr_mod(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    const an = normalLimbs(a.*);
    const bn = normalLimbs(b.*);
    const q = div256(an, bn);
    var qb: [4]u64 = undefined;
    rawMMul(&qb, @constCast(&q), @constCast(&bn));
    setFromNormal(r, sub4(an, qb));
}

pub export fn Fr_square(r: [*c]FrElement, a: [*c]FrElement) void {
    Fr_mul(r, a, a);
}

fn bitOp(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement, op: enum { and_, or_, xor }) void {
    const an = normalLimbs(a.*);
    const bn = normalLimbs(b.*);
    var out: [4]u64 = undefined;
    switch (op) {
        .and_ => rawAnd(&out, @constCast(&an), @constCast(&bn)),
        .or_ => rawOr(&out, @constCast(&an), @constCast(&bn)),
        .xor => rawXor(&out, @constCast(&an), @constCast(&bn)),
    }
    setFromNormal(r, out);
}

pub export fn Fr_band(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    bitOp(r, a, b, .and_);
}

pub export fn Fr_bor(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    bitOp(r, a, b, .or_);
}

pub export fn Fr_bxor(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    bitOp(r, a, b, .xor);
}

pub export fn Fr_bnot(r: [*c]FrElement, a: [*c]FrElement) void {
    var an = normalLimbs(a.*);
    var out: [4]u64 = undefined;
    rawNot(&out, &an);
    setFromNormal(r, out);
}

pub export fn Fr_shl(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var an = normalLimbs(a.*);
    var bn = normalLimbs(b.*);
    var out: [4]u64 = undefined;
    rawShl(&out, &an, &bn);
    setFromNormal(r, out);
}

pub export fn Fr_shr(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    var an = normalLimbs(a.*);
    var bn = normalLimbs(b.*);
    var out: [4]u64 = undefined;
    rawShr(&out, &an, &bn);
    setFromNormal(r, out);
}

fn getIntValue(pE: [*c]FrElement) i64 {
    if ((pE.*.type & Fr_LONG) == 0) return pE.*.shortVal;
    const n = normalLimbs(pE.*);
    if (asI32(n)) |s| return s;
    return @intCast(n[0]);
}

// Shorts compare as signed int32 so a descending `for (var i = n; i >= 0; i--)`
// stops at -1. Longs compare as canonical integers. A short and a long are the
// same field element when their normal forms match, including short -1 and Q-1.
fn cmpElements(a: FrElement, b: FrElement) i32 {
    if ((a.type & Fr_LONG) == 0 and (b.type & Fr_LONG) == 0) {
        if (a.shortVal < b.shortVal) return -1;
        if (a.shortVal > b.shortVal) return 1;
        return 0;
    }
    return cmp4(normalLimbs(a), normalLimbs(b));
}

pub export fn Fr_eq(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setBool(r, cmpElements(a.*, b.*) == 0);
}

pub export fn Fr_neq(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setBool(r, cmpElements(a.*, b.*) != 0);
}

pub export fn Fr_lt(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setBool(r, cmpElements(a.*, b.*) < 0);
}

pub export fn Fr_gt(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setBool(r, cmpElements(a.*, b.*) > 0);
}

pub export fn Fr_leq(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setBool(r, cmpElements(a.*, b.*) <= 0);
}

pub export fn Fr_geq(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setBool(r, cmpElements(a.*, b.*) >= 0);
}

pub export fn Fr_land(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setBool(r, Fr_isTrue(a) != 0 and Fr_isTrue(b) != 0);
}

pub export fn Fr_lor(r: [*c]FrElement, a: [*c]FrElement, b: [*c]FrElement) void {
    setBool(r, Fr_isTrue(a) != 0 or Fr_isTrue(b) != 0);
}

pub export fn Fr_lnot(r: [*c]FrElement, a: [*c]FrElement) void {
    setBool(r, Fr_isTrue(a) == 0);
}

pub export fn Fr_isTrue(pE: [*c]FrElement) c_int {
    if ((pE.*.type & Fr_LONG) == 0) return if (pE.*.shortVal != 0) 1 else 0;
    return if (rawIsZero(@ptrCast(@alignCast(@constCast(&pE.*.longVal)))) == 0) 1 else 0;
}

pub export fn Fr_toInt(pE: [*c]FrElement) u64 {
    return @bitCast(getIntValue(pE));
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

    try std.testing.expectEqual(Fr_MONT, r.type);
    try std.testing.expectEqual(@as(i32, 8), r.shortVal);
}

test "montgomery mul of dat-style constants" {
    var one = FrElement{
        .shortVal = 1,
        .type = Fr_MONT,
        .longVal = R_MOD_Q,
    };
    var three = FrElement{ .shortVal = 3, .type = Fr_SHORT, .longVal = @splat(0) };
    var r = FrElement{ .shortVal = 0, .type = Fr_SHORT, .longVal = @splat(0) };
    Fr_mul(&r, &one, &three);
    try std.testing.expectEqual(@as(i32, 3), r.shortVal);
    Fr_add(&r, &one, &three);
    try std.testing.expectEqual(@as(i32, 4), r.shortVal);

    var c253 = FrElement{
        .shortVal = 253,
        .type = Fr_MONT,
        .longVal = .{ 0x350278cb9ffffac6, 0xe0b3f533ccc9a8c3, 0xac73a41f21f8291b, 0x13bdfb9302a0e5f2 },
    };
    Fr_mul(&r, &c253, &one);
    try std.testing.expectEqual(@as(i32, 253), r.shortVal);
    var big = FrElement{
        .shortVal = 0,
        .type = Fr_LONGMONTGOMERY,
        .longVal = .{ 0x1111111111111111, 0x2222222222222222, 0x3333333333333333, 0x0444444444444444 },
    };
    Fr_mul(&r, &big, &one);
    try std.testing.expectEqual(big.longVal, r.longVal);
}

fn isZeroOk(in: FrElement, zero: FrElement, one: FrElement) bool {
    var neq = FrElement{ .shortVal = 0, .type = Fr_SHORT, .longVal = @splat(0) };
    Fr_neq(&neq, @constCast(&in), @constCast(&zero));
    var inv = zero;
    if (Fr_isTrue(&neq) != 0) Fr_div(&inv, @constCast(&one), @constCast(&in));
    var neg = in;
    Fr_neg(&neg, @constCast(&in));
    var prod = in;
    Fr_mul(&prod, &neg, &inv);
    var out = in;
    Fr_add(&out, &prod, @constCast(&one));
    Fr_mul(&prod, @constCast(&in), &out);
    var eq = neq;
    Fr_eq(&eq, &prod, @constCast(&zero));
    return Fr_isTrue(&eq) != 0;
}

test "isZero identity on dat constants" {
    const zero = FrElement{ .shortVal = 0, .type = Fr_MONT, .longVal = @splat(0) };
    const one = FrElement{
        .shortVal = 1,
        .type = Fr_MONT,
        .longVal = .{ 0xac96341c4ffffffb, 0x36fc76959f60cd29, 0x666ea36f7879462e, 0x0e0a77c19a07df2f },
    };
    const negc = FrElement{
        .shortVal = -168700,
        .type = Fr_MONT,
        .longVal = .{ 0xae352631f00d9e21, 0x03bbdae2dbc19d18, 0xd7a4340602f0ed75, 0x212e7350ca5dc135 },
    };
    const big = FrElement{
        .shortVal = 0,
        .type = Fr_LONGMONTGOMERY,
        .longVal = .{ 0xa8fc7bc1a89fa86, 0xa7d9d786e9e48627, 0xee6158b465bea369, 0x14a0ff6d2f874519 },
    };
    try std.testing.expect(isZeroOk(zero, zero, one));
    try std.testing.expect(isZeroOk(one, zero, one));
    try std.testing.expect(isZeroOk(negc, zero, one));
    try std.testing.expect(isZeroOk(big, zero, one));
}

test "div and sub roundtrip" {
    var one = FrElement{ .shortVal = 1, .type = Fr_SHORT, .longVal = @splat(0) };
    var seven = FrElement{ .shortVal = 7, .type = Fr_SHORT, .longVal = @splat(0) };
    var three = FrElement{ .shortVal = 3, .type = Fr_SHORT, .longVal = @splat(0) };
    var four = FrElement{ .shortVal = 4, .type = Fr_SHORT, .longVal = @splat(0) };
    var r = FrElement{ .shortVal = 0, .type = Fr_SHORT, .longVal = @splat(0) };
    var q = r;
    Fr_div(&q, &one, &seven);
    Fr_mul(&r, &q, &seven);
    try std.testing.expectEqual(@as(i32, 1), r.shortVal);
    Fr_sub(&r, &three, &seven);
    Fr_add(&r, &r, &four);
    try std.testing.expectEqual(@as(i32, 0), r.shortVal);
}

test "shr moves whole limbs" {
    var n = FrElement{ .shortVal = 0, .type = Fr_LONG, .longVal = .{ 0, 1, 0, 0 } };
    var sh = FrElement{ .shortVal = 64, .type = Fr_SHORT, .longVal = .{ 64, 0, 0, 0 } };
    var r = FrElement{ .shortVal = 0, .type = Fr_SHORT, .longVal = @splat(0) };
    Fr_shr(&r, &n, &sh);
    try std.testing.expectEqual(@as(i32, 1), r.shortVal);
    n.longVal = .{ 8, 0, 0, 0 };
    n.type = Fr_LONG;
    sh.shortVal = 3;
    sh.longVal[0] = 3;
    Fr_shr(&r, &n, &sh);
    try std.testing.expectEqual(@as(i32, 1), r.shortVal);
}

test "descending loop treats short -1 as less than zero" {
    var neg = FrElement{ .shortVal = 0, .type = Fr_SHORT, .longVal = @splat(0) };
    var one = FrElement{ .shortVal = 1, .type = Fr_SHORT, .longVal = @splat(0) };
    var zero = FrElement{ .shortVal = 0, .type = Fr_SHORT, .longVal = @splat(0) };
    Fr_sub(&neg, &zero, &one);
    try std.testing.expectEqual(@as(i32, -1), neg.shortVal);
    var ge = zero;
    Fr_geq(&ge, &neg, &zero);
    try std.testing.expectEqual(@as(i32, 0), ge.shortVal);
    var q_minus = FrElement{ .shortVal = 0, .type = Fr_LONG, .longVal = shortToNormal(-1) };
    Fr_eq(&ge, &neg, &q_minus);
    try std.testing.expectEqual(@as(i32, 1), ge.shortVal);
}
