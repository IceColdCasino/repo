//! BN254 Fr via rapidsnark libfr (Montgomery, ARM64 asm).
const std = @import("std");

pub const N64 = 4;
pub const Q_LIMBS = [4]u64{
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
};

extern "c" fn Fr_rawCopy(dst: [*c]u64, src: [*c]u64) void;
extern "c" fn Fr_rawAdd(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawSub(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawNeg(dst: [*c]u64, a: [*c]u64) void;
extern "c" fn Fr_rawMMul(dst: [*c]u64, a: [*c]u64, b: [*c]u64) void;
extern "c" fn Fr_rawFromMontgomery(dst: [*c]u64, src: [*c]u64) void;
extern "c" fn zkcasino_Fr_rawToMontgomery(dst: [*c]u64, src: [*c]u64) void;
extern "c" fn Fr_rawIsEq(a: [*c]u64, b: [*c]u64) c_int;
extern "c" fn Fr_rawIsZero(a: [*c]u64) c_int;
extern "c" fn Fr_rawCmp(a: [*c]u64, b: [*c]u64) c_int;

fn toMontRaw(dst: [*c]u64, src: [*c]u64) void {
    zkcasino_Fr_rawToMontgomery(dst, src);
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
        var src = [4]u64{ n, 0, 0, 0 };
        var dst: [4]u64 = undefined;
        toMontRaw(&dst, &src);
        return .{ .limbs = dst };
    }

    pub fn fromI64(n: i64) Fr {
        if (n >= 0) return fromU64(@intCast(n));
        return fromU64(@intCast(-n)).neg();
    }

    /// Little-endian normal-form limbs → Montgomery. `limbs` must already be `< q`.
    pub fn fromNormal(limbs: [4]u64) Fr {
        var src = limbs;
        var dst: [4]u64 = undefined;
        toMontRaw(&dst, &src);
        return .{ .limbs = dst };
    }

    /// Reduce 256-bit little-endian limbs modulo `Q` with libfr `Fr_rawCmp`, then to Montgomery.
    pub fn fromNormalModQ(limbs: [4]u64) Fr {
        var src = limbs;
        reduceModQ(&src);
        return fromNormal(src);
    }

    /// Uniform-ish Fr: 256 random bits from Zig `std.Random`, then `mod q` via libfr.
    pub fn random(r: std.Random) Fr {
        var limbs: [4]u64 = undefined;
        r.bytes(std.mem.asBytes(&limbs));
        return fromNormalModQ(limbs);
    }

    pub fn limbsLtQ(limbs: [4]u64) bool {
        var a = limbs;
        var q = Q_LIMBS;
        return Fr_rawCmp(&a, &q) < 0;
    }

    pub fn toNormal(self: Fr) [4]u64 {
        var src = self.limbs;
        var dst: [4]u64 = undefined;
        Fr_rawFromMontgomery(&dst, &src);
        return dst;
    }

    pub fn add(self: Fr, other: Fr) Fr {
        var a = self.limbs;
        var b = other.limbs;
        var dst: [4]u64 = undefined;
        Fr_rawAdd(&dst, &a, &b);
        return .{ .limbs = dst };
    }

    pub fn sub(self: Fr, other: Fr) Fr {
        var a = self.limbs;
        var b = other.limbs;
        var dst: [4]u64 = undefined;
        Fr_rawSub(&dst, &a, &b);
        return .{ .limbs = dst };
    }

    pub fn neg(self: Fr) Fr {
        var a = self.limbs;
        var dst: [4]u64 = undefined;
        Fr_rawNeg(&dst, &a);
        return .{ .limbs = dst };
    }

    pub fn mul(self: Fr, other: Fr) Fr {
        var a = self.limbs;
        var b = other.limbs;
        var dst: [4]u64 = undefined;
        Fr_rawMMul(&dst, &a, &b);
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
            if (exp[limb] & bit != 0) {
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
        var a = self.limbs;
        var b = other.limbs;
        return Fr_rawIsEq(&a, &b) != 0;
    }

    pub fn isZero(self: Fr) bool {
        var a = self.limbs;
        return Fr_rawIsZero(&a) != 0;
    }

    pub fn cmpNormal(self: Fr, other: Fr) i32 {
        var a = self.toNormal();
        var b = other.toNormal();
        return Fr_rawCmp(&a, &b);
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
    var q = Q_LIMBS;
    while (Fr_rawCmp(l, &q) >= 0) {
        l.* = subLimbs(l.*, Q_LIMBS);
    }
}
