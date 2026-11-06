//! BabyJubjub matching circomlibjs `buildBabyjub`.
const field = @import("fr.zig");
const Fr = field.Fr;
const Mont = field.Mont;

pub const Point = struct {
    x: Fr,
    y: Fr,

    pub fn identity() Point {
        return .{ .x = Fr.zero(), .y = Fr.one() };
    }

    pub fn eql(self: Point, other: Point) bool {
        return self.x.eql(other.x) and self.y.eql(other.y);
    }
};

pub fn curveA() Fr {
    return Fr.fromU64(168700);
}

pub fn curveD() Fr {
    return Fr.fromU64(168696);
}

/// circomlibjs `subOrder` = curve order >> 3.
pub const SUB_ORDER_DEC = "2736030358979909402780800718157159386076813972158567259200215660948447373041";

pub fn subOrder() Fr {
    return Fr.fromDec(SUB_ORDER_DEC);
}

pub fn generator() Point {
    return .{
        .x = Fr.fromDec("995203441582195749578291179787384436505546430278305826713579947235728471134"),
        .y = Fr.fromDec("5472060717959818805561601436314318772137091100104008585924551046643952123905"),
    };
}

pub fn base8() Point {
    return .{
        .x = Fr.fromDec("5299619240641551281634865583518297030282874472190772894086521144482721001553"),
        .y = Fr.fromDec("16950150798460657717958625567821834550301663161624707787222815936182638968203"),
    };
}

pub fn add(a: Point, b: Point) Point {
    const beta = a.x.mul(b.y);
    const gamma = a.y.mul(b.x);
    const delta = a.y.sub(curveA().mul(a.x)).mul(b.x.add(b.y));
    const tau = beta.mul(gamma);
    const dtau = curveD().mul(tau);
    return .{
        .x = beta.add(gamma).div(Fr.one().add(dtau)),
        .y = delta.add(curveA().mul(beta).sub(gamma)).div(Fr.one().sub(dtau)),
    };
}

pub fn double(p: Point) Point {
    return add(p, p);
}

pub fn mul(base: Point, scalar: Fr) Point {
    return mulLimbs(base, scalar.toNormal());
}

pub fn mulU64(base: Point, scalar: u64) Point {
    return mulLimbs(base, .{ scalar, 0, 0, 0 });
}

/// Projective twisted Edwards point (X:Y:Z) = (X/Z, Y/Z).
const Proj = struct {
    x: Mont,
    y: Mont,
    z: Mont,
};

fn projIdentity() Proj {
    return .{ .x = Mont.zero(), .y = Mont.one(), .z = Mont.one() };
}

fn projFromAffine(p: Point) Proj {
    return .{ .x = Mont.fromFr(p.x), .y = Mont.fromFr(p.y), .z = Mont.one() };
}

/// Complete twisted-Edwards addition, EFD add-2008-bbjlp. No inversion.
fn projAdd(p: Proj, q: Proj, a: Mont, d: Mont) Proj {
    const big_a = p.z.mul(q.z);
    const big_b = big_a.mul(big_a);
    const big_c = p.x.mul(q.x);
    const big_d = p.y.mul(q.y);
    const big_e = d.mul(big_c.mul(big_d));
    const big_f = big_b.sub(big_e);
    const big_g = big_b.add(big_e);
    const sum_p = p.x.add(p.y);
    const sum_q = q.x.add(q.y);
    return .{
        .x = big_a.mul(big_f).mul(sum_p.mul(sum_q).sub(big_c).sub(big_d)),
        .y = big_a.mul(big_g).mul(big_d.sub(a.mul(big_c))),
        .z = big_f.mul(big_g),
    };
}

fn projToAffine(p: Proj) Point {
    const inv_z = p.z.inv();
    return .{
        .x = p.x.mul(inv_z).toFr(),
        .y = p.y.mul(inv_z).toFr(),
    };
}

pub fn mulLimbs(base: Point, scalar: [4]u64) Point {
    const a = Mont.fromFr(curveA());
    const d = Mont.fromFr(curveD());
    var res = projIdentity();
    var exp = projFromAffine(base);
    var i: usize = 0;
    while (i < 256) : (i += 1) {
        const limb = i / 64;
        const bit = @as(u64, 1) << @intCast(i % 64);
        if ((scalar[limb] & bit) != 0) res = projAdd(res, exp, a, d);
        exp = projAdd(exp, exp, a, d);
    }
    return projToAffine(res);
}

pub fn mulBase8(scalar: Fr) Point {
    return mul(base8(), scalar);
}

pub fn mulBase8Limbs(scalar: [4]u64) Point {
    return mulLimbs(base8(), scalar);
}

pub fn aggregate(keys: []const Point) Point {
    var acc = Point.identity();
    for (keys) |k| acc = add(acc, k);
    return acc;
}

/// Four independent scalar muls of the same base (shuffle re-encrypt).
pub fn mul4(base: Point, scalars: [4]Fr) [4]Point {
    return .{
        mul(base, scalars[0]),
        mul(base, scalars[1]),
        mul(base, scalars[2]),
        mul(base, scalars[3]),
    };
}

pub fn add4(a: [4]Point, b: [4]Point) [4]Point {
    return .{ add(a[0], b[0]), add(a[1], b[1]), add(a[2], b[2]), add(a[3], b[3]) };
}

pub fn inCurve(p: Point) bool {
    const x2 = p.x.square();
    const y2 = p.y.square();
    const lhs = curveA().mul(x2).add(y2);
    const rhs = Fr.one().add(x2.mul(y2).mul(curveD()));
    return lhs.eql(rhs);
}

const std = @import("std");

test "projective scalar mul matches affine addition" {
    const g = base8();
    try std.testing.expect(mul(g, Fr.zero()).eql(Point.identity()));
    try std.testing.expect(mul(g, Fr.one()).eql(g));
    try std.testing.expect(mul(g, Fr.fromU64(2)).eql(add(g, g)));
    const three = add(add(g, g), g);
    try std.testing.expect(mul(g, Fr.fromU64(3)).eql(three));
    const s = Fr.fromDec("123456789012345678901234567890");
    const p = mul(g, s);
    try std.testing.expect(inCurve(p));
    try std.testing.expect(add(p, p).eql(mul(g, s.add(s))));
    try std.testing.expect(Mont.one().toFr().eql(Fr.one()));
}
