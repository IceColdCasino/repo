//! BabyJubjub matching circomlibjs `buildBabyjub`.
const Fr = @import("fr.zig").Fr;

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

pub fn mulLimbs(base: Point, scalar: [4]u64) Point {
    var res = Point.identity();
    var exp = base;
    var i: usize = 0;
    while (i < 256) : (i += 1) {
        const limb = i / 64;
        const bit = @as(u64, 1) << @intCast(i % 64);
        if (scalar[limb] & bit != 0) {
            res = add(res, exp);
        }
        exp = double(exp);
    }
    return res;
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
