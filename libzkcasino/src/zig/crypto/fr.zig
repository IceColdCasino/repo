//! BN254 Fr pure Zig implementation (no rapidsnark dependency).
const std = @import("std");

pub const N64 = 4;
pub const Q_LIMBS = [4]u64{
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
};

// Pure Zig: modular addition (a + b) mod Q
// Q = 0x30644e72e131a029 * 2^256 + 0x43e1f593f0000001
// (BN254 curve order, also known as the "goldilocks" prime variant)
pub fn rawAdd(a: [4]u64, b: [4]u64) [4]u64 {
    var sum: [4]u64 = undefined;
    var carry: u64 = 0;
    inline for (0..4) |i| {
        const w: u128 = @as(u128, a[i]) + @as(u128, b[i]) + carry;
        sum[i] = @truncate(w);
        carry = @truncate(w >> 64);
    }
    // Subtract Q if sum >= Q
    const q = Q_LIMBS;
    const cmp = rawCmp(sum, q);
    if (cmp >= 0) {
        var borrow: u64 = 0;
        inline for (0..4) |i| {
            const w: u128 = @as(u128, sum[i]) -% @as(u128, q[i]) -% borrow;
            sum[i] = @truncate(w);
            borrow = if (w > 0xffffffffffffffff) 1 else 0;
        }
    }
    return sum;
}

fn plainSub(a: [4]u64, b: [4]u64) [4]u64 {
    var diff: [4]u64 = undefined;
    var borrow: u64 = 0;
    inline for (0..4) |i| {
        const w: u128 = @as(u128, a[i]) -% @as(u128, b[i]) -% borrow;
        diff[i] = @truncate(w);
        borrow = if (w > 0xffffffffffffffff) 1 else 0;
    }
    return diff;
}

// Pure Zig: modular subtraction (a - b) mod Q
pub fn rawSub(a: [4]u64, b: [4]u64) [4]u64 {
    if (rawCmp(a, b) >= 0) return plainSub(a, b);
    return plainSub(Q_LIMBS, plainSub(b, a));
}

// Pure Zig: negation -a mod Q
pub fn rawNeg(a: [4]u64) [4]u64 {
    if (rawIsZero(a)) return .{ 0, 0, 0, 0 };
    return rawSub(Q_LIMBS, a);
}

const R2 = [4]u64{
    0x1bb8e645ae216da7,
    0x53fe3ab1e35c59e3,
    0x8c49833d53bb8085,
    0x0216d0b17f4e44a5,
};
const MONT_N0: u64 = 0xc2e1f593efffffff;

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
        const w: u128 = @as(u128, a[i]) -% @as(u128, Q_LIMBS[i]) -% borrow;
        out[i] = @truncate(w);
        borrow = if (w > 0xffffffffffffffff) 1 else 0;
    }
    return out;
}

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

/// Normal-domain product mod Q. The 512-bit schoolbook product does not fit in four limbs.
pub fn rawMMul(a: [4]u64, b: [4]u64) [4]u64 {
    return fromMont(montMul(toMont(a), toMont(b)));
}

// Pure Zig: compare a and b (return negative, 0, or positive). High limb first.
pub fn rawCmp(a: [4]u64, b: [4]u64) i32 {
    return cmp4(a, b);
}

// Pure Zig: check if a is zero
pub fn rawIsZero(a: [4]u64) bool {
    return a[0] == 0 and a[1] == 0 and a[2] == 0 and a[3] == 0;
}

pub const Fr = struct {
    limbs: [4]u64 = .{ 0, 0, 0, 0 },

    pub fn zero() Fr {
        return .{};
    }

    pub fn one() Fr {
        return fromU64(1);
    }

    pub fn fromU64(n: u64) Fr {
        return .{ .limbs = [4]u64{ n, 0, 0, 0 } };
    }

    pub fn fromI64(n: i64) Fr {
        if (n >= 0) return fromU64(@intCast(n));
        return fromU64(@intCast(-n)).neg();
    }

    /// Little-endian normal-form limbs.
    pub fn fromNormal(limbs: [4]u64) Fr {
        return .{ .limbs = limbs };
    }

    /// Reduce 256-bit little-endian limbs modulo `Q`.
    pub fn fromNormalModQ(limbs: [4]u64) Fr {
        var src = limbs;
        reduceModQ(&src);
        return fromNormal(src);
    }

    /// Uniform-ish Fr: 256 random bits from Zig `std.Random`, then `mod q` via pure Zig.
    pub fn random(r: std.Random) Fr {
        var limbs: [4]u64 = undefined;
        r.bytes(std.mem.asBytes(&limbs));
        return fromNormalModQ(limbs);
    }

    pub fn limbsLtQ(limbs: [4]u64) bool {
        const a = limbs;
        const q = Q_LIMBS;
        return rawCmp(a, q) < 0;
    }

    pub fn toNormal(self: Fr) [4]u64 {
        return self.limbs;
    }

    pub fn add(self: Fr, other: Fr) Fr {
        const a = self.limbs;
        const b = other.limbs;
        var dst: [4]u64 = undefined;
        dst = rawAdd(a, b);
        return .{ .limbs = dst };
    }

    pub fn sub(self: Fr, other: Fr) Fr {
        const a = self.limbs;
        const b = other.limbs;
        var dst: [4]u64 = undefined;
        dst = rawSub(a, b);
        return .{ .limbs = dst };
    }

    pub fn neg(self: Fr) Fr {
        return .{ .limbs = rawNeg(self.limbs) };
    }

    pub fn mul(self: Fr, other: Fr) Fr {
        const a = self.limbs;
        const b = other.limbs;
        var dst: [4]u64 = undefined;
        dst = rawMMul(a, b);
        return .{ .limbs = dst };
    }

    pub fn square(self: Fr) Fr {
        return self.mul(self);
    }

    pub fn pow5(self: Fr) Fr {
        const s2 = self.square();
        return self.mul(s2.square());
    }

    pub fn inv(self: Fr) Fr {
        // a^{q-2}
        const exp = [4]u64{
            Q_LIMBS[0] - 2,
            Q_LIMBS[1],
            Q_LIMBS[2],
            Q_LIMBS[3],
        };
        var base = self;
        var r = Fr.one();
        var i: usize = 0;
        while (i < 256) : (i += 1) {
            const limb = i / 64;
            const bit = @as(u64, 1) << @intCast(i % 64);
            if ((exp[limb] & bit) != 0) {
                r = r.mul(base);
            }
            base = base.square();
        }
        return r;
    }

    pub fn div(self: Fr, other: Fr) Fr {
        return self.mul(other.inv());
    }

    pub fn eql(self: Fr, other: Fr) bool {
        const a = self.limbs;
        const b = other.limbs;
        return rawCmp(a, b) == 0;
    }

    pub fn isZero(self: Fr) bool {
        const a = self.limbs;
        return rawIsZero(a);
    }

    pub fn cmpNormal(self: Fr, other: Fr) i32 {
        const a = self.toNormal();
        const b = other.toNormal();
        return rawCmp(a, b);
    }

    pub fn fromBytesLe(bytes: [32]u8) Fr {
        var limbs: [4]u64 = undefined;
        inline for (0..4) |i| {
            limbs[i] = std.mem.readInt(u64, bytes[i * 8 ..][0..8], .little);
        }
        return fromNormal(limbs);
    }

    pub fn toBytesLe(self: Fr) [32]u8 {
        const limbs = self.toNormal();
        var bytes: [32]u8 = undefined;
        inline for (0..4) |i| {
            std.mem.writeInt(u64, bytes[i * 8 ..][0..8], limbs[i], .little);
        }
        return bytes;
    }

    pub fn toU64(self: Fr) u64 {
        return self.toNormal()[0];
    }

    /// Decimal string (normal form), circomlibjs F.toObject().
    pub fn toDec(self: Fr, buf: []u8) []const u8 {
        var limbs = self.toNormal();
        if (isZeroLimbs(limbs)) {
            buf[0] = '0';
            return buf[0..1];
        }
        var tmp: [80]u8 = undefined;
        var n: usize = 0;
        while (!isZeroLimbs(limbs)) {
            const rem = divmod10(&limbs);
            tmp[n] = '0' + rem;
            n += 1;
        }
        var i: usize = 0;
        while (i < n) : (i += 1) {
            buf[i] = tmp[n - 1 - i];
        }
        return buf[0..n];
    }

    pub fn fromDec(s: []const u8) Fr {
        var limbs = [4]u64{ 0, 0, 0, 0 };
        for (s) |ch| {
            if (ch < '0' or ch > '9') continue;
            mul10Add(&limbs, ch - '0');
        }
        reduceModQ(&limbs);
        return fromNormal(limbs);
    }

    pub fn fromHex(s: []const u8) Fr {
        var hex = s;
        if (hex.len >= 2 and hex[0] == '0' and (hex[1] == 'x' or hex[1] == 'X')) {
            hex = hex[2..];
        }
        var limbs = [4]u64{ 0, 0, 0, 0 };
        for (hex) |ch| {
            const v: u64 = switch (ch) {
                '0'...'9' => ch - '0',
                'a'...'f' => ch - 'a' + 10,
                'A'...'F' => ch - 'A' + 10,
                else => continue,
            };
            shl4(&limbs);
            limbs[0] |= v;
        }
        reduceModQ(&limbs);
        return fromNormal(limbs);
    }
};

fn isZeroLimbs(l: [4]u64) bool {
    return l[0] == 0 and l[1] == 0 and l[2] == 0 and l[3] == 0;
}

fn mul10Add(l: *[4]u64, digit: u8) void {
    var carry: u128 = digit;
    inline for (0..4) |i| {
        const prod = @as(u128, l[i]) * 10 + carry;
        l[i] = @truncate(prod);
        carry = prod >> 64;
    }
}

fn shl4(l: *[4]u64) void {
    var carry: u64 = 0;
    inline for (0..4) |i| {
        const next = l[i] >> 60;
        l[i] = (l[i] << 4) | carry;
        carry = next;
    }
}

fn divmod10(l: *[4]u64) u8 {
    var rem: u128 = 0;
    var i: usize = 4;
    while (i > 0) {
        i -= 1;
        const cur = (rem << 64) | l[i];
        l[i] = @intCast(cur / 10);
        rem = cur % 10;
    }
    return @intCast(rem);
}

fn subLimbs(a: [4]u64, b: [4]u64) [4]u64 {
    var out: [4]u64 = undefined;
    var borrow: u64 = 0;
    inline for (0..4) |i| {
        const cur = @as(u128, a[i]);
        const sub = @as(u128, b[i]) + borrow;
        if (cur >= sub) {
            out[i] = @intCast(cur - sub);
            borrow = 0;
        } else {
            out[i] = @intCast(cur + (@as(u128, 1) << 64) - sub);
            borrow = 1;
        }
    }
    return out;
}

fn reduceModQ(l: *[4]u64) void {
    // 2^256 < 6Q, so a 256-bit integer needs at most five subtractions.
    var n: u8 = 0;
    while (rawCmp(l.*, Q_LIMBS) >= 0) : (n += 1) {
        if (n == 6) break;
        var borrow: u64 = 0;
        inline for (0..4) |i| {
            const w: u128 = @as(u128, l[i]) -% @as(u128, Q_LIMBS[i]) -% borrow;
            l[i] = @truncate(w);
            borrow = if (w > 0xffffffffffffffff) 1 else 0;
        }
    }
}

test "field sub and inverse" {
    const three = Fr.fromU64(3);
    const seven = Fr.fromU64(7);
    try std.testing.expect(three.sub(seven).add(Fr.fromU64(4)).isZero());
    try std.testing.expect(seven.mul(seven.inv()).eql(Fr.one()));
}
